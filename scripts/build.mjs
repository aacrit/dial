#!/usr/bin/env node
// Builds web/ to dist/ (matching wrangler.jsonc's assets.directory) and
// stamps the build with a tag: the current release/* tag if HEAD is exactly
// on one, else a short sha, else "dev". The tag lands in two places static
// assets can serve without the Worker needing to parse anything at request
// time: dist/build-tag.txt (read by the /healthz handler via env.ASSETS) and
// the <meta name="build"> placeholder in dist/*.html. It also injects the
// CSP meta into every page and writes dist/_headers (scripts/lib/csp.mjs).
// Then it makes the installable app's files (scripts/lib/pwa.mjs: the app
// manifest's token colours and the icons) and, last, the offline helper
// dist/sw.js (web/src/sw.ts), stamped with the tag, the shell's paths and
// the pins of the voice and the prepared recordings.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBin } from "./lib/run-bin.mjs";
import { cspViolations, headersFile, injectCsp } from "./lib/csp.mjs";
import { stage as stageVoice } from "./fetch-voice.mjs";
import { stage as stageRecordings, stagedRecordingPins } from "./fetch-recordings.mjs";
import { iconFiles, nightTokens, stampTokens } from "./lib/pwa.mjs";
import { shellPaths } from "./lib/shell.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(repoRoot, "web");
const distDir = path.join(repoRoot, "dist");

export function computeBuildTag(cwd = repoRoot, run = execFileSync) {
  const quiet = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
  try {
    return run("git", ["describe", "--tags", "--exact-match"], quiet).trim();
  } catch {
    // Not on an exact tag; fall through.
  }
  try {
    return run("git", ["rev-parse", "--short", "HEAD"], quiet).trim();
  } catch {
    return "dev";
  }
}

export function stampHtml(text, tag, tokens) {
  const stamped = text.replaceAll("__BUILD__", tag);
  return tokens ? stampTokens(stamped, tokens) : stamped;
}

/** The staged voice manifest's pins, compiled into the offline helper for its offline-compatibility key. */
export function readVoicePins() {
  const m = JSON.parse(readFileSync(path.join(webDir, "public", "voice", "manifest.json"), "utf8"));
  return { sha256: m.sha256, runtimeSha256: m.runtimeSha256, voices: m.voices };
}

/** Every file in dist/, relative and "/" separated. */
function distFiles() {
  return readdirSync(distDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(distDir, path.join(d.parentPath, d.name)).split(path.sep).join("/"));
}

/**
 * Builds web/src/sw.ts to dist/sw.js: one classic script at a fixed path
 * (a service worker's URL is its identity), with this build's tag and shell
 * list compiled in. A new build is a new script, so browsers install it.
 */
async function buildServiceWorker(tag, shell, pins, recordings) {
  const { build } = await import("vite");
  await build({
    configFile: false,
    root: webDir,
    logLevel: "warn",
    publicDir: false,
    define: { __BUILD_TAG__: JSON.stringify(tag), __SHELL__: JSON.stringify(shell), __VOICE_PINS__: JSON.stringify(pins), __RECORDING_PINS__: JSON.stringify(recordings) },
    build: {
      outDir: distDir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      lib: { entry: path.join(webDir, "src", "sw.ts"), formats: ["iife"], name: "dialOffline", fileName: () => "sw.js" },
    },
  });
}

async function main() {
  // The voice and the WASM runtime land in web/public/ first (Law 1: the
  // page loads them from this origin only).
  await stageVoice();
  // The prepared recordings too, each checked against recordings.lock.json;
  // a pinned recording that cannot be had fails the build.
  await stageRecordings();

  const result = runBin("vite", "vite", ["build"], { cwd: webDir });
  if (result.error || result.status !== 0) {
    console.error("build: vite build failed");
    process.exit(result.status ?? 1);
  }

  const tag = computeBuildTag();
  writeFileSync(path.join(distDir, "build-tag.txt"), `${tag}\n`);
  const tokens = nightTokens(readFileSync(path.join(repoRoot, "design", "tokens.css"), "utf8"));

  // Every page in dist/, at any depth, gets the one policy.
  const htmlFiles = readdirSync(distDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".html"));
  for (const file of htmlFiles) {
    const full = path.join(distDir, file);
    const stamped = injectCsp(stampHtml(readFileSync(full, "utf8"), tag, tokens));
    // The page must work under its own policy: fail the build rather than
    // ship markup the CSP would block.
    const violations = cspViolations(stamped);
    if (violations.length) {
      console.error(`build: dist/${file} breaks its Content-Security-Policy: ${violations.join(", ")}`);
      process.exit(1);
    }
    writeFileSync(full, stamped);
  }

  // Static assets skip the Worker (wrangler.jsonc's assets.run_worker_first
  // lists only the Worker's routes), so the headers a <meta> cannot carry
  // (frame-ancestors, X-Frame-Options, nosniff, Referrer-Policy) reach them
  // through Workers Static Assets' _headers file, which it reads and never
  // serves.
  writeFileSync(path.join(distDir, "_headers"), headersFile());

  // The installable app: the manifest's colours from tokens.css, and the icons.
  const manifestPath = path.join(distDir, "manifest.webmanifest");
  const manifest = stampTokens(readFileSync(manifestPath, "utf8"), tokens);
  JSON.parse(manifest);
  writeFileSync(manifestPath, manifest);
  mkdirSync(path.join(distDir, "icons"), { recursive: true });
  for (const [name, bytes] of Object.entries(iconFiles(tokens))) writeFileSync(path.join(distDir, "icons", name), bytes);

  // The offline helper, last, so its shell list is the finished build's.
  const shell = shellPaths(distFiles());
  await buildServiceWorker(tag, shell, readVoicePins(), stagedRecordingPins());
  // The shell's list, for the contract (every path must answer 200). Not part of the shell itself.
  writeFileSync(path.join(distDir, "offline-shell.json"), JSON.stringify(shell) + "\n");

  console.log(`build: stamped dist/ with build tag "${tag}"; offline shell of ${shell.length} files`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
