// Names and keys for the voice's Cache Storage, kept pure so tests can check
// them without loading the runtime. Each cache is keyed to a pin from the
// manifest: the model to its Kokoro revision, the runtime to its SHA-256.
// So a runtime-only bump never re-downloads the 92 MB model, and a new
// revision or runtime never reuses stale bytes.

export const VOICE_CACHE_PREFIX = "dial-voice-";
export const RUNTIME_CACHE_PREFIX = "dial-runtime-";

export interface VoicePins {
  revision: string;
  runtime: string;
  runtimeSha256: string;
}

/** The model, tokenizer and config: keyed on the Kokoro revision only. */
export function voiceCacheName(m: Pick<VoicePins, "revision">): string {
  return `${VOICE_CACHE_PREFIX}${m.revision}`;
}

/** The runtime's .wasm: its own cache, named for its pin. */
export function runtimeCacheName(m: Pick<VoicePins, "runtimeSha256">): string {
  return `${RUNTIME_CACHE_PREFIX}${m.runtimeSha256.slice(0, 16)}`;
}

/** The runtime's .wasm, keyed to its full SHA-256. */
export function runtimeCacheKey(m: Pick<VoicePins, "runtime" | "runtimeSha256">): string {
  return `/ort/${m.runtime}?sha256=${m.runtimeSha256}`;
}

/** Every Dial voice or runtime cache except the current two: deleted on load. */
export function staleVoiceCaches(names: string[], current: string[]): string[] {
  return names.filter((n) => (n.startsWith(VOICE_CACHE_PREFIX) || n.startsWith(RUNTIME_CACHE_PREFIX)) && !current.includes(n));
}
