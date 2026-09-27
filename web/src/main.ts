// The radio at /. Counts go through telemetry.ts sendEvent, which posts
// nothing once the listener turns counts off on the Seal. This page's
// requests, and its voice worker's, are recorded for the Seal's log
// (request-recorder.ts): paths and sizes only, never text or audio.
import { WORKS, aboutMinutes, countWords, type Work } from "./catalogue";
import { firstOpen, lampLit, liveLine, wavName } from "./broadcast-state";
import { mountRadio } from "./device/radio";
import { watchReducedMotion } from "./device/reduced-motion";
import { isStatableTotal, warmingLine } from "./download-size";
import { tryCast, type Cast } from "./engine/cast";
import { segment, type Cue } from "./engine/segment";
import { WavChunks } from "./engine/wav";
import { bookplateHtml, eyebrowHtml, metaHtml, readAlongHtml, readLines } from "./render";
import {
  CAST_FAILED,
  STATIONS_SERVER,
  firstLineLine,
  loadingNote,
  madeHere,
  onAirLine,
  pausedLine,
  progressLine,
  renderedLine,
  stationsUnreached,
  stopLine,
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

/** One broadcast: a work being made on this device and played as it is made. */
interface Session {
  work: Work;
  cues: Cue[];
  audio: AudioContext;
  gain: GainNode;
  worker: Worker;
  frame: number;
  live: boolean;
  renderDone: boolean;
  /** The voice has loaded: before that, the status shows the warming line. */
  ready: boolean;
  kept: boolean;
  made: number;
  starts: number[];
  seconds: number;
  line: number;
  /** The 16-bit lines so far; released once the file is made or the broadcast stops. */
  wav: WavChunks | null;
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

  const texts = new Map<string, Text>();
  const opened = new Set<string>();
  let mounted = false;
  let volume = 0.7;
  let voiceKept = true;
  let session: Session | null = null;
  let downloadUrl: string | null = null;

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

  // The broadcast is over (finished or stopped): lamp off, keys back, and
  // everything it held is let go (its worker's handlers, its lines, its audio).
  const offAir = () => {
    const s = session;
    if (s) {
      s.live = false;
      cancelAnimationFrame(s.frame);
      s.worker.onmessage = null;
      s.worker.onerror = null;
      s.worker.terminate();
      s.audio.onstatechange = null;
      void s.audio.close();
      s.wav = null;
    }
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
  };

  pause.addEventListener("click", () => {
    const s = session;
    if (!s?.live) return;
    const settle = () => {
      setLamp(); // repaints Tune in too: "Paused" once nothing is live
      setPlaybackState(s.audio.state === "running" ? "playing" : "paused");
      paintProgress();
      if (s.audio.state === "suspended") {
        const at = s.starts[0] === undefined ? 0 : Math.max(0, s.audio.currentTime - s.starts[0]);
        announce(pausedLine(s.work.title, at, !s.renderDone));
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

  const radio = mountRadio(device, WORKS, {
    // Tuning only moves the needle and the card; nothing is counted until Tune in.
    onTune: () => {
      if (!mounted) return;
      showStation();
      hideAsk();
    },
    onVolume: (v) => {
      volume = v;
      if (session?.live) session.gain.gain.value = v;
    },
  });
  mounted = true;

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
    gain.connect(audio.destination);
    const worker = new Worker(new URL("./narrate.worker.ts", import.meta.url), { type: "module" });
    const cues = text.cues;
    const own: Session = {
      work,
      cues,
      audio,
      gain,
      worker,
      frame: 0,
      live: true,
      renderDone: false,
      ready: false,
      kept: true,
      made: 0,
      starts: [],
      seconds: 0,
      line: -1,
      wav: null,
    };
    session = own;
    const lines = readLines(cues);
    let nextAt = audio.currentTime + 0.2;
    let warmingStated = false;
    // Playback is live until the last scheduled line has ended after the render is done.
    let playing = 0;

    raWho.textContent = `On air: ${work.title}`;
    setMediaSession(work, {
      // Play resumes only a paused broadcast; pause pauses only a playing one.
      play: () => {
        if (session === own && own.live && audio.state === "suspended") pause.click();
      },
      pause: () => {
        if (session === own && own.live && audio.state === "running") pause.click();
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
    audio.onstatechange = setLamp;
    setLamp();
    paintTuneIn();
    announce("Warming the voice.");
    paintProgress();

    const follow = () => {
      const current = liveLine(own.starts, audio.currentTime);
      if (current !== own.line && current >= 0) {
        if (own.line < 0 && audio.state === "running") announce(onAirLine(work.title, own.kept));
        own.line = current;
        raLines.innerHTML = readAlongHtml(lines, current);
        readAlong.hidden = false;
        paintProgress();
      }
      own.frame = requestAnimationFrame(follow);
    };
    own.frame = requestAnimationFrame(follow);

    // Playback ended: the last line finished after every line was made.
    const ended = () => {
      if (session === own && own.live && own.renderDone && playing === 0) {
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
        announce(firstLineLine(work.title, own.kept));
        paintProgress();
      } else if (msg.type === "cue") {
        const cue = cues[msg.index]!;
        own.wav ??= new WavChunks(msg.sampleRate);
        // The line is kept as 16-bit PCM and scheduled; its Float32 samples are not held after this.
        own.wav.add(msg.audio, cue.pauseAfterMs);
        const buffer = audio.createBuffer(1, msg.audio.length, msg.sampleRate);
        buffer.copyToChannel(msg.audio, 0);
        const node = audio.createBufferSource();
        node.buffer = buffer;
        node.connect(gain);
        nextAt = Math.max(nextAt, audio.currentTime + 0.05);
        playing++;
        node.onended = () => {
          playing--;
          ended();
        };
        node.start(nextAt);
        own.starts[msg.index] = nextAt;
        nextAt += buffer.duration + cue.pauseAfterMs / 1000;
        own.seconds += buffer.duration + cue.pauseAfterMs / 1000;
        own.made = msg.index + 1;
        meter.value = own.made;
        paintProgress();
      } else if (msg.type === "done") {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        own.renderDone = true;
        // One object URL at a time: the previous file's is released first.
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = own.wav ? URL.createObjectURL(new Blob(own.wav.parts(), { type: "audio/wav" })) : null;
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
        announce(renderedLine(work.title, cues.length, own.seconds, own.kept));
        reportCoreSuccess();
        ended();
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
  load();
}

/**
 * Media Session metadata (the work on air) and play/pause handlers, where the
 * browser has it. Dial makes no claim about lock-screen controls: whether a
 * browser shows them for Web Audio playback is its own choice.
 */
function setMediaSession(work: Work, actions: { play: () => void; pause: () => void }): void {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: work.title,
    artist: work.author,
    album: "Dial",
    artwork: [{ src: "/icons/dial-512.png", sizes: "512x512", type: "image/png" }],
  });
  navigator.mediaSession.setActionHandler("play", actions.play);
  navigator.mediaSession.setActionHandler("pause", actions.pause);
  setPlaybackState("playing");
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
