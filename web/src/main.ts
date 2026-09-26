// Telemetry here is aggregate counts only: no anonymous id, no localStorage,
// no cookies, nothing that could identify a visitor. `/e` accepts exactly
// `{ "name": "<allowed event>" }` and bumps a same-day, same-name counter.
// Because it collects and stores nothing personal, no consent banner is
// needed (see web/privacy.html). Every POST is same-origin JSON: the Worker
// refuses anything else (worker/src/guard.ts), so never use sendBeacon,
// which sends text/plain.
import { segment, type Cue } from "./engine/segment";
import { assemble, encodeWav } from "./engine/wav";
import { isStatableTotal, warmingLine } from "./download-size";
import { renderedLine, renderingLine, stopLine } from "./status-copy";
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

// ---- The broadcast: the Cave, rendered in this tab --------------------------

const WORK_URL = "/works/cave.txt";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function renderScript(host: HTMLElement, source: string, cues: Cue[]): HTMLElement[] {
  host.replaceChildren();
  const lines: HTMLElement[] = [];
  let para = document.createElement("p");
  host.append(para);
  cues.forEach((cue, i) => {
    const span = document.createElement("span");
    span.className = "cue";
    span.textContent = cue.text;
    span.dataset.index = String(i);
    para.append(span, " ");
    lines.push(span);
    if (cue.rule === "paragraph-end" && i < cues.length - 1) {
      para = document.createElement("p");
      host.append(para);
    }
  });
  host.dataset.words = String(source.split(/\s+/).filter(Boolean).length);
  return lines;
}

function setupBroadcast(): void {
  const tune = $<HTMLButtonElement>("tune-in");
  const pause = $<HTMLButtonElement>("pause");
  const status = $("broadcast-status");
  const script = $("script");
  const download = $<HTMLAnchorElement>("download");
  const meter = $<HTMLProgressElement>("render-meter");
  if (!tune || !pause || !status || !script || !download || !meter) return;

  let cues: Cue[] = [];
  let lines: HTMLElement[] = [];

  fetch(WORK_URL)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    })
    .then((text) => {
      cues = segment(text);
      lines = renderScript(script, text, cues);
      tune.disabled = false;
    })
    .catch(() => {
      status.textContent = "The text did not load. Reload the page to try again.";
    });

  // One broadcast at a time. Its state lives here so Pause, a stop and a
  // retry all act on the current one.
  let session: { audio: AudioContext; worker: Worker; frame: number; live: boolean } | null = null;

  // Tally means a render or playback is live (design/spec.md 1.1): the lamp
  // is lit only while the session is live and its audio is running.
  const setLamp = () => {
    if (session?.live && session.audio.state === "running") document.body.dataset.onAir = "true";
    else delete document.body.dataset.onAir;
  };

  // The broadcast is over (finished or stopped): lamp off, Tune in back.
  const offAir = () => {
    if (session) {
      session.live = false;
      cancelAnimationFrame(session.frame);
      session.worker.terminate();
      void session.audio.close();
    }
    setLamp();
    for (const line of lines) line.classList.remove("is-live");
    pause.hidden = true;
    pause.textContent = "Pause";
    tune.textContent = "Tune in";
    tune.disabled = false;
  };

  pause.addEventListener("click", () => {
    if (!session?.live) return;
    const { audio } = session;
    if (audio.state === "running") {
      void audio.suspend().then(setLamp);
      pause.textContent = "Resume";
    } else {
      void audio.resume().then(setLamp);
      pause.textContent = "Pause";
    }
  });

  tune.addEventListener("click", () => {
    if (!cues.length) return;
    tune.disabled = true;
    tune.textContent = "On air";
    download.hidden = true;
    status.removeAttribute("data-state");
    // The size and the meter's max arrive with the manifest (its totalBytes);
    // until then the meter is indeterminate and the line states no size.
    status.textContent = "Warming the voice.";
    meter.hidden = false;
    meter.removeAttribute("value");
    let warmingStated = false;
    let kept = true;

    const audio = new AudioContext();
    let nextAt = audio.currentTime + 0.2;
    const starts: number[] = [];
    const rendered: { audio: Float32Array; pauseAfterMs: number }[] = [];
    let sampleRate = 24_000;
    let live = -1;
    // Playback is live until the last scheduled line has ended after the
    // render is done.
    let playing = 0;
    let renderDone = false;

    const worker = new Worker(new URL("./narrate.worker.ts", import.meta.url), { type: "module" });
    const own = { audio, worker, frame: 0, live: true };
    session = own;
    setLamp();
    audio.onstatechange = setLamp;

    const follow = () => {
      const now = audio.currentTime;
      let current = -1;
      for (let i = 0; i < starts.length; i++) if (starts[i]! <= now) current = i;
      if (current !== live) {
        lines[live]?.classList.remove("is-live");
        lines[current]?.classList.add("is-live");
        lines[current]?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        live = current;
      }
      own.frame = requestAnimationFrame(follow);
    };
    own.frame = requestAnimationFrame(follow);

    pause.hidden = false;
    pause.textContent = "Pause";

    // Playback ended: the last line finished after the render was done.
    const ended = () => {
      if (session === own && renderDone && playing === 0) offAir();
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
      if (session !== own) return;
      const msg = event.data;
      if (msg.type === "loading") {
        if (!warmingStated) {
          warmingStated = true;
          status.textContent = warmingLine(msg.total, msg.fromDevice);
        }
        // Only a usable total sizes the meter; otherwise it stays as it is.
        if (isStatableTotal(msg.total)) {
          meter.max = msg.total;
          meter.value = Math.min(msg.loaded, msg.total);
        }
      } else if (msg.type === "ready") {
        kept = msg.kept;
        meter.max = cues.length;
        meter.value = 0;
        status.textContent = renderingLine(0, cues.length, kept);
      } else if (msg.type === "cue") {
        sampleRate = msg.sampleRate;
        const cue = cues[msg.index]!;
        rendered.push({ audio: msg.audio, pauseAfterMs: cue.pauseAfterMs });
        const buffer = audio.createBuffer(1, msg.audio.length, msg.sampleRate);
        buffer.copyToChannel(msg.audio, 0);
        const node = audio.createBufferSource();
        node.buffer = buffer;
        node.connect(audio.destination);
        nextAt = Math.max(nextAt, audio.currentTime + 0.05);
        playing++;
        node.onended = () => {
          playing--;
          ended();
        };
        node.start(nextAt);
        starts[msg.index] = nextAt;
        nextAt += buffer.duration + cue.pauseAfterMs / 1000;
        meter.value = msg.index + 1;
        status.textContent = renderingLine(msg.index + 1, cues.length, kept);
      } else if (msg.type === "done") {
        worker.terminate();
        renderDone = true;
        const wav = encodeWav(assemble(rendered, sampleRate), sampleRate);
        download.href = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
        download.hidden = false;
        meter.hidden = true;
        status.textContent = renderedLine(cues.length, kept);
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

sendEvent("page_view");
setupBroadcast();
setupFeedback();
