// Names and keys for the voice's Cache Storage, kept pure so tests can check
// them without loading the runtime. Every cached file is keyed to a pin from
// the manifest, so a new model revision or runtime never reuses stale bytes.

export const CACHE_PREFIX = "dial-voice-";

export interface VoicePins {
  revision: string;
  runtime: string;
  runtimeSha256: string;
}

/** The one current voice cache: named for the model revision and the runtime pin. */
export function voiceCacheName(m: VoicePins): string {
  return `${CACHE_PREFIX}${m.revision}-${m.runtimeSha256.slice(0, 16)}`;
}

/** The runtime's .wasm, keyed to its full SHA-256. */
export function runtimeCacheKey(m: VoicePins): string {
  return `/ort/${m.runtime}?sha256=${m.runtimeSha256}`;
}

/** Every Dial voice cache except the current one: deleted on load. */
export function staleVoiceCaches(names: string[], current: string): string[] {
  return names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current);
}
