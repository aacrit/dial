# Charter

At most 5 surfaces for v1. Any surface added later needs a charter amendment.

| Surface | Why | Justifying user event | Kill date |
|---|---|---|---|
| **Repertory** `/` | The catalogue as a programme guide, each work with its Bookplate. At Spark it holds one work, 514 · No. 001, the Cave, and plays it in place | `work_opened` (Forge; at Spark, `page_view`) | 2026-12-31 |
| **Broadcast** `/play/<work>` | The player: the script page with the live line, cue scrubbing, VU pair, download. At Spark, a plain narration rendered in the tab and a WAV download on `/` | `chapter_rendered` | 2026-12-31 |
| **Studio** `/studio` | Import, structure, voice palette, Direction report and local overrides, Corrections sheet, render, attestation, export | `production_exported` | 2027-02-28 |
| **Seal**, a widget on the radio (amended 2026-09-27, design spec 00) | Privacy proof on the work panel: the magic eye, one plain sentence, today's counts, the counts switch, and every request collapsed. `/seal` is gone (404); the speed-of-this-device test moves to the radio's gauge (T7); the on-device `/verify` provenance checker is still to come | `verify_run` | 2026-12-31 |
| Worker | `/e`, licence check, Polar webhook | Polar order | 2027-02-28 |
| `/privacy.html` | Disclosure for the aggregate-count telemetry, the feedback form, the rate limit and what stays on the device; linked from the home page | `page_view` (same page load as home) | tied to the product's own kill date |

## Kill criteria

Aggregate counts in D1 (`/e`'s `event_counts`), plus payment-provider orders if money changes hands; nothing per person.

- 2026-12-31: fewer than 300 `chapter_rendered` in total → archive.
- `chapter_rendered` counts a listen heard to four fifths of its length, on either path (CoS decision A, 2026-09-27).
- Counts are rate limited per network; large shared networks may undercount; a spike of counts at the daily ceiling is treated as suspect (see the counter's ceiling flag).
- 2027-02-28: 0 Studio orders (Polar dashboard) → the Studio is dropped and the Repertory stays free.

Reading the counts: every count is capped by its daily ceiling, and a browser-sent one can be inflated by anyone who posts to `/e`. So the G4 packet shows each count's day-level spikes (days at or near a ceiling, or far above the usual day) next to the totals, and a total carried by a spike is read as suspect, not as progress.

## Not in v1

- Live search of all of Gutenberg (Fikr's open stacks and proxy).
- Accounts, cloud saves, voice cloning.
- Per-cue music generation.
- Any LLM feature, in the tab or on a server (Law 3: the engine reads form, never meaning).
- Non-English voices.
- Store publishing and a native mobile app (web-first PWA until G4 "graduate").
- Charging for the Studio before the one-time lawyer review of the terms, attestation and labels.

## Workflows: 3 (gate, verify-production, branch-prune)
