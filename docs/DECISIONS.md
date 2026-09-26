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

## 2026-09-26: Rendering stays Kokoro everywhere, no TTS API
Free server TTS was researched (Cloudflare Workers AI MeloTTS and Aura, Gemini, Groq, Hugging Face, ElevenLabs). Prepared recordings for the Repertory are rendered once with Kokoro, the same voice the tab uses, and served as static files. The Studio renders on the device only, so Law 1 is unchanged. Gemini's and ElevenLabs' free tiers train on or review inputs; Workers AI publishes no log-retention window; MeloTTS is plainer than Kokoro.

## 2026-09-26: G2 round 2 approved (Dial, the radio)
The founder asked for a retro device with great motion physics, and for the device rather than the text to be the hero. The approved design puts the works as stations on a dial behind glass, with an inertial needle, a valve warm-up, a read-along strip, sadhana's wave, loader and springs, speed instruments, and a no-stall countdown. Founder answers: the device test runs at the first on-device render; plan on 80% of measured speed with a 2-minute cutoff; the Tune knob changes station. Packet: https://claude.ai/artifact/Jv1JuAgsxgzegGcE25j3gz

## 2026-09-26: Law 2 allows removing a translator's apparatus, by the pinned script only
Founder decision in chat, from the T2 review. A translator's apparatus (footnotes, note markers, editorial marks) may be removed only by `scripts/extract-work.mjs`, which checks the upstream Gutenberg file's SHA-256 before it cuts and refuses unless the note markers match the notes one for one; the Bookplate says what was removed, and every word of the text itself stays verbatim. First use: George Long's Meditations Book II (eBook 15877), without his footnotes, their markers and his + marks, his bracketed words kept.

## 2026-09-26: work_opened counts Tune in on a work
Founder decision in chat, from the T2 review. `work_opened` is sent when Tune in is pressed on a work, once per work per page load; tuning and browsing the dial send nothing. It counts a choice to listen, not a needle passing a station, so the Repertory's kill-criteria reading is not inflated by browsing. design/spec.md section 2's event line says the same.

## 2026-09-26: Copy amendment: no line says nothing was sent
G2 approved "Made on this device. All 118 lines, 20:12. Nothing was sent anywhere.", but the page sends `chapter_rendered` at that moment, so the line was false; truth wins over the approved words. It becomes "Made on this device: all 118 lines, 20:12. The words and the audio never left this device." The same check corrected the spec's other absolute claims: the prepared-recording line, the Seal's first visit (a page view count is sent on load) and its switch (feedback can still be sent), the Studio's "Nothing is sent", and the privacy page.
