// Law 1: the book never leaves this tab. Every request the page or its
// render worker makes is to this origin, and to a path privacy-allowlist.json
// names. A fetch to anywhere else, or to an unlisted path, fails the gate.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CSP } from "../scripts/lib/csp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allow = JSON.parse(readFileSync(path.join(root, "privacy-allowlist.json"), "utf8")) as { sends: string[]; downloads: string[] };
const sources = (readdirSync(path.join(root, "web/src"), { recursive: true, encoding: "utf8" }) as string[])
  .filter((f) => f.endsWith(".ts"))
  .map((f) => [f.split(path.sep).join("/"), readFileSync(path.join(root, "web/src", f), "utf8")] as const);

describe("Law 1: no request leaves this origin", () => {
  it("the CSP allows connections to this origin only", () => {
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).not.toMatch(/connect-src[^;]*(https?:|\*)/);
  });

  it("every fetch() in web/src names an allowlisted same-origin path", () => {
    const allowed = [...allow.sends, ...allow.downloads];
    let seen = 0;
    for (const [file, src] of sources) {
      for (const m of src.matchAll(/\bfetch\(\s*([^,)]+)/g)) {
        seen++;
        const arg = m[1]!.trim();
        // A literal, a template literal, or a constant defined in the same file.
        const literal = /^["'`]([^"'`$]*)/.exec(arg)?.[1] ?? new RegExp(`const ${arg.split(/[\s+]/)[0]} = ["'\`]([^"'\`$]*)`).exec(src)?.[1];
        expect(literal, `${file}: fetch(${arg}) must start from a literal path`).toBeDefined();
        expect(literal!.startsWith("/") && !literal!.startsWith("//"), `${file}: fetch(${arg}) is not same-origin`).toBe(true);
        expect(allowed.some((p) => literal!.startsWith(p)), `${file}: fetch(${arg}) is not in privacy-allowlist.json`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("no other way out: no sendBeacon, WebSocket, EventSource or XMLHttpRequest, and no absolute URL fetched", () => {
    for (const [file, src] of sources) {
      expect(src, file).not.toMatch(/sendBeacon\(|new WebSocket|new EventSource|XMLHttpRequest|RTCPeerConnection/);
      expect(src, file).not.toMatch(/fetch\(\s*["'`]https?:/);
    }
  });

  it("the voice loader never fetches from Hugging Face: remote models are off and the voice is pre-seeded", () => {
    const voice = sources.find(([f]) => f === "voice.ts")![1];
    expect(voice).toContain("env.allowRemoteModels = false");
    expect(voice).toContain('wasm.wasmPaths = "/ort/"');
    expect(voice).toMatch(/voices\.put\(voiceKey/);
  });
});
