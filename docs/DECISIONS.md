# Decisions

Append-only log of scope and architecture decisions for Dial. Newest entry
at the bottom. Do not edit or delete past entries; add a new one that
supersedes it instead.

<!-- Format:
## YYYY-MM-DD: <short title>
<what was decided and why, 2-4 sentences>
-->

## 2026-09-26: G1 approved (Greenlight: Dial)
Approved in chat. Web-first PWA; phone and desktop interfaces designed separately; a one-time lawyer review of the terms, attestation and labels before the Studio charges; Studio $15 one-time via Polar with one free chapter. Payer evidence to be linked during Spark.

## 2026-09-26: Spark renders with Kokoro in the tab, not the Web Speech API
The Spark stub narrates the Cave (Republic 514a to 521b, Jowett, Gutenberg No. 1497) with Kokoro-82M q8 on onnxruntime-web WASM, self-hosted and split into parts under 20 MiB for Workers Static Assets. The browser's speechSynthesis was rejected: some browsers send the text to a cloud voice (breaks Law 1) and it cannot be recorded for download. The page is cross-origin isolated so the runtime can use threads.
