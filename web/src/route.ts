// Dial's two rooms on one page: the Repertory at / (the radio tuned, not
// playing) and the Broadcast at /play/<work> (the same radio on air). Pure,
// so the build (web/vite.config.ts) and the page share one rule.
//
// Each work's address is a real static page: the build writes
// dist/play/<slug>.html from the same entry as dist/index.html. Workers
// Static Assets serves it at /play/<slug> (its default html_handling drops
// the .html, as it does for /privacy), so a reload or a shared link opens
// the Broadcast directly; a path no file matches gets the not-found page.

import { esc } from "./escape";

export type Room = { room: "repertory" } | { room: "broadcast"; index: number };

/** The Broadcast's address for a work. */
export function playPath(slug: string): string {
  return `/play/${slug}`;
}

/** Which room a path opens: /play/<slug> of a known work is its Broadcast; anything else is the Repertory. */
export function parseRoute(pathname: string, works: readonly { slug: string }[]): Room {
  const m = /^\/play\/([a-z0-9-]+?)(?:\.html|\/)?$/.exec(pathname);
  if (m) {
    const index = works.findIndex((w) => w.slug === m[1]);
    if (index >= 0) return { room: "broadcast", index };
  }
  return { room: "repertory" };
}

/** The document title: "Crito · Dial" on a work's Broadcast, "Dial" on the Repertory. */
export function pageTitle(work?: { title: string }): string {
  return work ? `${work.title} · Dial` : "Dial";
}

/**
 * A work's Broadcast page, made from the built index.html: its own title,
 * a description that names the work, and the room it opens in. Every value
 * from the catalogue is escaped.
 */
export function playPageHtml(indexHtml: string, work: { slug: string; title: string; credit: string }): string {
  const title = /<title>[^<]*<\/title>/;
  const description = /<meta name="description" content="[^"]*" \/>/;
  const body = /<body class="faceplate-page">/;
  if (!title.test(indexHtml) || !description.test(indexHtml) || !body.test(indexHtml)) throw new Error("playPageHtml: index.html has no title, description or faceplate body to set");
  return indexHtml
    .replace(title, `<title>${esc(pageTitle(work))}</title>`)
    .replace(description, `<meta name="description" content="${esc(`${work.title}. ${work.credit} Performed as radio theatre on Dial, made on your device.`)}" />`)
    .replace(body, `<body class="faceplate-page" data-room="broadcast" data-work="${esc(work.slug)}">`);
}
