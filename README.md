# Wiki Cards

A small browser for the wiki card game. It reads the saved decks and animated card files directly from MinIO; it does not call the wiki-card API or require a manifest.

## Run locally

Serve this folder over HTTP (for example, `python -m http.server 8000`) and open `http://localhost:8000`.

## Deploy to GitHub Pages

Push the `main` branch to GitHub. The workflow in `.github/workflows/pages.yml` publishes the site. Enable GitHub Pages with **GitHub Actions** as the build and deployment source in the repository settings.

## Shared access link

The site reads a `cred` query parameter containing base64url-encoded JSON:

```json
{"accessKey":"READ_ONLY_ACCESS_KEY","secretKey":"READ_ONLY_SECRET_KEY"}
```

The share link has this shape:

```text
https://thyme4soup.github.io/wiki-cards/?cred=BASE64URL_ENCODED_JSON
```

Run `.\create-share-link.ps1` to enter a read-only key and generate a link. The site removes the parameter from the address bar after reading it and keeps the key in tab-scoped session storage, so refreshing the page in the same tab continues to work. Closing the tab clears the saved key; reopen the original share link to start a new session. If the site is deployed under a different GitHub Pages path, update the base URL in that script.

Base64 is encoding, not encryption. Anyone with the link can use its key, and the URL may be recorded in browser history or hosting logs before the page removes it. Make a separate MinIO service account with read-only access to `michaels-assets/wiki-cards/` for sharing; do not use an administrator or general-purpose key. Rotate or revoke the shared key if the link is forwarded or exposed.

## Storage layout

`config.js` points at the MinIO endpoint, bucket, and `wiki-cards/` prefix. The browser combines JSON files in `Decks/` and card metadata and animations in `Animations/`. It signs read requests in the browser and only signs animation URLs when cards approach the viewport.

Cross-origin reads from the deployed GitHub Pages site were verified against the current MinIO endpoint. The MinIO CLI does not report a stored bucket CORS rule, but the live browser was able to load the deck and card metadata.

Search uses card titles, descriptions, deck names, and available tags. The current card metadata also provides shiny, animation-level, and rarity filters.
Animation levels 1 and 2 are labeled Cornelius and Mab; rarities 0 through 3 are labeled Silver, Blue, Purple, and Red.
These renamed filters retain the original animation and rarity ordering, and selecting a tag keeps the current deck filter.
Click a card's title or its Wikipedia link to open its Wikipedia page in a new tab.
