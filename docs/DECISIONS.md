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

## 2026-09-26: Spark released to workers.dev only
release/2026.09.26-1 is live at https://dial.aacrit.workers.dev with the contract at 23/23. The zone's WAF rate-limit rule is not live yet (40 fast requests to a voidvision.org static page all answered 200), so under the /release Spark exception the custom domain dial.voidvision.org waits for that founder ask. Payer evidence, linked on the Board's registry row: authors pay $22 to $99 a month (ElevenLabs), $100 to $300 a year (Speechify) or $150 to $400 per finished hour (human ACX); against that, KDP Virtual Voice and Google Play auto-narration are free, and AI narration was 0.03% of 2025 US audiobook sales.

## 2026-09-26: G2 approved (Design sign-off: Dial, four rooms)
Approved in chat with all seven defaults: Tune in plays at once; separate "Save for offline" and "Download as an audio file"; a finished listen counts as `chapter_rendered`, including the prepared recording; the meters are Voice and Music; Daylight follows the device; letter and verse get violet, not amber; daily counts are on by default and the Seal's switch turns them off. Packet: https://claude.ai/artifact/K6JtLsNFqVEPxqfrUfhXLt
