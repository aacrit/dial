#!/usr/bin/env node
// Publishes Dial's prepared recordings (the masters scripts/render-recordings.mjs
// made) as release assets on the public aacrit/dial repo, exactly as
// recordings.lock.json pins them, and writes the entries for dial-private's
// recordings/index.json. Run by the coordinator after review; never by the
// build, never in CI (no audio passes through git, rule 8).
//
//   node scripts/publish-recordings.mjs [--from D:/dial-recordings] [--dry-run]
//
// 1. Every file the lock pins is read from --from and checked against its
//    pin (bytes and SHA-256); one mismatch and nothing is uploaded.
// 2. The release recordings-<engine>-<date> (the lock's tag) is created on
//    aacrit/dial if it does not exist, as a prerelease with notes that say
//    what it holds; it is never marked latest.
// 3. Each file is uploaded under its asset name (<slug>.<file>) with
//    `gh release upload --clobber`.
// 4. Each uploaded asset is fetched back from its URL and checked against
//    its pin.
// 5. reports/recordings/dial-private-index-entries.json is written (the
//    `masters` entries in the schema dial-private's gate checks).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { castEngineVersion, catalogueSlugs, readLock } from "./fetch-recordings.mjs";
import { lockProblems, privateIndexEntries, recordedSlugs } from "./lib/recordings-lock.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function gh(args, opts = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

async function main() {
  const a = process.argv.slice(2);
  const from = path.resolve(a.includes("--from") ? a[a.indexOf("--from") + 1] : "D:/dial-recordings");
  const dryRun = a.includes("--dry-run");
  const lock = readLock();
  const problems = lockProblems(lock, catalogueSlugs(), castEngineVersion());
  if (problems.length) throw new Error(`publish-recordings: recordings.lock.json:\n  ${problems.join("\n  ")}`);

  // 1. Every pinned file, checked before anything is uploaded: the Opus set
  // (parts and the shared index) and the m4a set (T5b), each separately, so
  // a dry run reports both sets' totals without uploading anything.
  const files = [];
  const manifests = {};
  const totals = { opus: 0, m4a: 0 };
  for (const slug of recordedSlugs(lock)) {
    const w = lock.works[slug];
    manifests[slug] = JSON.parse(readFileSync(path.join(from, slug, "manifest.json"), "utf8"));
    const check = (pin, set) => {
      const local = path.join(from, slug, pin.file);
      const buf = readFileSync(local);
      if (buf.length !== pin.bytes || sha256(buf) !== pin.sha256) throw new Error(`publish-recordings: ${local} does not match its pin; render and lock again`);
      totals[set] += buf.length;
      files.push({ slug, pin, local });
    };
    for (const pin of [...w.parts, w.index]) check(pin, "opus");
    for (const pin of w.m4a.parts) check(pin, "m4a");
  }
  console.log(`publish-recordings: ${files.length} files match the lock for ${lock.tag}`);
  console.log(`publish-recordings: opus set ${(totals.opus / 1e6).toFixed(2)} MB, m4a set ${(totals.m4a / 1e6).toFixed(2)} MB (${(totals.m4a / totals.opus).toFixed(2)}x)`);

  // The index schema's own RECORDING_FORMAT, read from an actual staged index.json (recordings-lock.mjs privateIndexEntries).
  const recordingFormat = JSON.parse(readFileSync(path.join(from, recordedSlugs(lock)[0], "index.json"), "utf8")).format;
  const entries = privateIndexEntries(lock, manifests, recordingFormat);
  const outDir = path.join(repoRoot, "reports", "recordings");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "dial-private-index-entries.json"), JSON.stringify({ masters: entries }, null, 2) + "\n");
  console.log(`publish-recordings: wrote reports/recordings/dial-private-index-entries.json (${entries.length} entries)`);
  if (dryRun) return;

  // 2. The release, created once.
  if (!gh(["release", "view", lock.tag, "--repo", lock.repo]).ok) {
    const works = recordedSlugs(lock)
      .map((s) => `- ${s}: ${manifests[s].lines} lines, ${Math.round(manifests[s].audio_seconds / 60)} min, made ${manifests[s].made} on ${manifests[s].provider}`)
      .join("\n");
    const notes = `Dial's prepared recordings, cast engine ${lock.cast}. Kokoro-82M q8, the same pipeline as the in-tab render; Opus 48 kbps mono in WebM, in parts cut at line starts, with each work's timing index, plus the same masters transcoded to AAC-LC in .m4a (about 64 kbps) for a browser that cannot decode Opus in WebM (T5b). Pinned by SHA-256 in recordings.lock.json. The words are the translators', verbatim.\n\n${works}\n`;
    const notesFile = path.join(os.tmpdir(), `${lock.tag}-notes.md`);
    writeFileSync(notesFile, notes);
    const made = gh(["release", "create", lock.tag, "--repo", lock.repo, "--title", lock.tag, "--notes-file", notesFile, "--prerelease", "--latest=false"]);
    if (!made.ok) throw new Error(`publish-recordings: gh release create failed: ${made.err}`);
    console.log(`publish-recordings: created release ${lock.tag}`);
  }

  // 3. Upload, each under its asset name. gh names an asset after the file
  // on disk (a "#label" is only its display label), so each is uploaded from
  // a copy named for its asset.
  const staging = mkdtempSync(path.join(os.tmpdir(), `${lock.tag}-`));
  for (const f of files) {
    const copy = path.join(staging, f.pin.asset);
    copyFileSync(f.local, copy);
    const up = gh(["release", "upload", lock.tag, copy, "--repo", lock.repo, "--clobber"]);
    if (!up.ok) throw new Error(`publish-recordings: upload of ${f.pin.asset} failed: ${up.err}`);
  }

  // 4. Fetched back and checked.
  for (const f of files) {
    const res = await fetch(f.pin.url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok || buf.length !== f.pin.bytes || sha256(buf) !== f.pin.sha256) throw new Error(`publish-recordings: ${f.pin.url} does not serve its pinned bytes`);
  }
  console.log(`publish-recordings: all ${files.length} assets of ${lock.tag} serve their pinned bytes. Add the entries to dial-private/recordings/index.json and run its gate.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
