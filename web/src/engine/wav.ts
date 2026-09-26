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

// ---- The download without a whole-work copy ---------------------------------
// A 20-minute work is about 29 million samples: a Float32 copy of the whole
// work plus its 16-bit copy is over 170 MB at the end of a render. Instead,
// each line is converted to 16-bit PCM as it arrives and kept as its own
// chunk (with its silence), and the WAV is a Blob of the 44-byte header and
// those chunks: the browser joins them without another copy in the page.

/** One sample as the WAV stores it: clamped, then scaled asymmetrically, as encodeWav does. */
function toInt16(samples: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** The 44-byte header of a 16-bit mono PCM WAV holding `dataBytes` of samples. */
export function wavHeader(dataBytes: number, sampleRate: number): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

/** Lines as 16-bit chunks, each followed by its silence; the Float32 input is not kept. */
export class WavChunks {
  readonly chunks: Int16Array<ArrayBuffer>[] = [];
  private bytes = 0;

  constructor(readonly sampleRate: number) {}

  add(audio: Float32Array, pauseAfterMs: number): void {
    const pcm = toInt16(audio);
    const silence = new Int16Array(Math.round((pauseAfterMs / 1000) * this.sampleRate));
    this.chunks.push(pcm, silence);
    this.bytes += (pcm.length + silence.length) * 2;
  }

  get dataBytes(): number {
    return this.bytes;
  }

  /** The WAV file's parts: the header, then every chunk in order. */
  parts(): BlobPart[] {
    return [wavHeader(this.bytes, this.sampleRate), ...this.chunks];
  }
}
