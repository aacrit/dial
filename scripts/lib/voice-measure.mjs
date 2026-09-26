// Pure measurements of rendered speech, for scripts/voice-bench.mjs and its
// tests. No I/O: every function takes mono Float32 samples in [-1, 1] and a
// sample rate, and returns numbers. The method, in one place:
//
// - Frames are 20 ms (FRAME_MS). A frame is SILENT when its RMS is more than
//   SILENCE_BELOW_PEAK_DB below the loudest frame of the same signal (a
//   relative floor, so a quiet voice and a loud one are cut alike), or below
//   the absolute floor ABS_FLOOR_DBFS.
// - Voiced span: the signal with its leading and trailing silent frames cut.
//   A short line's leading silence does not scale with its length, so the
//   bench never divides words by untrimmed audio (void news, ON-AIR-RADIO.md).
// - wpm: words / seconds, summed over cues each trimmed on its own; pauses
//   inside a cue (commas) count as speaking time, the tab's pause table does not.
// - Pause-to-speech ratio: inside the voiced span, the time in silent runs of
//   at least MIN_PAUSE_MS, over the rest.
// - F0: a normalized-autocorrelation pitch tracker on a 3x-decimated signal
//   (8 kHz at 24 kHz), 40 ms windows every 10 ms, 60 to 400 Hz. A window is
//   voiced when it is not silent and its best normalized peak is at least
//   VOICED_R. The pitch is the shortest-lag local maximum within 90 % of that
//   best peak (guards against octave-down picks), refined by parabolic
//   interpolation. The median over voiced windows is reported.
// - Spectral centroid: 1024-point Hann-windowed FFT every 512 samples; each
//   non-silent frame's magnitude-weighted mean frequency, averaged over frames.
// - Loudness: RMS in dBFS over the non-silent frames (an active-speech level,
//   not LUFS).

export const FRAME_MS = 20;
export const SILENCE_BELOW_PEAK_DB = 40;
export const ABS_FLOOR_DBFS = -60;
export const MIN_PAUSE_MS = 150;
export const F0_MIN_HZ = 60;
export const F0_MAX_HZ = 400;
export const VOICED_R = 0.5;

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** RMS of samples[from, to). */
export function rms(samples, from = 0, to = samples.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += samples[i] * samples[i];
  return to > from ? Math.sqrt(s / (to - from)) : 0;
}

/** Per-frame RMS in dBFS, FRAME_MS frames (the last partial frame dropped unless it is the only one). */
export function frameDb(samples, sampleRate, frameMs = FRAME_MS) {
  const n = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const frames = Math.max(1, Math.floor(samples.length / n));
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f++) out[f] = db(rms(samples, f * n, Math.min(samples.length, (f + 1) * n)));
  return { frameLen: n, db: out };
}

/** Which frames are silent, by the relative and absolute floors. */
export function silentFrames(samples, sampleRate, frameMs = FRAME_MS) {
  const { frameLen, db: d } = frameDb(samples, sampleRate, frameMs);
  let peak = -Infinity;
  for (const v of d) if (v > peak) peak = v;
  const floor = Math.max(peak - SILENCE_BELOW_PEAK_DB, ABS_FLOOR_DBFS);
  return { frameLen, silent: Array.from(d, (v) => v < floor) };
}

/** Sample range [start, end) of the voiced span: leading and trailing silent frames cut. Empty signal: start === end. */
export function trimSilence(samples, sampleRate) {
  const { frameLen, silent } = silentFrames(samples, sampleRate);
  const first = silent.indexOf(false);
  if (first < 0) return { start: 0, end: 0 };
  const last = silent.lastIndexOf(false);
  return { start: first * frameLen, end: Math.min(samples.length, (last + 1) * frameLen) };
}

/** Seconds of the voiced span. */
export function voicedSeconds(samples, sampleRate) {
  const { start, end } = trimSilence(samples, sampleRate);
  return (end - start) / sampleRate;
}

/** Words the way the bench counts them: whitespace and dashes separate, a token needs a letter or digit. */
export function countWords(text) {
  return text.split(/[\s—–]+|--/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** Words per minute over cues, each cue's audio trimmed on its own. */
export function naturalWpm(cues, sampleRate) {
  let words = 0;
  let seconds = 0;
  for (const c of cues) {
    words += c.words;
    seconds += voicedSeconds(c.audio, sampleRate);
  }
  return seconds > 0 ? (words / seconds) * 60 : 0;
}

/** Pause time over speech time inside the voiced span (pauses: silent runs of at least MIN_PAUSE_MS). */
export function pauseRatio(samples, sampleRate) {
  const { silent } = silentFrames(samples, sampleRate);
  const first = silent.indexOf(false);
  if (first < 0) return 0;
  const last = silent.lastIndexOf(false);
  const minRun = Math.ceil(MIN_PAUSE_MS / FRAME_MS);
  let pause = 0;
  let run = 0;
  for (let f = first; f <= last + 1; f++) {
    if (f <= last && silent[f]) run++;
    else {
      if (run >= minRun) pause += run;
      run = 0;
    }
  }
  const total = last - first + 1;
  return total - pause > 0 ? pause / (total - pause) : 0;
}

/** RMS level in dBFS over the non-silent frames. */
export function activeDbfs(samples, sampleRate) {
  const { frameLen, silent } = silentFrames(samples, sampleRate);
  let s = 0;
  let n = 0;
  for (let f = 0; f < silent.length; f++) {
    if (silent[f]) continue;
    for (let i = f * frameLen; i < Math.min(samples.length, (f + 1) * frameLen); i++) {
      s += samples[i] * samples[i];
      n++;
    }
  }
  return n ? db(Math.sqrt(s / n)) : -Infinity;
}

/** Averages each run of `factor` samples (a crude low-pass before decimation). */
export function decimate(samples, factor) {
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += samples[i * factor + k];
    out[i] = s / factor;
  }
  return out;
}

/** F0 of one window by normalized autocorrelation, or null when unvoiced. */
export function windowF0(x, sampleRate, fmin = F0_MIN_HZ, fmax = F0_MAX_HZ) {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = x[i] - mean;
  const minLag = Math.max(2, Math.floor(sampleRate / fmax));
  const maxLag = Math.min(n - 2, Math.ceil(sampleRate / fmin));
  if (maxLag <= minLag) return null;
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let num = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i + lag < n; i++) {
      num += y[i] * y[i + lag];
      e0 += y[i] * y[i];
      e1 += y[i + lag] * y[i + lag];
    }
    r[lag] = e0 > 0 && e1 > 0 ? num / Math.sqrt(e0 * e1) : 0;
  }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag] > best) best = r[lag];
  if (best < VOICED_R) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag] >= 0.9 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      const a = r[lag - 1];
      const b = r[lag];
      const c = r[lag + 1];
      const den = a - 2 * b + c;
      const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
      return sampleRate / (lag + shift);
    }
  }
  return null;
}

/** F0 track (Hz, voiced windows only) over a signal. */
export function f0Track(samples, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / 8000));
  const x = decimate(samples, factor);
  const sr = sampleRate / factor;
  const win = Math.round(0.04 * sr);
  const hop = Math.round(0.01 * sr);
  const { frameLen, silent } = silentFrames(samples, sampleRate);
  const track = [];
  for (let at = 0; at + win <= x.length; at += hop) {
    const mid = Math.floor(((at + win / 2) * factor) / frameLen);
    if (silent[Math.min(mid, silent.length - 1)]) continue;
    const f = windowF0(x.subarray(at, at + win), sr);
    if (f !== null) track.push(f);
  }
  return track;
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median F0 in Hz over voiced windows, or null. */
export function medianF0(samples, sampleRate) {
  return median(f0Track(samples, sampleRate));
}

/** In-place radix-2 FFT (re, im of power-of-two length). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Mean spectral centroid in Hz over non-silent 1024-sample frames, or null. */
export function spectralCentroid(samples, sampleRate, size = 1024) {
  const hop = size / 2;
  const { frameLen, silent } = silentFrames(samples, sampleRate);
  const hann = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let sum = 0;
  let frames = 0;
  for (let at = 0; at + size <= samples.length; at += hop) {
    const mid = Math.floor((at + size / 2) / frameLen);
    if (silent[Math.min(mid, silent.length - 1)]) continue;
    for (let i = 0; i < size; i++) {
      re[i] = samples[at + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let num = 0;
    let den = 0;
    for (let k = 1; k <= size / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      num += mag * ((k * sampleRate) / size);
      den += mag;
    }
    if (den > 0) {
      sum += num / den;
      frames++;
    }
  }
  return frames ? sum / frames : null;
}
