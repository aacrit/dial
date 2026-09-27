#!/usr/bin/env node
// Stages Dial's prepared recordings into web/public/recordings/ so the page
// plays them from this origin only (Law 1), as scripts/fetch-voice.mjs does
// for the voice. Runs before every build and dev.
//
// - recordings.lock.json (committed) pins every file: each work's timing
//   index and Opus parts, by SHA-256 and size, at their release-asset URLs
//   on the public aacrit/dial repo. A work the lock marks
//   { "recording": false } has none, and plays made on the device.
// - Each pinned file is taken from the cache (.cache/recordings/<tag>/),
//   else from --from DIR (a local render: DIR/<slug>/<file>), else
//   downloaded from its URL; every byte is checked against its pin before it
//   is kept or staged. A pinned file that cannot be had fails the build.
// - web/public/recordings/manifest.json lists what is staged: per work, the
//   index's pin, the recording's total bytes (what Save for offline keeps),
//   the day it was made and where. The page reads it; the offline helper
//   compiles its pins into its offline key (scripts/build.mjs).
//
// None of this is tracked in git (rule 8): web/public/recordings/ and
// .cache/ are gitignored.
//
//   node scripts/fetch-recordings.mjs [--from D:/dial-recordings]

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexMatchesLock, lockProblems, recordedSlugs } from "./lib/recordings-lock.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_FILE = path.join(repoRoot, "recordings.lock.json");
export const RECORDINGS_OUT = path.join(repoRoot, "web", "public", "recordings");
const cacheRoot = path.join(repoRoot, ".cache", "recordings");

// The catalogue's slugs and the cast engine, read from the page's own source
// without running TypeScript: the lock must name every work.
export function catalogueSlugs() {
  const src = readFileSync(path.join(repoRoot, "web", "src", "catalogue.ts"), "utf8");
  return [...src.matchAll(/^\s+slug: "([a-z0-9-]+)",$/gm)].map((m) => m[1]);
}
export function castEngineVersion() {
  return /CAST_ENGINE_VERSION = "([^"]+)"/.exec(readFileSync(path.join(repoRoot, "web", "src", "engine", "cast-version.ts"), "utf8"))[1];
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function readLock(file = LOCK_FILE) {
  if (!existsSync(file)) throw new Error("fetch-recordings: recordings.lock.json is missing");
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A pinned file's bytes: from the cache, a local render, or its URL; always checked against the pin. */
async function obtain(lock, slug, pin, from, fetchImpl, cache) {
  const cached = path.join(cache, lock.tag, slug, pin.file);
  if (existsSync(cached)) {
    const buf = readFileSync(cached);
    if (buf.length === pin.bytes && sha256(buf) === pin.sha256) return buf;
  }
  let buf;
  if (from) {
    const local = path.join(from, slug, pin.file);
    if (!existsSync(local)) throw new Error(`fetch-recordings: ${slug}/${pin.file} is not in ${from}`);
    buf = readFileSync(local);
  } else {
    console.log(`fetch-recordings: downloading ${pin.asset}`);
    let res;
    try {
      // A stalled download fails the build after a minute instead of hanging it.
      res = await fetchImpl(pin.url, { signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new Error(`fetch-recordings: ${pin.url} could not be fetched (${err.message ?? err})`);
    }
    if (!res.ok) throw new Error(`fetch-recordings: ${pin.url} answered ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (buf.length !== pin.bytes || sha256(buf) !== pin.sha256) throw new Error(`fetch-recordings: ${slug}/${pin.file} does not match its pin (sha256 ${sha256(buf)}, ${buf.length} bytes)`);
  mkdirSync(path.dirname(cached), { recursive: true });
  if (from) copyFileSync(path.join(from, slug, pin.file), cached);
  else writeFileSync(cached, buf);
  return buf;
}

/**
 * Stages every pinned recording. Throws, leaving the last good staging in
 * place, when the lock is unsound or any pinned file is missing or differs.
 */
export async function stage({ from = null, lockFile = LOCK_FILE, out = RECORDINGS_OUT, cache = cacheRoot, fetchImpl = fetch, slugs = catalogueSlugs(), castVersion = castEngineVersion() } = {}) {
  const lock = readLock(lockFile);
  const problems = lockProblems(lock, slugs, castVersion);
  if (problems.length) throw new Error(`fetch-recordings: recordings.lock.json:\n  ${problems.join("\n  ")}`);

  // Everything is read and checked before anything on disk changes.
  const staged = {};
  for (const slug of recordedSlugs(lock)) {
    const w = lock.works[slug];
    const indexBuf = await obtain(lock, slug, w.index, from, fetchImpl, cache);
    const index = JSON.parse(indexBuf.toString("utf8"));
    const mismatch = indexMatchesLock(index, w);
    if (index.slug !== slug) mismatch.push(`the index is ${index.slug}'s`);
    if (index.engine?.cast !== castVersion) mismatch.push(`the index was cast with engine ${index.engine?.cast}`);
    if (mismatch.length) throw new Error(`fetch-recordings: ${slug}/index.json: ${mismatch.join("; ")}`);
    const parts = [];
    for (const p of w.parts) parts.push([p.file, await obtain(lock, slug, p, from, fetchImpl, cache)]);
    staged[slug] = { index, indexBuf, parts };
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const works = {};
  for (const [slug, s] of Object.entries(staged)) {
    mkdirSync(path.join(out, slug), { recursive: true });
    writeFileSync(path.join(out, slug, "index.json"), s.indexBuf);
    for (const [file, buf] of s.parts) writeFileSync(path.join(out, slug, file), buf);
    works[slug] = {
      index: lock.works[slug].index.sha256,
      bytes: s.parts.reduce((n, [, b]) => n + b.length, s.indexBuf.length),
      parts: s.parts.length,
      seconds: Math.round((s.index.samples / s.index.sampleRate) * 10) / 10,
      made: s.index.made,
      cast: s.index.engine.cast,
      model: s.index.engine.model,
      device: s.index.engine.device,
    };
  }
  const manifest = { format: 1, tag: lock.tag, works };
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const n = Object.keys(works).length;
  console.log(`fetch-recordings: staged ${n} prepared recording${n === 1 ? "" : "s"} (${Object.keys(works).join(", ") || "none"}) from ${lock.tag}`);
  return manifest;
}

/** The staged recordings' pins, for the offline helper's key: each work's index sha256. */
export function stagedRecordingPins(out = RECORDINGS_OUT) {
  const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  return Object.fromEntries(Object.entries(m.works).map(([slug, w]) => [slug, w.index]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const from = a.includes("--from") ? path.resolve(a[a.indexOf("--from") + 1]) : null;
  stage({ from }).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
