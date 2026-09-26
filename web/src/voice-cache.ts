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

/** What a visit still has to download: nothing, only voices, or the model and runtime too. */
export type Need = "none" | "voices" | "all";

export interface SizedManifest {
  repo: string;
  model: string;
  parts: string[];
  /** Every staged file's size in bytes, by the path it is served at. */
  sizes: Record<string, number>;
}

/** What this device already holds, each checked against its pin. */
export interface Held {
  /** The stitched model. */
  model: boolean;
  /** The model's other files (tokenizer, config) held, by served path. */
  modelFiles: ReadonlySet<string>;
  /** The runtime's .wasm. */
  runtime: boolean;
  /** Voice ids held. */
  voices: ReadonlySet<string>;
}

/**
 * The bytes a visit downloads to render with `voices`: the model's parts if
 * the model is not held, each tokenizer or config file not held, the
 * runtime's files if the runtime is not held, and each voice not held. Only
 * the voices the work's cast uses are counted, because only they are fetched.
 */
export function neededBytes(m: SizedManifest, voices: Iterable<string>, held: Held): { bytes: number; need: Need; missingVoices: number } {
  const size = (p: string) => m.sizes[p] ?? 0;
  const modelDir = `/voice/models/${m.repo}/`;
  let base = 0;
  if (!held.model) for (const part of m.parts) base += size(`${modelDir}onnx/${part}`);
  for (const p of Object.keys(m.sizes)) {
    if (p.startsWith(modelDir) && !p.startsWith(`${modelDir}onnx/`) && !held.modelFiles.has(p)) base += size(p);
    if (p.startsWith("/ort/") && !held.runtime) base += size(p);
  }
  let voiceBytes = 0;
  let missingVoices = 0;
  for (const id of new Set(voices)) {
    if (held.voices.has(id)) continue;
    voiceBytes += size(`/voice/voices/${id}.bin`);
    missingVoices++;
  }
  const bytes = base + voiceBytes;
  return { bytes, need: bytes === 0 ? "none" : base === 0 ? "voices" : "all", missingVoices };
}
