// Loads Kokoro-82M from this origin only (Law 1). The model's weights are
// served in parts (scripts/fetch-voice.mjs) and stitched here; every file
// is kept in the tab's Cache Storage after the first load, so the voice
// works offline and is fetched once. Nothing is ever sent anywhere.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

export interface VoiceManifest {
  repo: string;
  revision: string;
  model: string;
  sha256: string;
  parts: string[];
  narrator: string;
}

const CACHE_PREFIX = "dial-voice-";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function stitchModel(m: VoiceManifest, onProgress: (loaded: number) => void): Promise<Response> {
  const base = `/voice/models/${m.repo}/onnx/`;
  const buffers: ArrayBuffer[] = [];
  let loaded = 0;
  for (const part of m.parts) {
    const res = await fetch(base + part);
    if (!res.ok) throw new Error(`voice part ${part}: ${res.status}`);
    const buf = await res.arrayBuffer();
    loaded += buf.byteLength;
    onProgress(loaded);
    buffers.push(buf);
  }
  const blob = new Blob(buffers);
  const whole = await blob.arrayBuffer();
  if ((await sha256Hex(whole)) !== m.sha256) throw new Error("voice: the model did not match its pin");
  return new Response(blob, { headers: { "content-type": "application/octet-stream", "content-length": String(blob.size) } });
}

export async function loadVoice(onProgress: (loaded: number) => void): Promise<{ tts: KokoroTTS; manifest: VoiceManifest }> {
  const manifest = (await (await fetch("/voice/manifest.json")).json()) as VoiceManifest;
  const cache = await caches.open(CACHE_PREFIX + manifest.revision);

  // The runtime and the model come from /ort and /voice on this origin.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = "/voice/models/";
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = {
    async match(request: string | Request): Promise<Response | undefined> {
      const key = typeof request === "string" ? request : request.url;
      if (!key.startsWith("/voice/")) return undefined;
      const hit = await cache.match(key);
      if (hit) return hit;
      if (key.endsWith(manifest.model)) {
        const stitched = await stitchModel(manifest, onProgress);
        await cache.put(key, stitched.clone());
        return stitched;
      }
      return undefined;
    },
    async put(request: string | Request, response: Response): Promise<void> {
      const key = typeof request === "string" ? request : request.url;
      if (key.startsWith("/voice/")) await cache.put(key, response);
    },
  };
  const wasm = env.backends.onnx.wasm;
  if (wasm) wasm.wasmPaths = "/ort/";

  // kokoro-js looks for a voice in the "kokoro-voices" cache under its
  // Hugging Face address before it would fetch one; put ours there first,
  // so that fetch never happens.
  const voiceKey = `https://huggingface.co/${manifest.repo}/resolve/main/voices/${manifest.narrator}.bin`;
  const voices = await caches.open("kokoro-voices");
  if (!(await voices.match(voiceKey))) {
    const res = await fetch(`/voice/voices/${manifest.narrator}.bin`);
    if (!res.ok) throw new Error(`voice ${manifest.narrator}: ${res.status}`);
    await voices.put(voiceKey, res);
  }

  const tts = await KokoroTTS.from_pretrained(manifest.repo, { dtype: "q8", device: "wasm" });
  return { tts, manifest };
}
