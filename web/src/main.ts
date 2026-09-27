// The radio at /. Counts go through telemetry.ts sendEvent, which posts
// nothing once the listener turns counts off on the Seal. This page's
// requests, and its voice worker's, are recorded for the Seal's log
// (request-recorder.ts): paths and sizes only, never text or audio.
import { WORKS, aboutMinutes, countWords, type Work } from "./catalogue";
import { firstOpen, lampLit, wavName } from "./broadcast-state";
import { capture, mountRadio } from "./device/radio";
import { detectPerfTier, type NavigatorLike } from "./device/perf-tier";
import { motion, watchReducedMotion } from "./device/reduced-motion";
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
  STATIONS_SERVER,
  clock,
  firstLineLine,
  lineNotMadeYet,
  loadingNote,
  madeHere,
  notMadeYet,
  onAirLine,
  pausedLine,
  progressLine,
  renderedLine,
  scriptNote,
  stationsUnreached,
  stopLine,
  stripText,
  switchQuestion,
} from "./status-copy";
import type { FromWorker, ToWorker } from "./narrate.worker";
import { WORK_NOT_ON_DEVICE } from "./offline/plan";
import { registerOfflineHelper } from "./offline/store";
import { mountOffline } from "./offline/ui";
import { noteSend, noteSendFailed, recordEntries, recordRequests } from "./request-recorder";
import { sendEvent } from "./telemetry";

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

/** One broadcast: a work being made on this device and played as it is made. */
interface Session {
  work: Work;
  cues: Cue[];
  audio: AudioContext;
  gain: GainNode;
  /** The one analyser on this broadcast's context: the wave, the meters and the eye read it, in this tab only. */
  analyser: AnalyserNode;
  worker: Worker;
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
  if (!device || !tune || !pause || !avail || !status || !progress || !meter || !download || !readAlong || !raLines || !raWho) return;
  if (!note || !retry || !ask || !askQ || !askYes || !askNo || !valveLabel) return;
  if (!eyebrow || !title || !credit || !sentence || !meta || !bookplate) return;
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
  const bpSheetDl = $("bookplate-sheet-dl");
  const bpNote = $("bookplate-note");
  const shortcutList = $("shortcut-list");
  const canvas = device.querySelector<HTMLCanvasElement>("canvas.dw-wave");
  if (!ribbonBox || !ribbon || !timeEl || !timeTotal || !scrubNote || !linePrev || !lineNext || !back10 || !fwd10) return;
  if (!scriptBox || !scriptNoteEl || !bpSheetDl || !bpNote || !shortcutList || !canvas) return;
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
    credit.textContent = w.credit;
    sentence.textContent = w.sentence;
    meta.innerHTML = metaHtml(w, text ? countWords(text.source) : undefined, text?.cast ?? undefined);
    bookplate.innerHTML = bookplateHtml(w, text?.cast ?? undefined);
    device.dataset.realm = w.slug;
    paintAvail();
    paintTuneIn();
    paintPreview();
    offline?.station();
  };

  /** The line under Tune in: a station whose voices could not be cast says so, and only that station. */
  const paintAvail = () => {
    const text = texts.get(WORKS[radio.tuned()]!.slug);
    // Offline, a work whose text is not on this device cannot play, and says so.
    if (!text && offline?.isOffline()) avail.textContent = WORK_NOT_ON_DEVICE;
    else avail.textContent = text && !text.cast ? CAST_FAILED : madeHere(voiceKept);
  };

  const lampState = () => session && { live: session.live, playing: session.audio.state === "running", renderDone: session.renderDone };

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
      s.worker.onmessage = null;
      s.worker.onerror = null;
      s.worker.terminate();
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
        announce(pausedLine(s.work.title, positionOf(s), !s.renderDone));
      } else announce(s.renderDone ? renderedLine(s.work.title, s.cues.length, s.seconds, s.kept) : onAirLine(s.work.title, s.kept));
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
    // The rooms link names the Repertory as the current page only while it is.
    const repertoryLink = document.getElementById("room-repertory");
    if (next === "repertory") repertoryLink?.setAttribute("aria-current", "page");
    else repertoryLink?.removeAttribute("aria-current");
    paintPreview();
    // A control the new room does not show never keeps focus.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && typeof active.checkVisibility === "function" && !active.checkVisibility()) rescueFocus(active);
  };

  /** On the Broadcast before Tune in, the read-along shows where the work begins. */
  const paintPreview = () => {
    if (session?.live && session.line >= 0) return;
    const w = WORKS[radio.tuned()]!;
    const text = texts.get(w.slug);
    if (room !== "broadcast" || !text) {
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
      return t?.cast ? { source: t.source, voices: t.cast.voices } : undefined;
    },
  });

  // ---- asking before a broadcast still being made is stopped ---------------
  let pending: Work | null = null;
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
    if (next) start(next);
  });

  tune.addEventListener("click", () => {
    const work = WORKS[radio.tuned()]!;
    if (!texts.get(work.slug)?.cast) return;
    const s = session;
    if (s?.live && s.work !== work && !s.renderDone) {
      pending = work;
      askQ.textContent = switchQuestion(s.work.called, work.called);
      ask.hidden = false;
      askNo.focus();
      return;
    }
    start(work);
  });

  // ---- Tune in: make the chosen work on this device and play it as it is made
  const start = (work: Work) => {
    const text = texts.get(work.slug)!;
    const cast = text.cast;
    if (!cast) return;
    // work_opened counts Tune in on a work, once per work per page load (founder, 2026-09-26).
    if (firstOpen(opened, work.slug)) sendEvent("work_opened");
    if (session?.live) offAir();
    // The previous finished file stays downloadable until this one is made.

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
    const worker = new Worker(new URL("./narrate.worker.ts", import.meta.url), { type: "module" });
    const cues = text.cues;
    let sampleRate = 24_000;

    /** A made line's samples: from the lines kept so far, or, once the file is made, read back from it. */
    const linePcm = (i: number): Int16Array | Promise<Int16Array> => {
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

    raWho.textContent = `On air: ${work.title}`;
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
    meter.hidden = false;
    meter.removeAttribute("value");
    pause.hidden = false;
    pause.textContent = "Pause";
    pause.focus();
    setValve(0.08, "Voice");
    radio.setReady(0);
    air.analyser = analyser;
    air.redraw();
    audio.onstatechange = setLamp;
    setLamp();
    paintTuneIn();
    paintTransport();
    announce("Warming the voice.");
    paintProgress();
    // Tune in goes on air in the Broadcast: its address, with no reload, so nothing stops.
    setRoom("broadcast", room === "broadcast" ? "replace" : "push");

    // Lines go on the audio clock a few seconds ahead of the listener. The
    // tick is skipped while paused; with the tab hidden the lookahead is
    // raised (see visibilitychange below), so playback does not wait on it.
    own.feeder = window.setInterval(() => {
      if (audio.state === "running") void sched.feed();
    }, 250);

    const follow = () => {
      const current = sched.current();
      if (current !== own.line && current >= 0) {
        if (own.line < 0 && audio.state === "running") announce(onAirLine(work.title, own.kept));
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
      own.frame = requestAnimationFrame(follow);
    };
    own.frame = requestAnimationFrame(follow);

    // Playback ended (the scheduler says so once): the broadcast goes off air.
    const ended = () => {
      if (session === own && own.live) {
        offAir();
        announce(renderedLine(work.title, cues.length, own.seconds, own.kept));
        // A completed listen: where the browser allows, offer to install Dial.
        offline?.listened();
      }
    };

    // A failure ends the broadcast: no meter left running, no lamp left lit,
    // and the status says what happened in plain words, with the fix.
    const stopped = (message: string) => {
      if (session !== own) return;
      offAir();
      meter.hidden = true;
      announce(stopLine(message), true);
    };

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      // The worker's own requests go to the Seal's log, whatever the broadcast is doing.
      if (event.data.type === "requests") return recordEntries(event.data.entries);
      if (session !== own || !own.live) return;
      const msg = event.data;
      if (msg.type === "loading") {
        if (!warmingStated) {
          warmingStated = true;
          announce(warmingLine(msg.total, msg.need, work.called, msg.missingVoices));
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
        measureStrip(own);
        paintProgress();
        paintTransport();
        paintRibbon();
      } else if (msg.type === "done") {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        own.renderDone = true;
        // One object URL at a time: the previous file's is released first.
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = own.wav ? URL.createObjectURL((own.file = new Blob(own.wav.parts(), { type: "audio/wav" }))) : null;
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
        announce(renderedLine(work.title, cues.length, own.seconds, own.kept));
        reportCoreSuccess();
        measureStrip(own);
        // Every line is made: the broadcast ends once the last one has been heard.
        sched.renderFinished();
      } else {
        stopped(msg.message);
      }
    };
    // A worker that fails to start or throws outside its own handler.
    worker.onerror = (event) => {
      event.preventDefault();
      stopped(event.message || "");
    };
    worker.postMessage({ type: "render", cues, voices: cast.voices } satisfies ToWorker);
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
    const target = s.sched.seek(t);
    if (!target || target.finished) return;
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

  // ---- the sheets: the full script, the Bookplate, the keyboard ------------
  const fallbackFocus = () => (!tune.disabled ? tune : device.querySelector<HTMLElement>("[data-dialwin]"));
  const scriptSheet = mountSheet($<HTMLDialogElement>("script-sheet")!, fallbackFocus, () => {
    const w = WORKS[radio.tuned()]!;
    const text = texts.get(w.slug);
    const s = session?.live && session.work === w ? session : null;
    scriptNoteEl.textContent = scriptNote(w.translator, !!s);
    scriptBox.innerHTML = text ? scriptHtml(text.source, text.cues, s ? s.line : -1, s ? s.made : 0) : "";
  });
  const bookplateSheet = mountSheet($<HTMLDialogElement>("bookplate-sheet")!, fallbackFocus, () => {
    const w = WORKS[radio.tuned()]!;
    bpNote.textContent = bookplateHeading(w);
    bpSheetDl.innerHTML = bookplateHtml(w, texts.get(w.slug)?.cast ?? undefined);
  });
  const shortcutSheet = mountSheet($<HTMLDialogElement>("shortcuts")!, fallbackFocus, () => {
    shortcutList.innerHTML = shortcutsHtml(SHORTCUTS);
  });
  const openScript = $("open-script");
  openScript?.addEventListener("click", () => {
    scriptSheet.open(openScript);
    // The live line is in view when the sheet opens (no smooth scroll under reduced motion).
    scriptBox.querySelector<HTMLElement>(".sl.live")?.scrollIntoView({ block: "center", behavior: motion.reduce ? "auto" : "smooth" });
  });
  const openBp = $("open-bookplate");
  openBp?.addEventListener("click", () => bookplateSheet.open(openBp));
  const openKeys = $("open-shortcuts");
  openKeys?.addEventListener("click", () => shortcutSheet.open(openKeys));

  /** The script's live line follows the broadcast while the sheet is open. */
  const markScriptLine = (line: number) => {
    if (!scriptSheet.isOpen()) return;
    for (const el of scriptBox.querySelectorAll<HTMLElement>(".sl.live")) {
      el.classList.remove("live");
      el.removeAttribute("aria-current");
    }
    const el = scriptBox.querySelector<HTMLElement>(`.sl[data-i="${line}"]`);
    if (!el) return;
    el.classList.add("live");
    el.setAttribute("aria-current", "true");
    const s = session;
    if (s) for (const u of scriptBox.querySelectorAll<HTMLElement>(".sl.unmade")) if (Number(u.dataset.i) < s.made) {
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
    ).then((results) => {
      for (const r of results) if (r.status === "fulfilled") texts.set(r.value[0], r.value[1]);
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
registerOfflineHelper();
