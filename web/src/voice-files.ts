// The voice's files as the page and the render worker both store them, kept
// apart from voice.ts so the page can save a work for offline (offline/store.ts)
// without loading the speech runtime. Every file comes from this origin
// (Law 1) and is checked against its pin before it is used or kept.

/** Where the model, its tokenizer and config are served and keyed. */
export const MODELS = "/voice/models/";

/** kokoro-js reads each voice from this cache, under its Hugging Face address, before it would fetch one. */
export const KOKORO_VOICES_CACHE = "kokoro-voices";

/** The key kokoro-js looks a voice up by. Never fetched: the file is put there from this origin first. */
export function hfVoiceKey(repo: string, id: string): string {
  return `https://huggingface.co/${repo}/resolve/main/voices/${id}.bin`;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads a response's body, counting bytes as they arrive, so a meter never runs ahead of the download. */
export async function readCounted(res: Response, count: (bytes: number) => void): Promise<ArrayBuffer> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    count(buf.byteLength);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    count(value.byteLength);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export interface StitchManifest {
  repo: string;
  parts: string[];
  sha256: string;
}

/** Fetches the model's parts from this origin, joins them and checks the whole against its pin. */
export async function stitchModel(m: StitchManifest, count: (bytes: number) => void, signal?: AbortSignal): Promise<Response> {
  const buffers: ArrayBuffer[] = [];
  for (const part of m.parts) {
    const res = await fetch(`/voice/models/${m.repo}/onnx/${part}`, { signal });
    if (!res.ok) throw new Error(`voice part ${part}: ${res.status}`);
    buffers.push(await readCounted(res, count));
  }
  const blob = new Blob(buffers);
  const whole = await blob.arrayBuffer();
  if ((await sha256Hex(whole)) !== m.sha256) throw new Error("voice: the model did not match its pin");
  return new Response(blob, { headers: { "content-type": "application/octet-stream", "content-length": String(blob.size) } });
}
