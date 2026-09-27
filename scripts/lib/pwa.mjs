// The installable app's generated files: the app manifest's colours, the
// arch logomark as SVG and PNG icons, all made by scripts/build.mjs into
// dist/ and never committed (rule 8: no binaries in git).
//
// Colours come from design/tokens.css, the only file that may define one
// (scripts/lint-design.mjs). A web app manifest and a PNG cannot read a CSS
// custom property, so the build resolves the token to its value: a
// `token(--name)` placeholder in web/public/manifest.webmanifest (and in
// <meta name="theme-color">) is replaced by the night theme's value of
// --name in tokens.css's first :root block, following var() references
// down to a source hex. The manifest uses --color-bg (the walnut page), so
// the installed app's splash and title bar match the Night Programme.

import { deflateSync, crc32 } from "node:zlib";

/** The custom properties declared in tokens.css's first `:root {` block (the night theme). */
export function nightTokens(css) {
  const start = css.indexOf(":root {");
  if (start < 0) throw new Error("pwa: tokens.css has no :root block");
  const body = css.slice(start, css.indexOf("\n}", start));
  const out = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** A token's value as a hex colour, following var() chains. Throws unless it ends in a hex. */
export function resolveHex(tokens, name) {
  let v = tokens[name];
  for (let hops = 0; v && hops < 8; hops++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (!ref) break;
    v = tokens[ref[1]];
  }
  if (!v || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`pwa: ${name} does not resolve to a hex colour in tokens.css`);
  return v.toLowerCase();
}

const PLACEHOLDER = /token\((--[\w-]+)\)/g;

/** Replaces every `token(--name)` with its night value. Throws on an unknown token. */
export function stampTokens(text, tokens) {
  return text.replace(PLACEHOLDER, (_, name) => resolveHex(tokens, name));
}

/** The icon's palette: the logomark as the masthead draws it (web/src/style.css .arch-*), on the page's ground. */
export function iconColours(tokens) {
  return {
    ground: resolveHex(tokens, "--color-bg"),
    body: resolveHex(tokens, "--color-surface"),
    line: resolveHex(tokens, "--color-cream"),
    live: resolveHex(tokens, "--color-filament"),
  };
}

// The arch logomark, in its own 120 x 156 viewBox (web/index.html .arch).
const ARCH = "M8 148 V62 A52 52 0 0 1 112 62 V148 Q112 152 108 152 H12 Q8 152 8 148 Z";
const INNER = "M17 145 V63 A43 43 0 0 1 103 63 V145";

/** The logomark as a square SVG icon; `inset` is the share of the side kept clear (maskable icons need 0.1 or more). */
export function iconSvg(c, inset = 0.14) {
  const side = 156 / (1 - 2 * inset);
  const x0 = (side - 120) / 2;
  const y0 = (side - 156) / 2 + 2;
  const t = `translate(${x0.toFixed(2)} ${y0.toFixed(2)})`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side.toFixed(2)} ${side.toFixed(2)}">`,
    `<rect width="100%" height="100%" fill="${c.ground}"/>`,
    `<g transform="${t}">`,
    `<path d="${ARCH}" fill="${c.body}" stroke="${c.line}" stroke-width="6" stroke-linejoin="round"/>`,
    `<path d="${INNER}" fill="none" stroke="${c.line}" stroke-width="1.6" stroke-opacity="0.4"/>`,
    `<path d="M20 94 L100 94" stroke="${c.live}" stroke-width="4.5" stroke-linecap="round"/>`,
    `</g></svg>`,
  ].join("");
}

// ---- PNG: the same logomark, rasterised without a dependency -------------

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

/** Signed distance to the arch body's outline (negative inside): the union of a rectangle and the half disc on top of it. */
function archDistance(x, y) {
  const qx = Math.abs(x - 60) - 52;
  const qy = Math.abs(y - 107) - 45;
  const rect = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  const disc = Math.hypot(x - 60, y - 62) - 52;
  return Math.min(rect, disc);
}

/** Distance to the open inner arch (a half circle of radius 43 on two legs). */
function innerDistance(x, y) {
  const arc = y <= 63 ? Math.abs(Math.hypot(x - 60, y - 63) - 43) : Infinity;
  const leg = (lx) => Math.hypot(x - lx, Math.max(63 - y, y - 145, 0));
  return Math.min(arc, leg(17), leg(103));
}

/** Distance to the live line, a capsule from (20, 94) to (100, 94). */
function liveDistance(x, y) {
  return Math.hypot(x - Math.min(100, Math.max(20, x)), y - 94);
}

/** The icon as RGB pixels (4 x 4 supersampled), `size` square, with the same inset as iconSvg. */
export function iconPixels(c, size, inset = 0.14) {
  const side = 156 / (1 - 2 * inset);
  const x0 = (side - 120) / 2;
  const y0 = (side - 156) / 2 + 2;
  const [G, B, L, V] = [c.ground, c.body, c.line, c.live].map(rgb);
  const px = Buffer.alloc(size * size * 3);
  const S = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = ((i + (sx + 0.5) / S) / size) * side - x0;
          const y = ((j + (sy + 0.5) / S) / size) * side - y0;
          let col = G;
          const d = archDistance(x, y);
          if (d < 0) col = B;
          if (Math.abs(d) <= 3) col = L;
          if (d < -3 && innerDistance(x, y) <= 0.8) col = col.map((v, k) => v * 0.6 + L[k] * 0.4);
          if (liveDistance(x, y) <= 2.25) col = V;
          for (let k = 0; k < 3; k++) acc[k] += col[k];
        }
      }
      const o = (j * size + i) * 3;
      for (let k = 0; k < 3; k++) px[o + k] = Math.round(acc[k] / (S * S));
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A PNG (8-bit RGB) from `iconPixels`. */
export function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Every icon file the build writes under dist/icons/, by file name. The
 * manifest names the SVG and the 192 and 512 PNGs (browsers that install
 * from a manifest need raster sizes); the maskable one keeps the mark in the
 * safe zone; the 180 PNG is the iPhone and iPad Home Screen icon.
 */
export function iconFiles(tokens) {
  const c = iconColours(tokens);
  return {
    "dial.svg": Buffer.from(iconSvg(c)),
    "dial-192.png": encodePng(iconPixels(c, 192), 192),
    "dial-512.png": encodePng(iconPixels(c, 512), 512),
    "dial-maskable-512.png": encodePng(iconPixels(c, 512, 0.2), 512),
    "apple-touch-icon.png": encodePng(iconPixels(c, 180), 180),
  };
}
