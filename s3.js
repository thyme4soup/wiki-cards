(function () {
  const encoder = new TextEncoder();

  function awsEncode(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ));
  }

  function toHex(bytes) {
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function hmac(key, value) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
  }

  async function signingKey(secretKey, dateStamp, region) {
    const dateKey = await hmac(encoder.encode(`AWS4${secretKey}`), dateStamp);
    const regionKey = await hmac(dateKey, region);
    const serviceKey = await hmac(regionKey, "s3");
    return hmac(serviceKey, "aws4_request");
  }

  function canonicalQuery(parameters) {
    return [...parameters.entries()]
      .map(([key, value]) => [awsEncode(key), awsEncode(value)])
      .sort(([keyA, valueA], [keyB, valueB]) => (
        (keyA < keyB ? -1 : keyA > keyB ? 1 : 0)
        || (valueA < valueB ? -1 : valueA > valueB ? 1 : 0)
      ))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
  }

  function createObjectUrl(config, key) {
    const url = new URL(config.endpoint);
    const encodedKey = key.split("/").map(awsEncode).join("/");
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/${awsEncode(config.bucket)}/${encodedKey}`;
    return url;
  }

  async function presignGet(credentials, config, key, parameters = new URLSearchParams()) {
    const url = createObjectUrl(config, key);
    const isoDate = new Date().toISOString();
    const dateStamp = isoDate.slice(0, 10).replace(/-/g, "");
    const amzDate = `${dateStamp}T${isoDate.slice(11, 19).replace(/:/g, "")}Z`;
    const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

    parameters.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    parameters.set("X-Amz-Credential", `${credentials.accessKey}/${scope}`);
    parameters.set("X-Amz-Date", amzDate);
    parameters.set("X-Amz-Expires", "900");
    parameters.set("X-Amz-SignedHeaders", "host");
    if (credentials.sessionToken) parameters.set("X-Amz-Security-Token", credentials.sessionToken);

    const canonicalRequest = [
      "GET",
      url.pathname,
      canonicalQuery(parameters),
      `host:${url.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD"
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      toHex(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest)))
    ].join("\n");
    const signature = toHex(await hmac(
      await signingKey(credentials.secretKey, dateStamp, config.region),
      stringToSign
    ));
    parameters.set("X-Amz-Signature", signature);
    url.search = canonicalQuery(parameters);
    return url;
  }

  async function fetchSigned(credentials, config, key, parameters) {
    const url = await presignGet(credentials, config, key, parameters);
    const response = await fetch(url, {
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    });
    if (!response.ok) {
      let code = "";
      try {
        const document = new DOMParser().parseFromString(await response.text(), "application/xml");
        code = document.querySelector("Code")?.textContent || "";
      } catch {
        code = "";
      }
      const error = new Error(code ? `MinIO request failed: ${code}.` : `MinIO request failed (HTTP ${response.status}).`);
      error.status = response.status;
      error.code = code;
      throw error;
    }
    return response;
  }

  async function listObjects(credentials, config, prefix, continuationToken) {
    const parameters = new URLSearchParams({
      "list-type": "2",
      prefix
    });
    if (continuationToken) parameters.set("continuation-token", continuationToken);

    const response = await fetchSigned(credentials, config, "", parameters);
    const document = new DOMParser().parseFromString(await response.text(), "application/xml");
    if (document.querySelector("parsererror")) throw new Error("MinIO returned an invalid object listing.");

    return {
      keys: [...document.querySelectorAll("Contents > Key")].map((element) => element.textContent || ""),
      truncated: document.querySelector("IsTruncated")?.textContent === "true",
      nextToken: document.querySelector("NextContinuationToken")?.textContent || ""
    };
  }

  async function getJson(credentials, config, key) {
    const response = await fetchSigned(credentials, config, key);
    return response.json();
  }

  window.WikiCardsS3 = {
    createClient(credentials, config) {
      return {
        listObjects: (prefix, token) => listObjects(credentials, config, prefix, token),
        getJson: (key) => getJson(credentials, config, key),
        presignGet: (key) => presignGet(credentials, config, key)
      };
    }
  };
})();
