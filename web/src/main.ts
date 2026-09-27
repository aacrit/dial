// The radio at / and /play/<work>: full-screen panels (the device, then the
// work's widgets), moved between by the band selector (panels-ui.ts,
// design/spec.md 00). Counts go through telemetry.ts sendEvent, which posts
// nothing once the listener turns counts off in the Seal widget. This page's
// requests, and its voice worker's, are recorded for the Seal's log
// (request-recorder.ts): paths and sizes only, never text or audio.
import { WORKS, aboutMinutes, countWords, type Work } from "./catalogue";
import { addHeard, countsAsListen, firstOpen, heardStep, lampLit, wavName, type HeardSpans, type ListenKind } from "./broadcast-state";
import { capture, mountRadio } from "./device/radio";
import { detectPerfTier, type NavigatorLike } from "./device/perf-tier";
import { watchReducedMotion } from "./device/reduced-motion";
import { PRESETS, parseSpring } from "./device/spring";
import { mountWave } from "./device/wave";
import { isStatableTotal, warmingLine } from "./download-size";
import { tryCast, type Cast } from "./engine/cast";
import { segment, type Cue } from "./engine/segment";
import { WavChunks } from "./engine/wav";
import { focusKind, keyAction, SHORTCUTS } from "./player/keys";
import { registerOf } from "./player/levels";
import { mountSheet } from "./player/sheets";
import { Scheduler } from "./player/scheduler";
import { SCRUB_REST, estimateLine, lineStep, nearestLineStart, runningTime, scrubPress } from "./player/timeline";
import { bookplateHeading, bookplateHtml, eyebrowHtml, metaHtml, readAlongHtml, readLines, ribbonSvg, scriptHtml, shortcutsHtml } from "./render";
import { pageTitle, parseRoute, playPath } from "./route";
import {
  CAST_FAILED,
  PLAYS_AT_ONCE,
  RECORDING_UNPLAYABLE,
  makeItHere,
  STATIONS_SERVER,
  clock,
  firstLineLine,
  lineNotMadeYet,
  loadingNote,
  madeHere,
  notMadeYet,
  onAirLine,
  pausedLine,
  preparedDoneLine,
  preparedSkippedLine,
  preparedOnAirLine,
  preparedTuningLine,
  progressLine,
  recordingStopLine,
  renderedLine,
  resumeAtLine,
  scriptNote,
  stationsUnreached,
  stopLine,
  stripText,
  switchQuestion,
} from "./status-copy";
import type { FromWorker, ToWorker } from "./narrate.worker";
import { WORK_NOT_ON_DEVICE } from "./offline/plan";
import { registerOfflineHelper, type RecordingSave } from "./offline/store";
import { BUILT_RECORDINGS, choosePlaybackFormat, isDecodeError, openRecording, playableRecordings, type Recording } from "./recording/source";
import { RECORDING_RATE, partOfLine } from "./recording/timing";
import { mountOffline } from "./offline/ui";
import { noteSend, noteSendFailed, recordEntries, recordRequests } from "./request-recorder";
import { sendEvent } from "./telemetry";
import { centreWithin, inViewWithin, mountPanels } from "./panels-ui";
import { mountSealWidget } from "./seal-widget";

/**
 * Call this exactly where the product's core action completes (the export
 * is written, the order is placed, the task is finished). Its event is
 * contract.yaml's success_event, the one count the kill criteria in
 * CHARTER.md are written against. Never call it for page views or feedback.
 */
export function reportCoreSuccess(): void {
  sendEvent("chapter_rendered");
}

// ---- The radio: three stations, one of them on air at a time ---------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

interface Text {
  source: string;
  cues: Cue[];
  /** Who speaks each cue, and in which voice (engine/cast.ts); null when the work could not be cast. */
  cast: Cast | null;
}

/** Lines are scheduled on the audio clock this far ahead of the listener, and no further. */
const LOOKAHEAD_S = 4;
/** With the tab hidden or the phone locked, timers slow down: everything this far ahead goes on the audio clock at once. */
const HIDDEN_LOOKAHEAD_S = 120;

/** One broadcast: Dial's prepared recording played, or a work made on this device and played as it is made. */
interface Session {
  work: Work;
  /** Where its lines come from: Dial's prepared recording, or made on this device. */
  kind: ListenKind;
  /** chapter_rendered has been sent for this listen (broadcast-state.ts countsAsListen). */
  counted: boolean;
  /** Seconds of the work heard in this listen (played, never seeked over), and the place and clock they were last read at. */
  heard: number;
  /** Per line, the stretches heard (CoS decision C: each stretch of a line counts once). */
  spans: HeardSpans;
  /** Made here from this line on (the recording's earlier lines were seeded without audio); 0 when made whole or played from the recording. */
  madeFrom: number;
  lastPos: number;
  lastClock: number;
  /** The on-air line has been said: once, when the first line of this broadcast actually begins. */
  onAirSaid: boolean;
  /** Reads what was heard since the last reading, and counts the listen once it reaches 80%. */
  tally: () => void;
  /** A seek is moving playback: a seek past the end ends the broadcast, but is not a listen reaching its end. */
  seeking: boolean;
  cues: Cue[];
  audio: AudioContext;
  gain: GainNode;
  /** The one analyser on this broadcast's context: the wave, the meters and the eye read it, in this tab only. */
  analyser: AnalyserNode;
  /** The render worker; none for a prepared recording. */
  worker: Worker | null;
  frame: number;
  /** Schedules the next lines as the listener nears them. */
  feeder: number;
  live: boolean;
  renderDone: boolean;
  /** The voice has loaded: before that, the status shows the warming line. */
  ready: boolean;
  kept: boolean;
  made: number;
  seconds: number;
  line: number;
  /** The 16-bit lines so far; released once the file is made or the broadcast stops. */
  wav: WavChunks | null;
  /** The finished file: once every line is made, a seek reads its lines from here. */
  file: Blob | null;
  /** Where each made line's samples sit in the file. */
  offsets: number[];
  counts: number[];
  /** What is on the audio clock, where the listener is, seeking, and the end (player/scheduler.ts). */
  sched: Scheduler<AudioBufferSourceNode>;
  /** The strip's line lengths and running time: recomputed when a line is made, never per frame. */
  strip: { lengths: number[]; total: number; exact: boolean };
}

function setupRadio(): void {
  const device = document.querySelector<HTMLElement>("[data-device]");
  const tune = $<HTMLButtonElement>("tune-in");
  const pause = $<HTMLButtonElement>("pause");
  const avail = $("tune-avail");
  const makeHere = $<HTMLButtonElement>("make-here");
  const resumeLine = $<HTMLButtonElement>("resume-line");
  const status = $("broadcast-status");
  const progress = $("broadcast-progress");
  const meter = $<HTMLProgressElement>("render-meter");
  const download = $<HTMLAnchorElement>("download");
  const readAlong = $("readalong");
  const raLines = $("ra-lines");
  const raWho = $("ra-who");
  const note = $("devnote");
  const retry = $<HTMLButtonElement>("retry");
  const ask = $("switch-ask");
  const askQ = $("switch-q");
  const askYes = $<HTMLButtonElement>("switch-yes");
  const askNo = $<HTMLButtonElement>("switch-no");
  const valveLabel = $("valve-label");
  const eyebrow = $("st-eyebrow");
  const title = $("st-title");
  const credit = $("st-credit");
  const sentence = $("st-sentence");
  const meta = $("st-meta");
  const bookplate = $("bookplate");
  const workTitle = $("w-title");
  if (!device || !tune || !pause || !avail || !status || !progress || !meter || !download || !readAlong || !raLines || !raWho) return;
  if (!note || !retry || !ask || !askQ || !askYes || !askNo || !valveLabel || !makeHere || !resumeLine) return;
  if (!eyebrow || !title || !credit || !sentence || !meta || !bookplate || !workTitle) return;
  // The Broadcast's own parts: the strip, the transport keys, the sheets.
  const ribbonBox = $("ribbon-box");
  const ribbon = document.getElementById("ribbon") as SVGSVGElement | null;
  const timeEl = $("t-el");
  const timeTotal = $("t-total");
  const scrubNote = $("scrub-note");
  const linePrev = $<HTMLButtonElement>("line-prev");
  const lineNext = $<HTMLButtonElement>("line-next");
  const back10 = $<HTMLButtonElement>("back-10");
  const fwd10 = $<HTMLButtonElement>("fwd-10");
  const scriptBox = $("script");
  const scriptNoteEl = $("script-note");
  const bpNote = $("bookplate-note");
  const scriptPanel = $("tp-script");
  const shortcutList = $("shortcut-list");
  const canvas = device.querySelector<HTMLCanvasElement>("canvas.dw-wave");
  if (!ribbonBox || !ribbon || !timeEl || !timeTotal || !scrubNote || !linePrev || !lineNext || !back10 || !fwd10) return;
  if (!scriptBox || !scriptNoteEl || !scriptPanel || !bpNote || !shortcutList || !canvas) return;
  const ribbonSegs = ribbon.querySelector("g.segs")!;
  const ribbonNeedle = ribbon.querySelector("line.needle")!;
  const ribbonHead = ribbon.querySelector("line.renderhead")!;
  const transport = [linePrev, back10, fwd10, lineNext];

  const texts = new Map<string, Text>();
  const opened = new Set<string>();
  let mounted = false;
  let volume = 0.7;
  let voiceKept = true;
  let session: Session | null = null;
  let downloadUrl: string | null = null;
  /** Each work's opened prepared recording (this build's, compiled in, and only where this browser can play them). */
  const prepared = new Map<string, Recording>();
  /** The encoding Dial's prepared recordings are opened in: Opus where this browser claims to decode it, m4a otherwise (T5b); a part-0 Opus failure moves it to m4a for the rest of the visit. */
  let format = choosePlaybackFormat();
  /** Whether this browser plays Dial's recordings at all: false once made-on-device has taken over for good (a decode failure that was not solved by the m4a retry). */
  let recordingsPlayable = true;
  /** The Bookplate's facts about a work's prepared recording, where it plays. */
  const recordingFacts = (w: Work) => {
    const entry = prepared.has(w.slug) ? BUILT_RECORDINGS.works[w.slug] : undefined;
    return entry ? { made: entry.made, cast: entry.cast } : undefined;
  };
  const route = parseRoute(location.pathname, WORKS);
  let room: "repertory" | "broadcast" = route.room;

  // ---- focus: a control that is hidden or disabled never keeps it ----------
  /** Moves focus to Tune in when it sat on a control about to be hidden. */
  const rescueFocus = (...leaving: HTMLElement[]) => {
    if (!leaving.includes(document.activeElement as HTMLElement)) return;
    if (!tune.disabled) tune.focus();
    else device.querySelector<HTMLElement>("[data-dialwin]")?.focus();
  };

  // ---- the station card follows the needle ---------------------------------
  const showStation = () => {
    const w = WORKS[radio.tuned()]!;
    const text = texts.get(w.slug);
    eyebrow.innerHTML = eyebrowHtml(text ? aboutMinutes(text.source, text.cues) : undefined);
    title.textContent = w.title;
    workTitle.textContent = w.title;
    credit.textContent = w.credit;
    sentence.textContent = w.sentence;
    meta.innerHTML = metaHtml(w, text ? countWords(text.source) : undefined, text?.cast ?? undefined);
    bookplate.innerHTML = bookplateHtml(w, text?.cast ?? undefined, recordingFacts(w));
    bpNote.textContent = bookplateHeading(w);
    device.dataset.realm = w.slug;
    paintAvail();
    paintTuneIn();
    paintPreview();
    paintScript();
    offline?.station();
  };

  /** The line under Tune in: a station whose voices could not be cast says so, and only that station. */
  const paintAvail = () => {
    const w = WORKS[radio.tuned()]!;
    const text = texts.get(w.slug);
    const hasRecording = !!text?.cast && prepared.has(w.slug);
    // Offline, a work whose text is not on this device cannot play, and says so.
    if (!text && offline?.isOffline()) avail.textContent = WORK_NOT_ON_DEVICE;
    else avail.textContent = text && !text.cast ? CAST_FAILED : hasRecording ? PLAYS_AT_ONCE : madeHere(voiceKept);
    // Making it here stays a small secondary link, and only where the recording plays at once.
    const hideMake = !hasRecording || (!!session?.live && session.work === w && session.kind === "made");
    if (hideMake) rescueFocus(makeHere);
    makeHere.hidden = hideMake;
    makeHere.textContent = makeItHere(voiceKept);
  };

  // Nothing is made while Dial's prepared recording plays, so its lamp follows playback alone.
  const lampState = () => session && { live: session.live, playing: session.audio.state === "running", renderDone: session.renderDone || session.kind === "prepared" };

  /** Tune in on the work on air reads "On air" while it is live, "Paused" when paused with every line made. */
  const paintTuneIn = () => {
    const w = WORKS[radio.tuned()]!;
    const here = !!session?.live && session.work === w;
    const lit = here && lampLit(lampState());
    tune.classList.toggle("is-on-air", lit);
    tune.textContent = here ? (lit ? "On air" : "Paused") : "Tune in";
    // A station is playable once its text is read and its voices are cast.
    tune.disabled = here || !texts.get(w.slug)?.cast;
  };

  // ---- the lamp: tally means a render or playback is live ------------------
  const setLamp = () => {
    const lit = lampLit(lampState());
    if (lit) document.body.dataset.onAir = "true";
    else delete document.body.dataset.onAir;
    paintTuneIn();
  };

  /** The announced line: set only when the broadcast's state changes. */
  const announce = (line: string, error = false) => {
    if (error) status.dataset.state = "error";
    else status.removeAttribute("data-state");
    if (status.textContent !== line) status.textContent = line;
  };

  /** The visual per-line count, never announced. */
  const paintProgress = () => {
    const s = session;
    if (!s?.live || !s.ready) {
      progress.textContent = "";
      return;
    }
    progress.textContent = progressLine({
      title: s.work.title,
      heard: s.line + 1,
      made: s.made,
      total: s.cues.length,
      paused: s.audio.state === "suspended",
      renderDone: s.renderDone,
      prepared: s.kind === "prepared",
    });
  };

  const setValve = (share: number, label: string) => {
    radio.setValve(share);
    valveLabel.innerHTML = label;
  };

  // ---- where the listener is: work time, from the audio clock ---------------
  const positionOf = (s: Session) => s.sched.position();

  /** Every line's length for the strip (real once made, estimated before) and the running time: once per made line. */
  const measureStrip = (s: Session) => {
    const lengths = s.cues.map((c, i) => s.sched.lengths[i] ?? estimateLine(c));
    const { seconds, exact } = runningTime(s.cues, s.sched.lengths);
    s.strip = { lengths, total: seconds, exact };
  };

  /** The strip's segments: repainted when a line is made or the live line changes, never per frame. */
  const paintRibbon = () => {
    const s = session;
    if (!s?.live) return;
    const { lengths, total } = s.strip;
    ribbonSegs.innerHTML = ribbonSvg(lengths, total, s.made, s.line);
    // The strip is in the colour of the work on air, which may not be the one tuned.
    ribbonBox.dataset.realm = s.work.slug;
    ribbonBox.hidden = false;
    lastShown = -1;
    paintPlayhead();
  };

  /** The needle on the strip and the time under it: set only when the shown second changes. */
  let lastShown = -1;
  let dragAt: number | null = null;
  const paintPlayhead = () => {
    const s = session;
    if (!s?.live) return;
    const { total, exact } = s.strip;
    const pos = dragAt ?? positionOf(s);
    const x = total > 0 ? Math.min(1000, (pos / total) * 1000) : 0;
    ribbonNeedle.setAttribute("x1", x.toFixed(1));
    ribbonNeedle.setAttribute("x2", x.toFixed(1));
    // The render head: a tally line where making has reached, while it is still making.
    const head = total > 0 && !s.renderDone ? Math.min(1000, (s.sched.madeSeconds / total) * 1000) : -10;
    ribbonHead.setAttribute("x1", head.toFixed(1));
    ribbonHead.setAttribute("x2", head.toFixed(1));
    const shown = Math.floor(pos);
    if (shown === lastShown) return;
    lastShown = shown;
    timeEl.textContent = clock(pos);
    timeTotal.textContent = `${exact ? "" : "about "}${clock(total)}`;
    ribbon.setAttribute("aria-valuemax", String(Math.round(total)));
    ribbon.setAttribute("aria-valuenow", String(Math.round(pos)));
    ribbon.setAttribute("aria-valuetext", stripText(pos, total, exact, s.line + 1, s.cues.length, s.sched.madeSeconds, s.renderDone));
  };

  /** Previous and next line, back and forward 10 s: usable once a line is made. Focus leaves a key first. */
  const paintTransport = () => {
    const usable = !!session?.live && session.made > 0;
    if (!usable) rescueFocus(...transport);
    for (const k of transport) k.disabled = !usable;
  };

  // ---- the living wave and the meters ----------------------------------------
  const css = getComputedStyle(document.documentElement);
  const air = mountWave({
    canvas,
    voiceBar: $("m-voice"),
    voiceMeter: $("m-voice-meter"),
    voicePeak: $("m-peak"),
    bandLabel: $("m-band"),
    alignment: () => radio.alignment(),
    vu: parseSpring(css.getPropertyValue("--spring-vu"), PRESETS.vu),
    tier: detectPerfTier(navigator as NavigatorLike),
  });

  // The broadcast is over (finished or stopped): lamp off, keys back, and
  // everything it held is let go (its worker's handlers, its lines, its audio).
  const offAir = () => {
    const s = session;
    if (s) {
      s.live = false;
      // Nothing more goes on the clock, and a line still being read back is dropped.
      s.sched.dispose();
      cancelAnimationFrame(s.frame);
      clearInterval(s.feeder);
      if (s.worker) {
        s.worker.onmessage = null;
        s.worker.onerror = null;
        s.worker.terminate();
      }
      s.audio.onstatechange = null;
      void s.audio.close();
      s.wav = null;
      s.file = null;
    }
    air.analyser = null;
    air.playing = false;
    air.silent = false;
    air.redraw();
    radio.setReady(1);
    setLamp();
    clearMediaSession();
    readAlong.hidden = true;
    progress.textContent = "";
    paintTuneIn();
    // The question about stopping this broadcast no longer applies.
    hideAsk();
    rescueFocus(pause);
    pause.hidden = true;
    pause.textContent = "Pause";
    setValve(0, "Voice");
    rescueFocus(ribbon as unknown as HTMLElement);
    ribbonBox.hidden = true;
    scrubNote.textContent = "";
    paintTransport();
    paintPreview();
    paintScript();
  };

  pause.addEventListener("click", () => {
    const s = session;
    if (!s?.live) return;
    const settle = () => {
      setLamp(); // repaints Tune in too: "Paused" once nothing is live
      setPlaybackState(s.audio.state === "running" ? "playing" : "paused");
      updatePosition(s);
      paintProgress();
      if (s.audio.state === "suspended") {
        announce(pausedLine(s.work.title, positionOf(s), s.kind === "made" && !s.renderDone));
      } else if (s.kind === "prepared") announce(preparedOnAirLine(s.work.translator));
      else announce(s.renderDone ? renderedLine(s.work.title, s.cues.length, s.seconds, s.kept, s.madeFrom) : onAirLine(s.work.title, s.kept));
    };
    if (s.audio.state === "running") {
      pause.textContent = "Resume";
      void s.audio.suspend().then(settle);
    } else {
      pause.textContent = "Pause";
      void s.audio.resume().then(settle);
    }
  });

  // ---- the two rooms: the Repertory at /, the Broadcast at /play/<work> -----
  /** Sets the room, and the address and title with it; audio is never interrupted (no reload). */
  const setRoom = (next: "repertory" | "broadcast", how: "push" | "replace" | "none") => {
    room = next;
    document.body.dataset.room = next;
    const w = WORKS[radio.tuned()]!;
    const path = next === "broadcast" ? playPath(w.slug) : "/";
    if (how !== "none" && location.pathname !== path) history[how === "push" ? "pushState" : "replaceState"](null, "", path);
    document.title = pageTitle(next === "broadcast" ? w : undefined);
    // Both rooms are the radio: the top bar's Radio link stays the current page.
    paintPreview();
    // A control the new room does not show never keeps focus.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && typeof active.checkVisibility === "function" && !active.checkVisibility()) rescueFocus(active);
  };

  /** Before Tune in, the read-along shows where the tuned work begins (design/spec.md 00: the read-along is on the radio's panel). */
  const paintPreview = () => {
    if (session?.live && session.line >= 0) return;
    const w = WORKS[radio.tuned()]!;
    const text = texts.get(w.slug);
    if (!text) {
      if (!session?.live) readAlong.hidden = true;
      return;
    }
    raWho.textContent = w.title;
    raLines.innerHTML = readAlongHtml(readLines(text.cues), -1);
    readAlong.hidden = false;
  };

  const radio = mountRadio(device, WORKS, {
    // Tuning only moves the needle and the card; nothing is counted until Tune in.
    onTune: () => {
      if (!mounted) return;
      showStation();
      hideAsk();
      // On the Broadcast the Tune knob changes station, and the address follows it.
      if (room === "broadcast") setRoom("broadcast", "replace");
      air.redraw();
    },
    onVolume: (v) => {
      volume = v;
      if (session?.live) session.gain.gain.value = v;
    },
    start: route.room === "broadcast" ? route.index : 0,
  });
  mounted = true;
  setRoom(room, "none");

  // Save for offline and the install cards follow the tuned station.
  const offline: ReturnType<typeof mountOffline> | null = mountOffline({
    tuned: () => WORKS[radio.tuned()]!,
    textOf: (slug) => {
      const t = texts.get(slug);
      if (!t?.cast) return undefined;
      const rec = prepared.get(slug);
      const recording: RecordingSave | undefined = rec ? { slug, index: rec.index, indexBytes: rec.indexFile.bytes, indexSha256: rec.indexFile.sha256, format: rec.format } : undefined;
      return { source: t.source, voices: t.cast.voices, recording };
    },
  });

  // ---- asking before a broadcast still being made is stopped ---------------
  let pending: { work: Work; kind: ListenKind } | null = null;
  const hideAsk = () => {
    if (ask.hidden) return;
    pending = null;
    rescueFocus(askYes, askNo);
    ask.hidden = true;
  };
  askNo.addEventListener("click", hideAsk);
  askYes.addEventListener("click", () => {
    const next = pending;
    hideAsk();
    if (next) start(next.work, next.kind);
  });

  /** Tune in (Dial's recording where the work has one) or Make it on this device. */
  const tuneIn = (kind: ListenKind) => {
    const work = WORKS[radio.tuned()]!;
    if (!texts.get(work.slug)?.cast) return;
    const s = session;
    // Only a broadcast still being made loses anything by switching.
    if (s?.live && s.work !== work && s.kind === "made" && !s.renderDone) {
      pending = { work, kind };
      askQ.textContent = switchQuestion(s.work.called, work.called);
      ask.hidden = false;
      askNo.focus();
      return;
    }
    start(work, kind);
  };
  tune.addEventListener("click", () => tuneIn(prepared.has(WORKS[radio.tuned()]!.slug) ? "prepared" : "made"));
  makeHere.addEventListener("click", () => tuneIn("made"));

  // ---- Tune in: play the work, from Dial's prepared recording where it has
  // one ("prepared"), or made on this device and played as it is made
  // ("made"). Both feed the one scheduler: each line's 16-bit samples at
  // 24 kHz, then its silence from the pause table.
  /**
   * fromLine: start at this line. For Dial's recording, a seek there (Resume at
   * line N). For a work made here, the lines before it are the recording's
   * (their lengths, no samples) and only the rest is made: the recording
   * could not be decoded in this browser. heard and counted carry a listen
   * on across such a restart; reason is said first.
   */
  const start = (work: Work, kind: ListenKind, opts: { fromLine?: number; lengths?: { speech: number; pause: number }[]; heard?: number; spans?: HeardSpans; counted?: boolean; reason?: string } = {}) => {
    const text = texts.get(work.slug)!;
    const cast = text.cast;
    if (!cast) return;
    const rec = kind === "prepared" ? (prepared.get(work.slug) ?? null) : null;
    if (kind === "prepared" && !rec) return;
    // work_opened counts Tune in on a work, once per work per page load (founder, 2026-09-26).
    if (firstOpen(opened, work.slug)) sendEvent("work_opened");
    if (session?.live) offAir();
    // The previous finished file stays downloadable until this one is made.
    rescueFocus(resumeLine);
    resumeLine.hidden = true;
    // Made here from a later line (the recording could not be decoded): the lines before it are the recording's.
    const seeded = !rec && opts.fromLine && opts.lengths ? opts.lengths.slice(0, opts.fromLine) : [];
    const lead = opts.reason ? `${opts.reason} ` : "";

    const audio = new AudioContext();
    const gain = audio.createGain();
    gain.gain.value = volume;
    // One analyser on this broadcast's own context feeds the wave, the meters
    // and the eye. It sits before the Volume knob's gain, so the meter reads
    // the voice itself, not the volume. It reads the samples in this tab; nothing is sent.
    const analyser = audio.createAnalyser();
    analyser.fftSize = 2048;
    analyser.connect(gain);
    gain.connect(audio.destination);
    const worker = rec ? null : new Worker(new URL("./narrate.worker.ts", import.meta.url), { type: "module" });
    const cues = text.cues;
    let sampleRate = rec ? RECORDING_RATE : 24_000;

    /**
     * A line's samples: from Dial's prepared recording (fetched and decoded as
     * playback nears it), or a made line from the lines kept so far, or, once
     * the file is made, read back from it.
     */
    const linePcm = (i: number): Int16Array | Promise<Int16Array> => {
      if (rec) {
        // This browser cannot decode it: an Opus failure on the very first part retries once as m4a (CoS decision H); any other failure carries the listen on, made on this device from the line on air.
        const onDecodeFail = (err: unknown): Int16Array | Promise<Int16Array> => {
          if (isDecodeError(err)) {
            if (rec.nextOnFailure(partOfLine(rec.index, i)) === "retry-m4a") {
              rec.retryAsM4a();
              format = "m4a";
              return rec.samples(i).catch(onDecodeFail);
            }
            makeHereInstead();
          }
          // A part that did not arrive, even on a second try: stop, and offer to carry on from the line on air.
          else stopped(recordingStopLine(err instanceof Error ? `${err.name}: ${err.message}` : String(err)), Math.max(0, own.line));
          return new Int16Array(0);
        };
        return rec.samples(i).catch(onDecodeFail);
      }
      if (own.wav) return own.wav.chunks[2 * i] ?? new Int16Array(0);
      if (!own.file) return new Int16Array(0);
      const from = 44 + own.offsets[i]! * 2;
      return own.file
        .slice(from, from + own.counts[i]! * 2)
        .arrayBuffer()
        .then((b) => new Int16Array(b));
    };

    const sched = new Scheduler<AudioBufferSourceNode>(
      cues.length,
      {
        now: () => audio.currentTime,
        samples: linePcm,
        // A line's 16-bit samples become one source on the audio clock, through the analyser.
        start: (_i, pcm, at, offset, done) => {
          const buffer = audio.createBuffer(1, pcm.length, sampleRate);
          const samples = buffer.getChannelData(0);
          for (let k = 0; k < pcm.length; k++) samples[k] = pcm[k]! / 32768;
          const node = audio.createBufferSource();
          node.buffer = buffer;
          node.connect(analyser);
          node.onended = done;
          node.start(at, offset);
          return node;
        },
        stop: (node) => {
          node.onended = null;
          node.stop();
        },
        // Playback ended: the last line finished after every line was made (or a seek went past the end).
        complete: () => ended(),
      },
      document.hidden ? HIDDEN_LOOKAHEAD_S : LOOKAHEAD_S,
    );

    const own: Session = {
      work,
      kind: rec ? "prepared" : "made",
      counted: opts.counted ?? false,
      heard: opts.heard ?? 0,
      spans: opts.spans ?? new Map(),
      madeFrom: seeded.length,
      lastPos: 0,
      lastClock: audio.currentTime,
      onAirSaid: false,
      tally: () => undefined,
      seeking: false,
      cues,
      audio,
      gain,
      analyser,
      worker,
      frame: 0,
      feeder: 0,
      live: true,
      renderDone: false,
      ready: false,
      kept: true,
      made: 0,
      seconds: 0,
      line: -1,
      wav: null,
      file: null,
      offsets: [],
      counts: [],
      sched,
      strip: { lengths: [], total: 0, exact: false },
    };
    session = own;
    measureStrip(own);
    const lines = readLines(cues);
    let warmingStated = false;

    /**
     * Adds what was heard since the last reading (broadcast-state.ts
     * heardStep: played, never seeked over), and sends chapter_rendered once
     * this listen has heard 80% of the work. Read every frame, every feeder
     * tick (a hidden tab has no frames), at the end, and around every seek.
     */
    own.tally = () => {
      const pos = positionOf(own);
      const clockNow = audio.currentTime;
      // Played, not seeked over (heardStep), and each stretch of a line once; the seeded, silent lines never (addHeard).
      if (heardStep(own.lastPos, pos, clockNow - own.lastClock) > 0) own.heard += addHeard(own.spans, sched.at, sched.lengths, own.lastPos, pos, own.madeFrom);
      own.lastPos = pos;
      own.lastClock = clockNow;
      if (countsAsListen(own.heard, own.strip.total, own.counted)) {
        own.counted = true;
        reportCoreSuccess();
      }
    };

    /** This browser cannot decode Dial's recording: every work is made on the device from now on, and this one carries on from the line on air. */
    const makeHereInstead = () => {
      if (session !== own || !own.live || !rec) return;
      own.tally();
      const at = Math.max(0, own.line);
      recordingsPlayable = false;
      prepared.clear();
      const lengths = Array.from({ length: at }, (_, j) => rec.line(j));
      start(work, "made", { fromLine: at, lengths, heard: own.heard, spans: own.spans, counted: own.counted, reason: RECORDING_UNPLAYABLE });
    };

    raWho.textContent = `On air: ${work.title}`;
    paintScript();
    setMediaSession(work, {
      // Play resumes only a paused broadcast; pause pauses only a playing one.
      play: () => {
        if (session === own && own.live && audio.state === "suspended") pause.click();
      },
      pause: () => {
        if (session === own && own.live && audio.state === "running") pause.click();
      },
      seekBy: (seconds) => {
        if (session === own && own.live) seekAndSay(own, positionOf(own) + seconds);
      },
      seekTo: (seconds) => {
        if (session === own && own.live) seekAndSay(own, seconds);
      },
    });
    // The size and the meter's max arrive with the manifest (its totalBytes);
    // until then the meter is indeterminate and the line states no size.
    meter.hidden = !!rec;
    meter.removeAttribute("value");
    pause.hidden = false;
    pause.textContent = "Pause";
    pause.focus();
    setValve(rec ? 1 : 0.08, rec ? "Recording" : "Voice");
    radio.setReady(rec ? 1 : 0);
    air.analyser = analyser;
    air.redraw();
    audio.onstatechange = setLamp;
    setLamp();
    paintTuneIn();
    paintTransport();
    paintAvail();
    announce(rec ? preparedTuningLine(work.title) : `${lead}Warming the voice.`);
    paintProgress();
    // Tune in goes on air in the Broadcast: its address, with no reload, so nothing stops.
    setRoom("broadcast", room === "broadcast" ? "replace" : "push");

    // Lines go on the audio clock a few seconds ahead of the listener. The
    // tick is skipped while paused; with the tab hidden the lookahead is
    // raised (see visibilitychange below), so playback does not wait on it.
    own.feeder = window.setInterval(() => {
      if (audio.state === "running") void sched.feed();
      own.tally();
    }, 250);

    const follow = () => {
      const current = sched.current();
      // On air once a line has really begun: after a handover the line is cued before its audio is made.
      if (!own.onAirSaid && sched.begun && audio.state === "running") {
        own.onAirSaid = true;
        announce(rec ? preparedOnAirLine(work.translator) : onAirLine(work.title, own.kept));
      }
      if (current !== own.line && current >= 0) {
        own.line = current;
        raLines.innerHTML = readAlongHtml(lines, current);
        readAlong.hidden = false;
        paintProgress();
        lineChanged(own);
      }
      const running = audio.state === "running";
      if (air.playing !== running) {
        air.playing = running;
        air.redraw();
      }
      air.silent = sched.inSilence();
      air.register = registerOf(cues[Math.max(0, current)]);
      paintPlayhead();
      own.tally();
      own.frame = requestAnimationFrame(follow);
    };
    own.frame = requestAnimationFrame(follow);

    // Playback ended (the scheduler says so once): the broadcast goes off air.
    const ended = () => {
      if (session === own && own.live) {
        // The last of what was heard counts before the broadcast goes off air.
        own.tally();
        offAir();
        announce(rec ? (own.seeking ? preparedSkippedLine(work.title) : preparedDoneLine(work.title, own.seconds)) : renderedLine(work.title, cues.length, own.seconds, own.kept, own.madeFrom));
        // A completed listen: where the browser allows, offer to install Dial.
        offline?.listened();
      }
    };

    // A failure ends the broadcast: no meter left running, no lamp left lit,
    // and the status says what happened in plain words, with the fix.
    const stopped = (line: string, resumeAt?: number) => {
      if (session !== own) return;
      own.tally();
      const heard = own.heard;
      const spans = own.spans;
      const counted = own.counted;
      offAir();
      meter.hidden = true;
      announce(line, true);
      // Dial's recording stopped: carry on from the line on air, as the same listen.
      if (rec && resumeAt !== undefined) {
        resumeLine.textContent = resumeAtLine(resumeAt + 1);
        resumeLine.onclick = () => start(work, "prepared", { fromLine: resumeAt, heard, spans, counted });
        resumeLine.hidden = false;
        resumeLine.focus();
      }
    };

    if (rec) {
      // Dial's prepared recording: every line is already made, so all of them
      // go to the scheduler at once (the strip, the script and seeking cover
      // the whole work); their samples are fetched as playback nears them.
      own.ready = true;
      for (let i = 0; i < rec.lineCount; i++) {
        const l = rec.line(i);
        sched.add(i, l.speech, l.pause, false);
        own.seconds += l.speech + l.pause;
      }
      own.made = rec.lineCount;
      own.renderDone = true;
      measureStrip(own);
      setLamp();
      paintProgress();
      paintTransport();
      paintRibbon();
      // Resume at line N: the schedule starts there, before anything is fed, so no earlier part is fetched (a seek, so nothing is counted as heard for it).
      if (opts.fromLine) sched.seek(sched.at[opts.fromLine]!);
      sched.renderFinished();
      own.lastPos = positionOf(own);
      return;
    }

    if (seeded.length) {
      // The recording's lines before the one on air are known by their lengths; this device makes the rest.
      own.wav = new WavChunks(RECORDING_RATE);
      seeded.forEach((l, j) => {
        own.offsets[j] = own.wav!.dataBytes / 2;
        own.counts[j] = 0;
        own.wav!.add(new Float32Array(0), 0);
        own.seconds += l.speech + l.pause;
      });
      sched.seed(seeded);
      own.made = seeded.length;
      own.lastPos = positionOf(own);
      measureStrip(own);
    }

    worker!.onmessage = (event: MessageEvent<FromWorker>) => {
      // The worker's own requests go to the Seal's log, whatever the broadcast is doing.
      if (event.data.type === "requests") return recordEntries(event.data.entries);
      if (session !== own || !own.live) return;
      const msg = event.data;
      if (msg.type === "loading") {
        if (!warmingStated) {
          warmingStated = true;
          announce(`${lead}${warmingLine(msg.total, msg.need, work.called, msg.missingVoices)}`);
        }
        // Only a usable total sizes the meter and the valve; otherwise they stay as they are.
        if (isStatableTotal(msg.total)) {
          meter.max = msg.total;
          const loaded = Math.min(msg.loaded, msg.total);
          meter.value = loaded;
          const mb = (n: number) => `<span data-numeral>${(n / 1_000_000).toFixed(1)}</span>`;
          setValve(0.08 + 0.92 * (loaded / msg.total), msg.need === "none" ? "Warming" : `${mb(loaded)} of ${mb(msg.total)} MB`);
        }
      } else if (msg.type === "ready") {
        own.ready = true;
        own.kept = msg.kept;
        voiceKept = msg.kept;
        paintAvail();
        meter.max = cues.length;
        meter.value = 0;
        setValve(1, "Voice ready");
        radio.setReady(1);
        announce(firstLineLine(work.title, own.kept));
        paintProgress();
      } else if (msg.type === "cue") {
        const cue = cues[msg.index]!;
        own.wav ??= new WavChunks(msg.sampleRate);
        sampleRate = msg.sampleRate;
        // Where this line's samples sit in the file, so a seek can read them back once it is made.
        own.offsets[msg.index] = own.wav.dataBytes / 2;
        own.counts[msg.index] = msg.audio.length;
        // The line is kept as 16-bit PCM, and played from there; its Float32 samples are not held after this.
        own.wav.add(msg.audio, cue.pauseAfterMs);
        const speech = msg.audio.length / msg.sampleRate;
        sched.add(msg.index, speech, cue.pauseAfterMs / 1000);
        own.seconds += speech + cue.pauseAfterMs / 1000;
        own.made = msg.index + 1;
        meter.value = own.made;
        markMade(own);
        measureStrip(own);
        paintProgress();
        paintTransport();
        paintRibbon();
      } else if (msg.type === "done") {
        worker!.onmessage = null;
        worker!.onerror = null;
        worker!.terminate();
        own.renderDone = true;
        // One object URL at a time: the previous file's is released first.
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        own.file = own.wav ? new Blob(own.wav.parts(), { type: "audio/wav" }) : null;
        // Made here from a later line, the file lacks the recording's lines before it: it is kept for seeking, never offered as the work.
        downloadUrl = own.file && !seeded.length ? URL.createObjectURL(own.file) : null;
        own.wav = null;
        if (downloadUrl) {
          download.href = downloadUrl;
          download.download = wavName(work.station, work.title);
          download.textContent = `Download ${work.called} as an audio file`;
          download.hidden = false;
        }
        meter.hidden = true;
        // Nothing is lost by switching now, so the question goes.
        hideAsk();
        // Paused with every line made: nothing is live any more, so the lamp goes out.
        setLamp();
        paintProgress();
        paintRibbon();
        announce(renderedLine(work.title, cues.length, own.seconds, own.kept, own.madeFrom));
        measureStrip(own);
        // Every line is made: the broadcast ends once the last one has been heard.
        sched.renderFinished();
      } else {
        stopped(stopLine(msg.message));
      }
    };
    // A worker that fails to start or throws outside its own handler.
    worker!.onerror = (event) => {
      event.preventDefault();
      stopped(stopLine(event.message || ""));
    };
    worker!.postMessage({ type: "render", cues, voices: cast.voices, from: seeded.length } satisfies ToWorker);
  };

  // ---- scrubbing: the strip, J/K/L, [ ], and a line chosen in the script ----
  /** A new live line: the strip, the script's live line, the lock screen's position. */
  const lineChanged = (s: Session) => {
    paintRibbon();
    markScriptLine(s.line);
    updatePosition(s);
  };

  /** Seeks within what is made. Past it (while lines are still being made) the note says so; past the end of a finished work the broadcast ends. */
  const seekAndSay = (s: Session, t: number) => {
    // What was heard up to here counts; the jump itself never does.
    s.tally();
    // A seek past the end of a finished work ends the broadcast at once (the scheduler's complete); it is not a finished listen.
    s.seeking = true;
    let target: ReturnType<typeof s.sched.seek>;
    try {
      target = s.sched.seek(t);
    } finally {
      s.seeking = false;
    }
    if (!target || target.finished) return;
    s.lastPos = s.sched.at[target.index]! + target.offset;
    s.lastClock = s.audio.currentTime;
    scrubNote.textContent = target.beyond && s.made < s.cues.length ? notMadeYet(s.made, s.cues.length) : "";
    lastShown = -1;
    updatePosition(s, s.sched.at[target.index]! + target.offset);
  };

  const seekBy = (seconds: number) => {
    const s = session;
    if (s?.live) seekAndSay(s, positionOf(s) + seconds);
  };

  const stepLine = (delta: -1 | 1) => {
    const s = session;
    if (!s?.live) return;
    const next = lineStep(s.line, delta, s.made);
    if (next !== null) seekAndSay(s, s.sched.at[next]!);
  };

  linePrev.addEventListener("click", () => stepLine(-1));
  lineNext.addEventListener("click", () => stepLine(1));
  back10.addEventListener("click", () => seekBy(-10));
  fwd10.addEventListener("click", () => seekBy(10));

  // The strip: drag the needle (it follows the finger); on release it lands
  // on the nearest line start (design/spec.md 3, needle-drop); or the keys.
  const stripAt = (e: PointerEvent) => {
    const s = session!;
    const r = ribbon.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    return u * s.strip.total;
  };
  ribbon.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !session?.live || !capture(ribbon, e)) return;
    dragAt = stripAt(e);
    lastShown = -1;
    paintPlayhead();
  });
  ribbon.addEventListener("pointermove", (e) => {
    if (dragAt === null || !session?.live) return;
    dragAt = stripAt(e);
    lastShown = -1;
    paintPlayhead();
  });
  const releaseStrip = () => {
    if (dragAt === null) return;
    const t = dragAt;
    dragAt = null;
    const s = session;
    if (s?.live) seekAndSay(s, nearestLineStart(s.sched.at.slice(0, s.made), s.sched.madeSeconds, t));
  };
  ribbon.addEventListener("pointerup", releaseStrip);
  ribbon.addEventListener("pointercancel", releaseStrip);
  ribbon.addEventListener("lostpointercapture", releaseStrip);
  ribbon.addEventListener("keydown", (e) => {
    const s = session;
    if (!s?.live) return;
    const step = { ArrowLeft: -10, ArrowDown: -10, ArrowRight: 10, ArrowUp: 10, PageDown: -60, PageUp: 60 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      seekBy(step);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      seekAndSay(s, e.key === "Home" ? 0 : (s.sched.at[s.made - 1] ?? 0));
    }
  });

  // ---- the Script and the Bookplate: a widget on the work panel --------------
  // The script is always there for the tuned work: every cue's text exactly
  // as printed (Law 2). Only the live line and the made lines change while
  // it plays, so a re-render happens on a new station or a new broadcast,
  // and the line that had focus keeps it.
  const panels = mountPanels();
  const paintScript = () => {
    const w = WORKS[radio.tuned()]!;
    const text = texts.get(w.slug);
    const s = session?.live && session.work === w ? session : null;
    const focused = scriptBox.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.i : undefined;
    scriptNoteEl.textContent = scriptNote(w.translator, !!s);
    scriptBox.innerHTML = text ? scriptHtml(text.source, text.cues, s ? s.line : -1, s ? s.made : 0) : "";
    if (focused === undefined) return;
    const el = scriptBox.querySelector<HTMLElement>(`.sl[data-i="${focused}"]`);
    if (!el) return;
    for (const x of scriptBox.querySelectorAll<HTMLElement>('.sl[tabindex="0"]')) x.tabIndex = -1;
    el.tabIndex = 0;
    el.focus({ preventScroll: true });
  };
  const fallbackFocus = () => (!tune.disabled ? tune : device.querySelector<HTMLElement>("[data-dialwin]"));
  const shortcutSheet = mountSheet($<HTMLDialogElement>("shortcuts")!, fallbackFocus, () => {
    shortcutList.innerHTML = shortcutsHtml(SHORTCUTS);
  });
  // The read-along's Script and Bookplate keys open them on the work panel.
  const openScript = $("open-script");
  openScript?.addEventListener("click", () => panels.openText("script", openScript));
  const openBp = $("open-bookplate");
  openBp?.addEventListener("click", () => panels.openText("bookplate", openBp));
  const openKeys = $("open-shortcuts");
  openKeys?.addEventListener("click", () => shortcutSheet.open(openKeys));

  /** The script's live line follows the broadcast; its scroller follows the line while the listener has not scrolled away (never smoothly under reduced motion). */
  const markScriptLine = (line: number) => {
    const was = scriptBox.querySelector<HTMLElement>(".sl.live");
    const following = !was || inViewWithin(scriptPanel, was);
    for (const el of scriptBox.querySelectorAll<HTMLElement>(".sl.live")) {
      el.classList.remove("live");
      el.removeAttribute("aria-current");
    }
    const el = scriptBox.querySelector<HTMLElement>(`.sl[data-i="${line}"]`);
    if (!el) return;
    el.classList.add("live");
    el.setAttribute("aria-current", "true");
    if (following && !scriptPanel.hidden && scriptPanel.clientHeight > 0) centreWithin(scriptPanel, el);
    const s = session;
    if (s) for (const u of scriptBox.querySelectorAll<HTMLElement>(".sl.unmade")) if (Number(u.dataset.i) < s.made) {
      u.classList.remove("unmade");
      u.removeAttribute("aria-disabled");
    }
  };

  /** Lines made since the last look become playable in the script. */
  const markMade = (s: Session) => {
    if (session !== s || s.work !== WORKS[radio.tuned()]) return;
    for (const u of scriptBox.querySelectorAll<HTMLElement>(".sl.unmade")) if (Number(u.dataset.i) < s.made) {
      u.classList.remove("unmade");
      u.removeAttribute("aria-disabled");
    }
  };

  /** A line chosen in the script plays from its start, once it is made. */
  const chooseLine = (el: HTMLElement) => {
    const i = Number(el.dataset.i);
    const s = session;
    const w = WORKS[radio.tuned()]!;
    if (!s?.live || s.work !== w || !Number.isInteger(i)) return;
    if (i >= s.made) {
      scriptNoteEl.textContent = lineNotMadeYet(i + 1, s.made);
      return;
    }
    scriptNoteEl.textContent = scriptNote(w.translator, true);
    seekAndSay(s, s.sched.at[i]!);
  };
  scriptBox.addEventListener("click", (e) => {
    const el = (e.target as Element).closest<HTMLElement>(".sl");
    if (el) chooseLine(el);
  });
  // One tab stop in the script (a roving tabindex): the arrow keys move between lines, Enter or Space plays one.
  scriptBox.addEventListener("keydown", (e) => {
    const el = (e.target as Element).closest<HTMLElement>(".sl");
    if (!el) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      chooseLine(el);
      return;
    }
    const all = scriptBox.querySelectorAll<HTMLElement>(".sl");
    const i = Number(el.dataset.i);
    const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = all[Math.max(0, Math.min(all.length - 1, to))];
    if (!next || next === el) return;
    el.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });

  // ---- the keyboard (design/spec.md 1.6) -----------------------------------
  let scrub = SCRUB_REST;
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
    const el = document.activeElement as HTMLElement | null;
    const action = keyAction(e, focusKind(el && { tagName: el.tagName, type: (el as HTMLInputElement).type, role: el.getAttribute("role"), isContentEditable: el.isContentEditable }));
    if (!action) return;
    if (action === "shortcuts") {
      e.preventDefault();
      shortcutSheet.open(el);
      return;
    }
    const s = session;
    if (!s?.live) return;
    e.preventDefault();
    if (action === "playpause") pause.click();
    else if (action === "back" || action === "forward") {
      // A held key does not auto-repeat into a run of jumps: each press is one jump.
      if (e.repeat) return;
      const press = scrubPress(scrub, action === "back" ? -1 : 1, performance.now());
      scrub = press.next;
      seekBy(press.seconds);
    } else if (action === "stop") {
      scrub = SCRUB_REST;
      if (s.audio.state === "running") pause.click();
    } else stepLine(action === "line-prev" ? -1 : 1);
  });

  // ---- a locked phone or a hidden tab: timers slow down, so schedule ahead ---
  // Hidden, everything made in the next two minutes goes on the audio clock at
  // once (new lines join as the worker sends them); visible again, the
  // lookahead drops back to a few seconds.
  document.addEventListener("visibilitychange", () => {
    const s = session;
    if (!s?.live) return;
    s.sched.lookahead = document.hidden ? HIDDEN_LOOKAHEAD_S : LOOKAHEAD_S;
    if (document.hidden) void s.sched.feed();
  });

  // ---- back and forward between the rooms: the radio keeps playing ---------
  addEventListener("popstate", () => {
    const r = parseRoute(location.pathname, WORKS);
    if (r.room === "broadcast" && r.index !== radio.tuned()) radio.tune(r.index, "user");
    setRoom(r.room, "none");
  });
  // The brand and the Repertory link go back to the radio without a reload, so a broadcast keeps playing.
  for (const link of [$<HTMLAnchorElement>("to-repertory"), $<HTMLAnchorElement>("room-repertory")]) {
    link?.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (room !== "repertory") setRoom("repertory", "push");
    });
  }

  // ---- the works' texts: read once, then every station is ready ------------
  const load = () => {
    device.dataset.state = "loading";
    note.hidden = false;
    note.textContent = loadingNote(location.host);
    rescueFocus(retry);
    retry.hidden = true;
    radio.setPower(0);
    // Each work arrives on its own: offline, the saved ones load from this
    // device and only the others are unavailable.
    Promise.allSettled(
      WORKS.map((w) =>
        fetch(`/works/${w.slug}.txt`).then((r) => {
          if (!r.ok) throw new Error(`status ${r.status}`);
          return r.text().then((source) => {
            const cues = segment(source);
            // A cast that fails marks only this station unavailable; the others stay on air.
            return [w.slug, { source, cues, cast: tryCast(cues, w.cast) }] as const;
          });
        }),
      ),
    ).then(async (results) => {
      for (const r of results) if (r.status === "fulfilled") texts.set(r.value[0], r.value[1]);
      await openPrepared();
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (results.every((r) => r.status === "rejected") && failed) {
        device.dataset.state = "error";
        const err: unknown = failed.reason;
        note.textContent = err instanceof Error && err.message.startsWith("status ") ? STATIONS_SERVER : stationsUnreached(location.host);
        retry.hidden = false;
        return;
      }
      device.dataset.state = "ready";
      note.hidden = true;
      // Online, a work that did not arrive can be fetched again.
      retry.hidden = !failed || !!offline?.isOffline();
      radio.setPower(1);
      showStation();
    });
  };
  retry.addEventListener("click", load);

  /**
   * Opens each work's prepared recording, from the list compiled into this
   * page (where this browser can play them): its index, checked against its
   * pin and against the lines this page computes from the text and its cast.
   * A work whose recording cannot be opened, or does not match, is made on
   * the device instead.
   */
  const openPrepared = async () => {
    const works = playableRecordings(BUILT_RECORDINGS, recordingsPlayable ? format : null);
    await Promise.all(
      WORKS.map(async (w) => {
        const entry = works[w.slug];
        const text = texts.get(w.slug);
        if (!entry || !text?.cast || prepared.has(w.slug)) return;
        try {
          const opened = await openRecording(w.slug, entry, text.cues, text.cast.voices, format);
          if (opened.recording) prepared.set(w.slug, opened.recording);
        } catch {
          // Its index could not be fetched (offline, not saved): made on the device.
        }
      }),
    );
  };

  showStation();
  paintTransport();
  load();
}

interface MediaActions {
  play: () => void;
  pause: () => void;
  /** Back or forward by this many seconds (the headset's and the lock screen's skip). */
  seekBy: (seconds: number) => void;
  seekTo: (seconds: number) => void;
}

/** Sets a Media Session action where the browser supports it (an unknown action throws in some browsers). */
function setAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // This browser does not offer the action; nothing to set.
  }
}

/**
 * Media Session metadata (the work on air), play/pause and seeking, where
 * the browser has it. Dial makes no claim about lock-screen controls:
 * whether a browser shows them for Web Audio playback is its own choice.
 */
function setMediaSession(work: Work, actions: MediaActions): void {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: work.title,
    artist: work.author,
    album: "Dial",
    artwork: [{ src: "/icons/dial-512.png", sizes: "512x512", type: "image/png" }],
  });
  navigator.mediaSession.setActionHandler("play", actions.play);
  navigator.mediaSession.setActionHandler("pause", actions.pause);
  setAction("seekbackward", (d) => actions.seekBy(-(d.seekOffset ?? 10)));
  setAction("seekforward", (d) => actions.seekBy(d.seekOffset ?? 10));
  setAction("seekto", (d) => {
    if (typeof d.seekTime === "number") actions.seekTo(d.seekTime);
  });
  setPlaybackState("playing");
}

/** The lock screen's position: set on every line change and every seek. */
function updatePosition(s: { strip: { total: number }; sched: { position(): number } }, at?: number): void {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
  const duration = s.strip.total;
  const position = at ?? s.sched.position();
  if (!(duration > 0)) return;
  try {
    navigator.mediaSession.setPositionState({ duration, position: Math.max(0, Math.min(duration, position)), playbackRate: 1 });
  } catch {
    // A browser that refuses the state keeps its own.
  }
}

function setPlaybackState(state: MediaSessionPlaybackState): void {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
}

/** Off air: nothing is named, and the handlers go. */
function clearMediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.setActionHandler("play", null);
  navigator.mediaSession.setActionHandler("pause", null);
  for (const a of ["seekbackward", "seekforward", "seekto"] as const) setAction(a, null);
  setPlaybackState("none");
}

function setupFeedback(): void {
  const form = document.getElementById("feedback-form");
  const status = document.getElementById("feedback-status");
  if (!(form instanceof HTMLFormElement) || !status) return;
  // The form sits in a sheet, opened from the work panel, so the panels never grow to hold it.
  const opener = document.getElementById("open-feedback");
  const dialog = document.getElementById("feedback-sheet");
  if (opener && dialog instanceof HTMLDialogElement) {
    const sheet = mountSheet(dialog, () => opener);
    opener.addEventListener("click", () => sheet.open(opener));
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const textarea = form.elements.namedItem("text");
    const text = textarea instanceof HTMLTextAreaElement ? textarea.value.trim() : "";
    if (!text) return;

    status.textContent = "Sending.";
    status.removeAttribute("data-state");

    const body = JSON.stringify({ text, page: location.pathname });
    // The Seal's log shows the message's size, never its text.
    const token = noteSend("/feedback", new TextEncoder().encode(body).length);
    const sending = fetch("/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // The network failed before it arrived: the Seal's log says "not delivered".
    sending.catch(() => noteSendFailed(token));
    sending
      .then((response) => {
        if (response.status === 429) throw new Error("ceiling");
        if (!response.ok) throw new Error(`status ${response.status}`);
        status.textContent = "Thank you, that was sent.";
        form.reset();
      })
      .catch((err: unknown) => {
        status.textContent =
          err instanceof Error && err.message === "ceiling"
            ? "We have had a lot of feedback today. Please try again tomorrow."
            : "Could not send that. Please try again.";
        status.dataset.state = "error";
      });
  });
}

watchReducedMotion();
recordRequests();
sendEvent("page_view");
setupRadio();
setupFeedback();
mountSealWidget();
registerOfflineHelper();
