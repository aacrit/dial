// recordings.lock.json: the pins for Dial's prepared recordings. Hashes,
// sizes and URLs only; the audio itself is a release asset on the public
// aacrit/dial repo and never in git (rule 8). Pure checks here; the fetching
// is scripts/fetch-recordings.mjs and the writing scripts/render-recordings.mjs --lock.
//
// Shape:
//   { "repo": "aacrit/dial", "tag": "recordings-<cast engine>-<date>", "cast": "2",
//     "works": { "<slug>": { "index": File, "parts": [File, ...] } | { "recording": false } } }
//   File = { "file": "part0.webm", "asset": "cave.part0.webm", "url": "...", "sha256": "...", "bytes": n }

import { readFileSync } from "node:fs";
import path from "node:path";

export const RELEASE_REPO = "aacrit/dial";
const HEX64 = /^[0-9a-f]{64}$/;
const FILE = /^(index\.json|part\d+\.webm)$/;

export function releaseTag(castVersion, date) {
  return `recordings-${castVersion}-${date}`;
}

/** The release asset's name: unique across the release, so the slug leads. */
export function assetName(slug, file) {
  return `${slug}.${file}`;
}

export function assetUrl(repo, tag, slug, file) {
  return `https://github.com/${repo}/releases/download/${tag}/${assetName(slug, file)}`;
}

/** The lock for the masters in outDir (each <slug>/manifest.json), for the release the publish script makes. */
export function lockFrom(outDir, slugs, { castVersion, date, repo = RELEASE_REPO }) {
  const tag = releaseTag(castVersion, date);
  const works = {};
  for (const slug of slugs) {
    let m;
    try {
      m = JSON.parse(readFileSync(path.join(outDir, slug, "manifest.json"), "utf8"));
    } catch {
      works[slug] = { recording: false };
      continue;
    }
    if (m.engine.cast !== castVersion) throw new Error(`recordings-lock: ${slug} was cast with engine ${m.engine.cast}, not ${castVersion}`);
    const pin = (f) => ({ file: f.file, asset: assetName(slug, f.file), url: assetUrl(repo, tag, slug, f.file), sha256: f.sha256, bytes: f.bytes });
    works[slug] = { index: pin(m.index), parts: m.parts.map(pin) };
  }
  return {
    _comment: "Pins for Dial's prepared recordings (T5): hashes, sizes and URLs only, never audio. Written by scripts/render-recordings.mjs --lock; checked by scripts/fetch-recordings.mjs, which stages them into web/public/recordings/ before every build.",
    repo,
    tag,
    cast: castVersion,
    works,
  };
}

/** Every problem with a lock's shape, against the catalogue's slugs and this build's cast engine. Empty when sound. */
export function lockProblems(lock, slugs, castVersion) {
  const out = [];
  if (!lock || typeof lock !== "object") return ["the lock is not an object"];
  if (lock.repo !== RELEASE_REPO) out.push(`repo must be ${RELEASE_REPO}`);
  if (typeof lock.tag !== "string" || !/^recordings-[\w.]+-\d{4}-\d{2}-\d{2}$/.test(lock.tag)) out.push("tag must be recordings-<engine>-<YYYY-MM-DD>");
  const hasRecording = Object.values(lock.works ?? {}).some((w) => w && w.recording !== false);
  if (hasRecording && lock.cast !== castVersion) out.push(`the recordings were cast with engine ${lock.cast}, this build casts with ${castVersion}: make them again`);
  for (const slug of slugs) {
    const w = lock.works?.[slug];
    if (!w) {
      out.push(`${slug}: not in the lock (say { "recording": false } for a work without one)`);
      continue;
    }
    if (w.recording === false) continue;
    const files = [w.index, ...(Array.isArray(w.parts) ? w.parts : [])];
    if (!w.index || !Array.isArray(w.parts) || w.parts.length === 0) out.push(`${slug}: needs an index and at least one part`);
    for (const f of files.filter(Boolean)) {
      if (!FILE.test(f.file ?? "")) out.push(`${slug}: bad file name ${JSON.stringify(f.file)}`);
      if (!HEX64.test(f.sha256 ?? "")) out.push(`${slug}/${f.file}: sha256 must be 64 lowercase hex`);
      if (!(Number.isInteger(f.bytes) && f.bytes > 0)) out.push(`${slug}/${f.file}: bytes must be a positive integer`);
      if (f.bytes >= 20 * 1024 * 1024) out.push(`${slug}/${f.file}: over 20 MiB`);
      if (f.url !== assetUrl(lock.repo, lock.tag, slug, f.file)) out.push(`${slug}/${f.file}: url must be the release asset ${assetUrl(lock.repo, lock.tag, slug, f.file)}`);
      if (f.asset !== assetName(slug, f.file)) out.push(`${slug}/${f.file}: asset must be ${assetName(slug, f.file)}`);
    }
    w.parts?.forEach((p, i) => {
      if (p.file !== `part${i}.webm`) out.push(`${slug}: part ${i} must be part${i}.webm`);
    });
  }
  for (const slug of Object.keys(lock.works ?? {})) if (!slugs.includes(slug)) out.push(`${slug}: not a work in the catalogue`);
  return out;
}

/** The slugs the lock says have a recording. */
export function recordedSlugs(lock) {
  return Object.entries(lock.works).filter(([, w]) => w.recording !== false).map(([s]) => s);
}

/**
 * Checks a staged work's index.json against the lock: the index is the one
 * pinned, and it lists exactly the pinned parts, byte for byte. Returns the
 * problems (empty when it matches).
 */
export function indexMatchesLock(index, pins) {
  const out = [];
  if (index.parts.length !== pins.parts.length) out.push(`the index lists ${index.parts.length} parts, the lock ${pins.parts.length}`);
  index.parts.forEach((p, i) => {
    const pin = pins.parts[i];
    if (!pin || p.file !== pin.file || p.sha256 !== pin.sha256 || p.bytes !== pin.bytes) out.push(`part ${i} differs from the lock`);
  });
  return out;
}

/** The dial-private recordings/index.json entries for a lock's masters (its gate's schema). */
export function privateIndexEntries(lock, manifests) {
  const entries = [];
  for (const [slug, w] of Object.entries(lock.works)) {
    if (w.recording === false) continue;
    const m = manifests[slug];
    const voice = `Kokoro-82M q8 (${m.engine.model}), voices ${m.cast.voices.join(", ")}, made on ${m.provider === "cpu" ? "the CPU" : "the GPU (DirectML)"}`;
    for (const f of [...w.parts, w.index]) {
      entries.push({ work: slug, file: f.asset, sha256: f.sha256, bytes: f.bytes, engine: `cast engine ${m.engine.cast}, recording format 1`, voice, asset_url: f.url, rendered_at: m.made });
    }
  }
  return entries;
}
