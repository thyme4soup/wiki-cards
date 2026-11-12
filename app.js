const CONFIG = window.WIKI_CARDS_CONFIG;
const PAGE_SIZE = 24;
const DECKS_PREFIX = `${CONFIG.prefix}Decks/`;
const ANIMATIONS_PREFIX = `${CONFIG.prefix}Animations/`;
const CREDENTIALS_STORAGE_KEY = "wikiCardsCredentials";

const elements = {
  sourceStatus: document.querySelector("#sourceStatus"),
  searchInput: document.querySelector("#searchInput"),
  deckFilter: document.querySelector("#deckFilter"),
  tagFilters: document.querySelector("#tagFilters"),
  cardGrid: document.querySelector("#cardGrid"),
  resultCount: document.querySelector("#resultCount"),
  emptyState: document.querySelector("#emptyState"),
  emptyTitle: document.querySelector("#emptyTitle"),
  emptyCopy: document.querySelector("#emptyCopy"),
  loadMore: document.querySelector("#loadMore")
};

let cards = [];
let selectedTag = "";
let visibleCount = PAGE_SIZE;
let imageObserver = null;
let s3Client = null;

if ("IntersectionObserver" in window) {
  imageObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target;
      observer.unobserve(image);
      loadCardAnimation(image);
    }
  }, { rootMargin: "240px 0px" });
}

function setSourceStatus(message, state) {
  elements.sourceStatus.textContent = message;
  elements.sourceStatus.parentElement.dataset.state = state;
}

function setEmptyState(title, message) {
  elements.emptyTitle.textContent = title;
  elements.emptyCopy.textContent = message;
}

function clearCredentialFromAddressBar() {
  if (!window.location.search) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
}

function readCredentials() {
  const encoded = new URLSearchParams(window.location.search).get("cred");
  clearCredentialFromAddressBar();
  let savedCredentials;
  try {
    savedCredentials = encoded || sessionStorage.getItem(CREDENTIALS_STORAGE_KEY);
  } catch {
    throw new Error("The card access link could not be restored. Reopen the original share link.");
  }
  if (!savedCredentials) return null;
  if (savedCredentials.length > 8192) throw new Error("The card access link is invalid.");

  try {
    const base64 = savedCredentials.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const credentials = JSON.parse(new TextDecoder().decode(bytes));
    if (!credentials || typeof credentials !== "object"
      || typeof credentials.accessKey !== "string" || !credentials.accessKey
      || typeof credentials.secretKey !== "string" || !credentials.secretKey) {
      throw new Error("The card access link is missing a key.");
    }
    if (encoded) {
      try {
        sessionStorage.setItem(CREDENTIALS_STORAGE_KEY, encoded);
      } catch {
        throw new Error("The card access link could not be saved for refresh.");
      }
    }
    return {
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey,
      sessionToken: typeof credentials.sessionToken === "string" ? credentials.sessionToken : ""
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The card access link")) throw error;
    throw new Error("The card access link is invalid.");
  }
}

async function mapConcurrent(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function listAllObjects(prefix) {
  const keys = [];
  let continuationToken = "";
  do {
    const page = await s3Client.listObjects(prefix, continuationToken);
    keys.push(...page.keys);
    if (page.truncated && (!page.nextToken || page.nextToken === continuationToken)) {
      throw new Error("MinIO returned an invalid object listing.");
    }
    continuationToken = page.truncated ? page.nextToken : "";
  } while (continuationToken);
  return keys;
}

function decodeCardId(cardId) {
  try {
    const bytes = Uint8Array.from(atob(cardId), (character) => character.charCodeAt(0));
    const details = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof details.title !== "string" || !details.title) return null;
    const animation = Number(details.animation);
    if (!Number.isInteger(animation) || animation < 0) return null;
    return {
      title: details.title,
      animation,
      shiny: details.shiny === true || details.shiny === "true"
    };
  } catch {
    return null;
  }
}

function cardMetadataKey(title) {
  return `${ANIMATIONS_PREFIX}${title}/card.json`;
}

function cardAnimationKey(cardId) {
  const shiny = cardId.shiny ? "True" : "False";
  return `${ANIMATIONS_PREFIX}${cardId.title}/${cardId.animation}/shiny-${shiny}/animation.webp`;
}

function wikiPageUrl(title) {
  const path = title.split("/").map((part) => encodeURIComponent(part.replace(/ /g, "_"))).join("/");
  return `https://en.wikipedia.org/wiki/${path}`;
}

async function readDecks() {
  const keys = (await listAllObjects(DECKS_PREFIX))
    .filter((key) => key.startsWith(DECKS_PREFIX)
      && key.endsWith(".json")
      && key.slice(DECKS_PREFIX.length, -".json".length).toLocaleLowerCase() !== "script_kitty");
  const failures = [];
  const decks = await mapConcurrent(keys, 8, async (key) => {
    try {
      const data = await s3Client.getJson(key);
      const deckName = typeof data.ownerId === "string" && data.ownerId
        ? data.ownerId
        : key.slice(DECKS_PREFIX.length, -".json".length);
      if (!Array.isArray(data.cards)) return null;
      return {
        name: deckName,
        cards: data.cards.filter((cardId) => typeof cardId === "string")
      };
    } catch (error) {
      failures.push(error);
      return null;
    }
  });
  if (failures.length === keys.length && keys.length > 0) {
    throw new Error("No deck files could be read from MinIO.");
  }
  if (failures.length) console.error(`${failures.length} deck file(s) could not be read.`);
  return { decks: decks.filter(Boolean), failed: failures.length };
}

async function readCardMetadata(titles) {
  let unavailable = 0;
  const entries = await mapConcurrent(titles, 12, async (title) => {
    try {
      return [title, await s3Client.getJson(cardMetadataKey(title))];
    } catch (error) {
      unavailable += 1;
      if (error.status !== 404 && error.code !== "NoSuchKey") {
        console.error(`Card metadata could not be read (${error.code || "request failed"}).`);
      }
      return [title, null];
    }
  });
  return { metadata: new Map(entries), unavailable };
}

async function loadCards() {
  const { decks, failed: failedDecks } = await readDecks();
  const references = [];
  const seen = new Set();
  for (const deck of decks) {
    for (const cardId of deck.cards) {
      const cardDetails = decodeCardId(cardId);
      if (!cardDetails) continue;
      const identity = `${deck.name}\u0000${cardId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      references.push({ deck: deck.name, cardDetails });
    }
  }

  const titles = [...new Set(references.map((reference) => reference.cardDetails.title))];
  const { metadata, unavailable } = await readCardMetadata(titles);
  const loadedCards = references.map(({ deck, cardDetails }, index) => {
    const details = metadata.get(cardDetails.title) || {};
    const tags = Array.isArray(details.tags)
      ? details.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim())
      : [];
    if (cardDetails.shiny) tags.push("Shiny");
    if (cardDetails.animation > 0) tags.push(`Animation ${cardDetails.animation}`);
    if (Number.isInteger(details.rarity)) tags.push(`Rarity ${details.rarity}`);
    const title = typeof details.title === "string" && details.title
      ? details.title.replace(/_/g, " ")
      : cardDetails.title.replace(/_/g, " ");
    return {
      id: `${deck}-${index}-${cardDetails.title}`,
      title,
      description: typeof details.description === "string" ? details.description : "",
      deck,
      tags: [...new Set(tags)],
      animationKey: cardAnimationKey(cardDetails),
      pageUrl: wikiPageUrl(cardDetails.title)
    };
  });
  loadedCards.sort((a, b) => a.title.localeCompare(b.title) || a.deck.localeCompare(b.deck));
  return { cards: loadedCards, deckCount: decks.length, unavailable, failedDecks };
}

async function loadCardAnimation(image) {
  try {
    image.src = await s3Client.presignGet(image.dataset.key);
    image.removeAttribute("data-key");
  } catch {
    image.hidden = true;
    image.parentElement.querySelector(".media-fallback").hidden = false;
  }
}

function renderFilters() {
  const decks = [...new Set(cards.map((card) => card.deck))].sort((a, b) => a.localeCompare(b));
  elements.deckFilter.replaceChildren(new Option("All decks", ""));
  for (const deck of decks) elements.deckFilter.add(new Option(deck, deck));
  elements.deckFilter.disabled = decks.length === 0;

  const tags = [...new Set(cards.flatMap((card) => card.tags))].sort((a, b) => a.localeCompare(b));
  elements.tagFilters.replaceChildren();
  for (const tag of tags) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tag-filter";
    button.textContent = tag;
    button.setAttribute("aria-pressed", String(selectedTag === tag));
    button.addEventListener("click", () => {
      selectedTag = selectedTag === tag ? "" : tag;
      visibleCount = PAGE_SIZE;
      renderFilters();
      renderCards();
    });
    elements.tagFilters.append(button);
  }
  elements.tagFilters.hidden = tags.length === 0;
}

function getFilteredCards() {
  const search = elements.searchInput.value.trim().toLocaleLowerCase();
  const selectedDeck = elements.deckFilter.value;
  return cards.filter((card) => {
    const searchText = [card.title, card.description, card.deck, ...card.tags].join(" ").toLocaleLowerCase();
    return (!search || searchText.includes(search))
      && (!selectedDeck || card.deck === selectedDeck)
      && (!selectedTag || card.tags.includes(selectedTag));
  });
}

function createCardElement(card) {
  const article = document.createElement("article");
  article.className = "card";

  const media = document.createElement("div");
  media.className = "card-media";
  const image = document.createElement("img");
  image.alt = `Animated card: ${card.title}`;
  image.loading = "lazy";
  image.decoding = "async";
  image.dataset.key = card.animationKey;
  const mediaFallback = document.createElement("span");
  mediaFallback.className = "media-fallback";
  mediaFallback.textContent = "Animation unavailable";
  mediaFallback.hidden = true;
  media.append(image, mediaFallback);
  image.addEventListener("error", () => {
    image.hidden = true;
    mediaFallback.hidden = false;
  });
  if (imageObserver) imageObserver.observe(image);
  else loadCardAnimation(image);

  const body = document.createElement("div");
  body.className = "card-body";
  const deck = document.createElement("p");
  deck.className = "card-deck";
  deck.textContent = card.deck;
  const title = document.createElement("h3");
  title.className = "card-title";
  title.textContent = card.title;
  body.append(deck, title);

  if (card.description) {
    const description = document.createElement("p");
    description.className = "card-description";
    description.textContent = card.description;
    body.append(description);
  }

  if (card.tags.length) {
    const tags = document.createElement("ul");
    tags.className = "card-tags";
    tags.setAttribute("aria-label", "Tags");
    for (const label of card.tags) {
      const item = document.createElement("li");
      item.textContent = label;
      tags.append(item);
    }
    body.append(tags);
  }

  const link = document.createElement("a");
  link.className = "card-link";
  link.href = card.pageUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Wikipedia";
  body.append(link);

  article.append(media, body);
  return article;
}

function renderCards() {
  const filteredCards = getFilteredCards();
  const visibleCards = filteredCards.slice(0, visibleCount);
  for (const image of elements.cardGrid.querySelectorAll("img")) {
    if (imageObserver) imageObserver.unobserve(image);
  }
  elements.cardGrid.replaceChildren(...visibleCards.map(createCardElement));
  elements.resultCount.textContent = `${filteredCards.length} ${filteredCards.length === 1 ? "card" : "cards"}`;
  elements.loadMore.hidden = visibleCards.length >= filteredCards.length || filteredCards.length === 0;
  elements.emptyState.hidden = filteredCards.length > 0;
  if (cards.length && !filteredCards.length) setEmptyState("No cards found.", "Try another search or filter.");
}

async function start() {
  let credentials;
  try {
    credentials = readCredentials();
  } catch (error) {
    setSourceStatus("Invalid card link", "error");
    setEmptyState("Couldn't read card access.", error.message);
    elements.emptyState.hidden = false;
    return;
  }
  if (!credentials) {
    setSourceStatus("No card access", "error");
    setEmptyState("No card access.", "Open the link shared with you to browse the cards.");
    elements.emptyState.hidden = false;
    return;
  }

  setSourceStatus("Loading cards...", "loading");
  setEmptyState("Loading cards...", "Reading decks from MinIO.");
  elements.emptyState.hidden = false;
  s3Client = window.WikiCardsS3.createClient(credentials, CONFIG);
  credentials = null;

  try {
    const result = await loadCards();
    cards = result.cards;
    renderFilters();
    renderCards();
    const notes = [];
    if (result.failedDecks) notes.push(`${result.failedDecks} deck(s) unavailable`);
    if (result.unavailable) notes.push(`${result.unavailable} card details unavailable`);
    const note = notes.length ? ` (${notes.join(", ")})` : "";
    setSourceStatus(`Loaded ${result.deckCount} decks${note}`, "connected");
    if (!cards.length) {
      setEmptyState("No cards found.", "No animated cards were listed in the stored decks.");
      elements.emptyState.hidden = false;
    }
  } catch (error) {
    console.error("Could not load wiki cards from MinIO.", error);
    setSourceStatus("Couldn't load cards", "error");
    setEmptyState("Couldn't load cards.", "Check the shared key, bucket permissions, and MinIO CORS settings.");
    elements.emptyState.hidden = false;
  }
}

elements.searchInput.addEventListener("input", () => {
  visibleCount = PAGE_SIZE;
  renderCards();
});
elements.deckFilter.addEventListener("change", () => {
  visibleCount = PAGE_SIZE;
  renderCards();
});
elements.loadMore.addEventListener("click", () => {
  visibleCount += PAGE_SIZE;
  renderCards();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey
    && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    elements.searchInput.focus();
  }
});

start();
