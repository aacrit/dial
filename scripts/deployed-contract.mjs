#!/usr/bin/env node
// The contract of the release production actually serves. verify-production
// runs the served-page contract every six hours; main's contract.yaml
// describes main, which may have routes the live release does not (T8's
// /seal 404, T5's recordings), so checking production against it goes red
// on a healthy site and green on nothing. This asks production which build
// it serves (/healthz's `build`, the release tag the /release skill
// deployed), and writes that tag's contract.yaml for the runner:
//
//   node scripts/deployed-contract.mjs --url https://dial.voidvision.org --out <file>
//
// It needs the repository's tags (actions/checkout with fetch-depth: 0).
// The runner itself stays main's scripts/contract.mjs: main is always
// ahead of any release, so it knows every check type a release's contract
// uses. A build that is not a release tag is a failure in its own right:
// production is only ever deployed from one.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractFetch, describeFetchError } from "./contract.mjs";

/** A release tag as the /release skill cuts it: release/YYYY.MM.DD-N. */
export const RELEASE_TAG = /^release\/\d{4}\.\d{2}\.\d{2}-\d+$/;

/** The release tag in a /healthz body, or an error saying what production answered instead. */
export function deployedTag(body) {
  const build = body && typeof body === "object" ? body.build : undefined;
  if (typeof build !== "string" || !build) throw new Error(`production's /healthz names no build (${JSON.stringify(body)})`);
  if (!RELEASE_TAG.test(build)) throw new Error(`production serves build "${build}", which is not a release tag; production deploys only from release/* tags`);
  return build;
}

/** contract.yaml as it was at `tag`, read from git (the tag must be fetched). */
export function contractAt(tag, cwd = process.cwd()) {
  if (!RELEASE_TAG.test(tag)) throw new Error(`not a release tag: ${tag}`);
  try {
    return execFileSync("git", ["show", `refs/tags/${tag}:contract.yaml`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`the tag ${tag} or its contract.yaml is not in this checkout (fetch tags: actions/checkout with fetch-depth: 0)`);
  }
}

async function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const url = arg("--url");
  const out = arg("--out");
  if (!url || !out) {
    console.error("usage: node scripts/deployed-contract.mjs --url <production url> --out <file>");
    process.exit(2);
  }
  const healthz = new URL("/healthz", url);
  let body;
  try {
    const res = await contractFetch(healthz, { cache: "no-store" });
    if (!res.ok) throw new Error(`${healthz} answered ${res.status}`);
    body = await res.json();
  } catch (err) {
    console.error(`deployed-contract: could not read ${healthz}: ${describeFetchError(err)}`);
    process.exit(1);
  }
  const tag = deployedTag(body);
  writeFileSync(out, contractAt(tag));
  console.log(`deployed-contract: production serves ${tag}; wrote its contract.yaml to ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`deployed-contract: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
