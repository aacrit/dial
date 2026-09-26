// 16-bit PCM mono WAV, written in the tab. Spark's download format; Opus and
// M4A through WebCodecs, with the provenance metadata, come in F5.

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Joins rendered cues with each cue's silence after it (digital silence, never noise). */
export function assemble(chunks: { audio: Float32Array; pauseAfterMs: number }[], sampleRate: number): Float32Array {
  const pause = (ms: number) => Math.round((ms / 1000) * sampleRate);
  const total = chunks.reduce((n, c) => n + c.audio.length + pause(c.pauseAfterMs), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c.audio, at);
    at += c.audio.length + pause(c.pauseAfterMs);
  }
  return out;
}
