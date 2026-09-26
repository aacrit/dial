// Telemetry here is aggregate counts only: no anonymous id, no localStorage,
// no cookies, nothing that could identify a visitor. `/e` accepts exactly
// `{ "name": "<allowed event>" }` and bumps a same-day, same-name counter.
// Because it collects and stores nothing personal, no consent banner is
// needed (see web/privacy.html). Every POST is same-origin JSON: the Worker
// refuses anything else (worker/src/guard.ts), so never use sendBeacon,
// which sends text/plain.
import { segment, type Cue } from "./engine/segment";
import { assemble, encodeWav } from "./engine/wav";
import { warmingLine } from "./download-size";
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

  tune.addEventListener("click", () => {
    if (!cues.length) return;
    tune.disabled = true;
    tune.textContent = "On air";
    document.body.dataset.onAir = "true";
    // The size and the meter's max arrive with the manifest (its totalBytes);
    // until then the meter is indeterminate and the line states no size.
    status.textContent = "Warming the voice.";
    meter.hidden = false;
    meter.removeAttribute("value");
    let warmingTotal = 0;

    const audio = new AudioContext();
    let nextAt = audio.currentTime + 0.2;
    const starts: number[] = [];
    const rendered: { audio: Float32Array; pauseAfterMs: number }[] = [];
    let sampleRate = 24_000;
    let live = -1;

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
      requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);

    pause.hidden = false;
    pause.addEventListener("click", () => {
      if (audio.state === "running") {
        void audio.suspend();
        pause.textContent = "Resume";
      } else {
        void audio.resume();
        pause.textContent = "Pause";
      }
    });

    const worker = new Worker(new URL("./narrate.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if (msg.type === "loading") {
        if (msg.total !== warmingTotal) {
          warmingTotal = msg.total;
          meter.max = msg.total;
          status.textContent = warmingLine(msg.total);
        }
        meter.value = msg.loaded;
      } else if (msg.type === "ready") {
        meter.max = cues.length;
        meter.value = 0;
        status.textContent = `Rendering on this device: 0 of ${cues.length} lines.`;
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
        node.start(nextAt);
        starts[msg.index] = nextAt;
        nextAt += buffer.duration + cue.pauseAfterMs / 1000;
        meter.value = msg.index + 1;
        status.textContent = `Rendering on this device: ${msg.index + 1} of ${cues.length} lines.`;
      } else if (msg.type === "done") {
        worker.terminate();
        const wav = encodeWav(assemble(rendered, sampleRate), sampleRate);
        download.href = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
        download.hidden = false;
        meter.hidden = true;
        status.textContent = `Rendered. All ${cues.length} lines, made on this device. Nothing was sent anywhere.`;
        reportCoreSuccess();
      } else {
        worker.terminate();
        status.textContent = `The render stopped: ${msg.message}. Reload the page to try again.`;
        status.dataset.state = "error";
      }
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
