// Asks one question: does the offline helper answer this worker's requests?
// The render worker (narrate.worker.ts) fetches the voice manifest and the
// runtime's script; offline, only the helper can answer them. Browsers that
// do not route a page's workers through its service worker would render
// nothing offline, so there the page offers no "Save for offline"
// (offline/store.ts offlineWorks). The request is this site's own manifest.

import { OFFLINE_HEADER } from "./routes";

const ctx = self as unknown as { postMessage(message: boolean): void };

fetch("/voice/manifest.json")
  .then((res) => ctx.postMessage(res.headers.get(OFFLINE_HEADER) === "1"))
  .catch(() => ctx.postMessage(false));
