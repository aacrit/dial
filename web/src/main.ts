// Telemetry here is aggregate counts only: no anonymous id, no localStorage,
// no cookies, nothing that could identify a visitor. `/e` accepts exactly
// `{ "name": "<allowed event>" }` and bumps a same-day, same-name counter.
// Because it collects and stores nothing personal, no consent banner is
// needed (see web/privacy.html). Every POST is same-origin JSON: the Worker
// refuses anything else (worker/src/guard.ts), so never use sendBeacon,
// which sends text/plain.
import { WORKS, aboutMinutes, countWords, type Work } from "./catalogue";
import { firstOpen, lampLit, liveLine, wavName } from "./broadcast-state";
import { mountRadio } from "./device/radio";
import { watchReducedMotion } from "./device/reduced-motion";
import { isStatableTotal, warmingLine } from "./download-size";
import { segment, type Cue } from "./engine/segment";
import { assemble, encodeWav } from "./engine/wav";
import { bookplateHtml, eyebrowHtml, metaHtml, readAlongHtml } from "./render";
import { MADE_HERE, STATIONS_UNREACHED, STATIONS_SERVER, pausedLine, renderedLine, renderingLine, stopLine } from "./status-copy";
import type { FromWorker, ToWorker } from "./narrate.worker";

function sendEvent(name: string): void {
  fetch("/e", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
    keepalive: true,
  }).catch(() => {
    // Best-effort telemetry: a failed send is not the user's problem.
  });
}

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
  /** The first voice line has arrived: before that, the status shows the warming line. */
  ready: boolean;
  warming: string;
  kept: boolean;
  made: number;
  starts: number[];
  seconds: number;
  line: number;
}

function setupRadio(): void {
  const device = document.querySelector<HTMLElement>("[data-device]");
  const tune = $<HTMLButtonElement>("tune-in");
  const pause = $<HTMLButtonElement>("pause");
  const avail = $("tune-avail");
  const status = $("broadcast-status");
  const meter = $<HTMLProgressElement>("render-meter");
  const download = $<HTMLAnchorElement>("download");
  const readAlong = $("readalong");
  const raLines = $("ra-lines");
  const raWho = $("ra-who");
  const note = $("devnote");
  const retry = $<HTMLButtonElement>("retry");
  const valveLabel = $("valve-label");
  const eyebrow = $("st-eyebrow");
  const title = $("st-title");
  const credit = $("st-credit");
  const sentence = $("st-sentence");
  const meta = $("st-meta");
  const bookplate = $("bookplate");
  if (!device || !tune || !pause || !avail || !status || !meter || !download || !readAlong || !raLines || !raWho || !note || !retry || !valveLabel) return;
  if (!eyebrow || !title || !credit || !sentence || !meta || !bookplate) return;

  const texts = new Map<string, Text>();
  const opened = new Set<string>();
  let volume = 0.7;
  let session: Session | null = null;
  let downloadUrl: string | null = null;

  const open = (w: Work) => {
    if (firstOpen(opened, w.slug)) sendEvent("work_opened");
  };

  // ---- the station card follows the needle ---------------------------------
  const showStation = () => {
    const w = WORKS[radio.tuned()]!;
    const text = texts.get(w.slug);
    eyebrow.innerHTML = eyebrowHtml(w, text ? aboutMinutes(text.source, text.cues) : undefined);
    title.textContent = w.title;
    credit.textContent = w.credit;
    sentence.textContent = w.sentence;
    meta.innerHTML = metaHtml(w, text ? countWords(text.source) : undefined);
    bookplate.innerHTML = bookplateHtml(w);
    device.dataset.realm = w.slug;
    avail.textContent = MADE_HERE;
    paintTuneIn();
  };

  const paintTuneIn = () => {
    const w = WORKS[radio.tuned()]!;
    const here = !!session?.live && session.work === w;
    tune.classList.toggle("is-on-air", here);
    tune.textContent = here ? "On air" : "Tune in";
    tune.disabled = here || !texts.has(w.slug);
  };

  // ---- the lamp: tally means a render or playback is live ------------------
  const setLamp = () => {
    const lit = lampLit(session && { live: session.live, playing: session.audio.state === "running", renderDone: session.renderDone });
    if (lit) document.body.dataset.onAir = "true";
    else delete document.body.dataset.onAir;
  };

  const refreshStatus = () => {
    const s = session;
    if (!s?.live) return;
    status.removeAttribute("data-state");
    if (!s.ready) status.textContent = s.warming;
    else if (s.audio.state === "suspended") {
      const at = s.starts[0] === undefined ? 0 : Math.max(0, s.audio.currentTime - s.starts[0]);
      status.textContent = pausedLine(at, Math.max(1, s.line + 1), s.cues.length, !s.renderDone);
    } else if (s.renderDone) status.textContent = renderedLine(s.cues.length, s.seconds, s.kept);
    else status.textContent = renderingLine(s.made, s.cues.length, s.kept);
  };

  const setValve = (share: number, label: string) => {
    radio.setValve(share);
    valveLabel.innerHTML = label;
  };

  // The broadcast is over (finished or stopped): lamp off, keys back.
  const offAir = () => {
    const s = session;
    if (s) {
      s.live = false;
      cancelAnimationFrame(s.frame);
      s.worker.terminate();
      void s.audio.close();
    }
    setLamp();
    readAlong.hidden = true;
    pause.hidden = true;
    pause.textContent = "Pause";
    setValve(0, "Voice");
    paintTuneIn();
  };

  pause.addEventListener("click", () => {
    const s = session;
    if (!s?.live) return;
    const settle = () => {
      setLamp();
      refreshStatus();
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
    onTune: (i, cause) => {
      if (cause === "user") open(WORKS[i]!);
      if (texts.size) showStation();
    },
    onVolume: (v) => {
      volume = v;
      if (session?.live) session.gain.gain.value = v;
    },
  });

  // ---- Tune in: make the chosen work on this device and play it as it is made
  tune.addEventListener("click", () => {
    const work = WORKS[radio.tuned()]!;
    const text = texts.get(work.slug);
    if (!text) return;
    open(work);
    if (session?.live) offAir();
    meter.hidden = true;
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    download.hidden = true;
    download.removeAttribute("href");

    const audio = new AudioContext();
    const gain = audio.createGain();
    gain.gain.value = volume;
    gain.connect(audio.destination);
    const worker = new Worker(new URL("./narrate.worker.ts", import.meta.url), { type: "module" });
    const own: Session = {
      work,
      cues: text.cues,
      audio,
      gain,
      worker,
      frame: 0,
      live: true,
      renderDone: false,
      ready: false,
      // The size and the meter's max arrive with the manifest (its totalBytes);
      // until then the meter is indeterminate and the line states no size.
      warming: "Warming the voice.",
      kept: true,
      made: 0,
      starts: [],
      seconds: 0,
      line: -1,
    };
    session = own;
    const cues = text.cues;
    const lines = cues.map((c) => c.text);
    const rendered: { audio: Float32Array; pauseAfterMs: number }[] = [];
    let sampleRate = 24_000;
    let nextAt = audio.currentTime + 0.2;
    let warmingStated = false;
    // Playback is live until the last scheduled line has ended after the render is done.
    let playing = 0;

    raWho.textContent = `514 · ${work.station} · ${work.title}`;
    meter.hidden = false;
    meter.removeAttribute("value");
    pause.hidden = false;
    pause.textContent = "Pause";
    setValve(0.08, "Voice");
    audio.onstatechange = setLamp;
    setLamp();
    paintTuneIn();
    refreshStatus();

    const follow = () => {
      const current = liveLine(own.starts, audio.currentTime);
      if (current !== own.line && current >= 0) {
        own.line = current;
        raLines.innerHTML = readAlongHtml(lines, current);
        readAlong.hidden = false;
        if (audio.state === "running") refreshStatus();
      }
      own.frame = requestAnimationFrame(follow);
    };
    own.frame = requestAnimationFrame(follow);

    // Playback ended: the last line finished after every line was made.
    const ended = () => {
      if (session === own && own.renderDone && playing === 0) {
        offAir();
        status.textContent = renderedLine(cues.length, own.seconds, own.kept);
      }
    };

    // A failure ends the broadcast: no meter left running, no lamp left lit,
    // and the status says what happened in plain words, with the fix.
    const stopped = (message: string) => {
      if (session !== own) return;
      offAir();
      meter.hidden = true;
      status.textContent = stopLine(message);
      status.dataset.state = "error";
    };

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      if (session !== own || !own.live) return;
      const msg = event.data;
      if (msg.type === "loading") {
        if (!warmingStated) {
          warmingStated = true;
          own.warming = warmingLine(msg.total, msg.fromDevice);
          refreshStatus();
        }
        // Only a usable total sizes the meter and the valve; otherwise they stay as they are.
        if (isStatableTotal(msg.total)) {
          meter.max = msg.total;
          const loaded = Math.min(msg.loaded, msg.total);
          meter.value = loaded;
          const mb = (n: number) => `<span data-numeral>${(n / 1_000_000).toFixed(1)}</span>`;
          setValve(0.08 + 0.92 * (loaded / msg.total), msg.fromDevice ? "Warming" : `${mb(loaded)} of ${mb(msg.total)} MB`);
        }
      } else if (msg.type === "ready") {
        own.ready = true;
        own.kept = msg.kept;
        meter.max = cues.length;
        meter.value = 0;
        setValve(1, "Voice ready");
        refreshStatus();
      } else if (msg.type === "cue") {
        sampleRate = msg.sampleRate;
        const cue = cues[msg.index]!;
        rendered.push({ audio: msg.audio, pauseAfterMs: cue.pauseAfterMs });
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
        refreshStatus();
      } else if (msg.type === "done") {
        worker.terminate();
        own.renderDone = true;
        const wav = encodeWav(assemble(rendered, sampleRate), sampleRate);
        // One object URL at a time: the previous file's is released first.
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
        download.href = downloadUrl;
        download.download = wavName(work.station, work.title);
        download.hidden = false;
        meter.hidden = true;
        // Paused with every line made: nothing is live any more, so the lamp goes out.
        setLamp();
        refreshStatus();
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
    worker.postMessage({ type: "render", cues } satisfies ToWorker);
  });

  // ---- the works' texts: read once, then every station is ready ------------
  const load = () => {
    device.dataset.state = "loading";
    note.hidden = false;
    note.textContent = "Warming up. Reading the works from dial.voidvision.org.";
    retry.hidden = true;
    radio.setPower(0);
    Promise.all(
      WORKS.map((w) =>
        fetch(`/works/${w.slug}.txt`).then((r) => {
          if (!r.ok) throw new Error(`status ${r.status}`);
          return r.text().then((source) => [w.slug, { source, cues: segment(source) }] as const);
        }),
      ),
    )
      .then((loaded) => {
        for (const [slug, text] of loaded) texts.set(slug, text);
        device.dataset.state = "ready";
        note.hidden = true;
        radio.setPower(1);
        showStation();
      })
      .catch((err: unknown) => {
        device.dataset.state = "error";
        note.textContent = err instanceof Error && err.message.startsWith("status ") ? STATIONS_SERVER : STATIONS_UNREACHED;
        retry.hidden = false;
      });
  };
  retry.addEventListener("click", load);

  showStation();
  load();
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

    fetch("/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, page: location.pathname }),
    })
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
sendEvent("page_view");
setupRadio();
setupFeedback();
