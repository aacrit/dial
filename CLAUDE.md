# CLAUDE.md

Product law for **Dial** (`dial`). The Agentique plugin (installed via
`.claude/settings.json`) runs this product's org. This file holds law only,
capped at 150 lines, no history.

## What this is

Dial is a single-purpose web product served at `https://dial.voidvision.org`.
See `CHARTER.md` for its surfaces and kill dates, and `contract.yaml` for what
"serving correctly" means in a script.

## Fixed constraints

- **$0 running cost.** Everything fits the free tiers declared in `budget.yaml`.
- **No SSR.** Static frontend (`web/`, built to a generated dist directory)
  served by Workers Static Assets, plus one Worker (`worker/src/index.ts`)
  for `/e`, `/feedback`, `/healthz` and API routes. Only those routes run the
  Worker (`assets.run_worker_first` in `wrangler.jsonc`): a static asset must
  never cost an invocation. A new Worker route is added to that list.
- **Free quotas are account-wide.** Every D1 write path sits behind a day
  ceiling that writes nothing once reached (`worker/src/events.ts`), and the
  ceilings' worst case stays within the share `budget.yaml` states
  (`tests/hardening.test.ts` recomputes it from `wrangler.jsonc`). A new
  write path adds its ceiling and a line in `worker/src/config.ts`'s
  worstCaseDailyWrites. Every Worker request passes one per-client rate
  limit in `worker/src/guard.ts` (each write path has its own binding;
  IPv6 per /64, never stored), and any failure inside the Worker answers
  a 503 in JSON, never an error page.
- **Web baseline.** Every response carries the security headers and CSP from
  `scripts/lib/csp.mjs` (static files through the build's `_headers`, the
  Worker through `worker/src/headers.ts`). POSTs are same-origin JSON only.
- **Data:** D1 only, schema in `migrations/0001_events.sql`. No R2, no KV
  writes, unless a charter amendment adds a surface that needs them.
- **Telemetry is aggregate counts only.** `/e` bumps a same-day, same-name
  counter in `event_counts`; there is no per-visit row, no anonymous id and
  no cookie. Every count goes through `web/src/telemetry.ts` sendEvent,
  which sends nothing once the listener turns counts off on the Seal; that
  switch is the only thing in local storage. No third-party analytics script (including
  Cloudflare Web Analytics) is added by default; adding one needs a charter
  amendment and a V3 check.
- **Success event.** `contract.yaml`'s success_event is the product's core
  action completing, sent from where it completes, and the one count
  `CHARTER.md`'s kill criteria name. Never page views or feedback.
  `scripts/lint-events.mjs` fails the gate otherwise.
- **Nothing loads from another origin.** Fonts are self-hosted
  (`design/fonts.css`); the CSP allows this origin only. Invocation logs are
  off. `web/privacy.html` says only what the code does: every claim is
  paired with its code in `tests/privacy-page.test.ts`, changed together.
- **No LLM feature** by default. One needs a charter amendment and the
  plugin's LLM add-on (free providers under a daily cap), never the Claude
  subscription.
- **Design:** `design/tokens.css` is the only file that may define a color.
  Ink & Momentum grammar is law; see the plugin's `ink-and-momentum` skill.
- **Production deploys** only via the plugin's `/release` skill, only from a
  release/* tag. This repo has no deploy workflow.

## Dial's three laws

1. **The book never leaves this tab.** No upload path exists. Every
   `fetch` in `web/src` names a same-origin path in `privacy-allowlist.json`
   (`tests/no-network.test.ts`); the CSP says `connect-src 'self'`. The voice
   (Kokoro-82M q8), its WASM runtime and the texts are self-hosted, pinned
   by SHA-256 in `scripts/fetch-voice.mjs`, never in git, staged into
   `web/public/voice` and `web/public/ort` before every build.
   Dial's prepared recordings likewise: made once by
   `scripts/render-recordings.mjs` (the tab's own pipeline), published as
   release assets, pinned in `recordings.lock.json`, checked and staged by
   `scripts/fetch-recordings.mjs`; the page plays one only when every
   line's hash matches the text and cast it computes itself.
2. **The words are the author's.** Every cue's `text` is a byte-exact slice
   of its source and the cues rebuild it exactly (`tests/verbatim.test.ts`).
   `spoken` may differ only by whitespace, and by leaving out the speaker
   label that opens a turn (`speakerLabel()` in
   `web/src/engine/segment.ts`), until the Corrections sheet exists. The
   read-along shows the name derived from that label.
   A translator's apparatus (footnotes, the markers that point at them, and
   marks of a doubtful reading) may be removed only by
   `scripts/extract-work.mjs`, which refuses unless the upstream Gutenberg
   file matches its pinned SHA-256 and the note markers match the notes one
   for one (`tests/verbatim.test.ts`). The Bookplate says what was removed,
   and every word of the text itself stays verbatim.
3. **One deterministic engine that never needs to understand the text.**
   `web/src/engine/` reads form only (paragraphs, sentence and clause marks,
   speaker labels, later speech tags). Unlabelled text is read by one of two
   fixed narrator voices; speakers are cast from a palette that never holds
   a narrator voice, never from a name (`web/src/engine/cast.ts`).
   Casting is a fixed integer score over `design/voices.json`: one accent
   per work, grade x word share, contrast weighted by share of exchanges, a
   pace band, never re-timed. A Repertory work may carry a cast sheet,
   written by the curator from the text's own list of persons and shown on
   the Bookplate, that declares only voice sex (and optionally the work's
   accent); the engine never parses names. No LLM, ever, in the render path.

Texts are public domain worldwide only (published before 1930 and the
author or translator died before 1956), each with its Bookplate: source,
edition, the passage performed and the PD basis.

## Non-negotiables

1. No merge to `main` without a green `gate` job (`.github/workflows/gate.yml`).
2. Every ticket maps to a `CHARTER.md` row (see the plugin's `/ship` skill).
3. Secrets are never tracked; see `.githooks/pre-commit`.
4. Reports go to a gitignored reports directory or the Board page, never the repo root.
5. `/e` accepts only the event names `contract.yaml` lists under events.allowed.

## Commands

- `npm run dev`: Vite dev server plus `wrangler dev`.
- `npm run build`: production build to dist/, build tag injected.
- `npm run gate`: the full gate (typecheck, build, tests, lint-size, lint-workflows,
  lint-design, lint-docs, lint-events, gate-selftest, layout-check). Must pass before any merge.
- `npm run layout-check`: the no-scroll rule in Chromium at the panel map's
  viewports (`scripts/layout-check.mjs`). CI always runs it; a local gate
  without a browser skips it and says so.
- `npm run contract -- --url <url>`: run `contract.yaml` against a live URL.
  Checks marked `requires: deployed` show SKIP on localhost and must PASS
  on the preview.
- `npm run scan-history`: scan full git history for leaked secrets.
