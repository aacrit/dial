# Dial: design spec (G2, round 1, revised after the user-sim dry run)

Studio designer, 2026-09-26. Covers the four charter surfaces: Repertory `/`, Broadcast `/play/<work>`, Studio `/studio`, Seal `/seal` (with `/verify`). `/privacy.html` exists and is not redesigned here.

Grammar is Ink & Momentum (Fraunces, Inter, JetBrains Mono with `tabular-nums`, earned accents, spring motion, the copy voice). Dial owns the hue, the texture, the motion presets, the heroes and the logomark: "Night Programme".

Files:
- `design/tokens.css`: the only colour file. Seven source hexes; everything else derived.
- `design/mocks/{repertory,broadcast,studio,seal}.html`: self-contained mocks. Each has a state switcher (top right; bottom right on a phone). `?state=<id>` opens a state, `?theme=daylight|night` pins a theme, `?clean` hides the switcher, `?still` freezes motion for screenshots.
- `design/mocks/shots/<surface>-<width>.png`: 375, 768, 1280 and 1920 px, dark theme, default state. The default state of every surface is a **first visit**: nothing playing, nothing loaded.

State ids (every one works with `?state=`; the first is the default):
| Mock | States |
|---|---|
| Repertory | `first-run`, `listening`, `saving`, `saved`, `after-listen`, `after-listen-ios`, `loading`, `offline`, `error`, `search-empty` |
| Broadcast | `first-run`, `playing`, `saving`, `saved`, `rendering`, `warming`, `slow`, `paused`, `rendered`, `offline`, `error`, `bookplate` |
| Studio | `first-run`, `structuring`, `import-error`, `workspace`, `voices`, `corrections`, `export`, `keep`, `exported`, `warming`, `slow`, `over-limit` |
| Seal | `first-visit`, `sealed`, `counts-off`, `blocked`, `warming`, `verify-found`, `verify-match`, `verify-nomatch`, `verify-none`, `verify-unreadable` |

---

## 1. Decisions that apply everywhere

### 1.1 Colour and meaning
| Token | Earned only when |
|---|---|
| `--color-filament` (valve amber) | something acts (buttons, links, focus), the live line, the play needle. The one accent. |
| `--color-tally` (ON AIR red) | a render or playback is live. A **lamp** only: a dot, the arch's wave, the render head. Never a text ground (cream on tally is 3.73:1). |
| `--color-magic-eye` (green) | loudness in spec, the Seal closed, a `/verify` match, a public-domain basis checked, an accepted correction, an export done. |
| `--color-ochre` | a correction or the rights statement is pending. |
| `--color-register-{telling,speaking,letter}` | the VU pair, the Tuning Dial, the cue sheet swatches. Height is loudness, hue is register. |
| `--color-realm` (per work, `data-realm`) | the cue ribbon and the chapter card only; bleeds in over 2.4 s. |

- **Errors earn no hue.** They are cream prose where the action failed, with the fix as a filament button. Tally means live, so it never marks an error. This changes the Spark: `#broadcast-status[data-state="error"]` and `#feedback-status[data-state="error"]` use tally today, and `body[data-on-air] #tune-in` puts cream text on tally. Forge fixes both (lamp beside a cream label instead).
- **Registers depart from the brand sheet on one point.** The sheet gave amber to the inner voice. Amber already means "you can act" and "the live line", so the letter and verse register gets its own dusk violet. Telling is the text's own colour; speaking is dial-glass blue.

### 1.2 Themes: Night by default, Daylight honest
Dark is the identity, but the script page is a reading surface and people listen on phones outdoors, where a dark page washes out; some readers with astigmatism also read dark text on light more easily. The brand sheet already has a paper treatment. So Daylight exists, follows the device setting, and is the same seven hexes relit: paper from cream, walnut ink, every accent darkened in OKLch lightness only. The Studio console keeps its grain and drops the glow. There is no in-app theme toggle (one fewer control); `data-theme` pins either theme for tests. Every text pair in both themes is at or above 4.5:1; the list is in the header of `tokens.css`. Screenshots are Night only; Daylight is verified by contrast maths and one visual check at 375 px.

### 1.3 Type
- Display: Fraunces. Script and manuscript text use weight 300 at reading size (the static fontsource cut is heavy at 400). The brand's `SOFT 100` needs the variable file (`@fontsource-variable/fraunces`, full axes); Forge adds it to `fonts.css` or accepts the static cut.
- Structure: Inter. Data: JetBrains Mono with `tabular-nums` for every numeral, including times, sizes, catalogue numbers, the 514, dBFS values and cue numbers.
- **Wordmark:** DIAL in Limelight, logo only, converted to outline paths (OFL font; outlines are a logo, not font software). It ships as an inline SVG `<symbol>`, so no Limelight file is ever loaded. Tracking 0.08 em.
- Reading measure: `--measure-reading: 68ch`. At 1920 px and up, `html` steps from 16 to 18 px; the measure never grows.

### 1.4 Motion (named presets in `tokens.css`)
| Preset | Numbers | Carries |
|---|---|---|
| `needle-drop` | 1000 / 30 / 1, 530 ms | a line or cue snaps into place; the needle lands; the live line changes; button release |
| `dial-drift` | 80 / 20 / 1, 1340 ms | scrubbing and following: the needle glides to a position |
| `valve-warm` | 150 / 12 / 1.2, 1430 ms | warming: the magic eye closing, the voice loading, the logo carrier on first paint |
| `vu-ballistics` | 300 ms | the VU pair's integration time |
| `hard-cut` | 0 ms | where the audio cuts, the screen cuts: register changes on the VU, silence cues flatten the wave |
| family `stagger`, `rack focus`, `shimmer` | as Ink & Momentum | listing entrance, hovering a listing softens the rest, catalogue loading |

With reduced motion, every wave is drawn once and holds still, the eye is drawn closed, the live line changes without a transition and nothing scrolls smoothly. The logo's wave moves only in the app, never in exports or print. The app makes no sounds of its own.

### 1.5 Chrome, per device
**Phone (375 to 767 px), listening first.**
- Header: arch mark, DIAL wordmark, `AM 514 kHz`, and on the right the Seal pip: a green dot and "Sealed". Respects the top safe area.
- Bottom tab bar, 64 px plus the bottom safe area: Repertory, Broadcast, Studio, Seal. Each tab is a hand-drawn glyph (24 px, 1.6 stroke) with its label; the current tab carries the living wave underline. Targets are the full quarter width by 64 px.
- Mini-player docked 8 px above the tabs, only once something has started playing (never on a first visit): tally lamp, title, "Glaucon, speaking · 01:27 of 20:12", Pause, and a 2 px progress line in the realm colour. Swipe up or tap the title to open the Broadcast; swipe down on the Broadcast to minimise.
- The Broadcast is a full-height sheet over the tabs (grabber, a Minimise chevron, the catalogue number, a Bookplate link).
- No hover-only affordances and no icon-only actions: every control that keeps or downloads something carries a label.
- "Save for offline" is visible from the first visit, on every listing and in the player, with its size. The install prompt appears only after a first completed listen (section 2).

**Tablet (768 to 1279 px): two panes.** Station bar on top, persistent player bar at the bottom. Repertory: list and detail. Broadcast: script and a side rail with the horizontal VU pair. Studio: manuscript and cue sheet, with the Tuning Dial in a bottom sheet (grabber, peeks at full dial height) and the inspector as a side sheet opened by tapping a cue.

**Desktop (1280 px and up): production first.** Station bar (60 px): the lockup, the four rooms as text tabs with the wave underline, the Seal pip, and a `?` keycap. Player bar (76 px): lamp, title and credit, transport (previous line, back 10 s, play or pause, forward 10 s, next line), the cue ribbon, time. Hover rack-focus on lists; right-click on a cue opens the same actions as its inspector (Play from here, Override, Reset to the engine); files dropped anywhere on the Studio import.

**1920 px and up.** Type steps up one size. Extra width goes to the Tuning Dial's time resolution: it draws a fixed 10 px per second, so 1280 shows about 46 s of the chapter and 1920 about 71 s, with finer wave detail; the cue ribbon gains resolution the same way. Reading text stays at 68ch. Canvases render at the device pixel ratio, capped at 2.

### 1.6 Keyboard (desktop and tablet with a keyboard)
| Key | Does |
|---|---|
| Space | Play or pause |
| J | Back 10 seconds. Press again to scrub faster (1×, 2×, 4×). |
| K | Stop scrubbing and pause |
| L | Forward 10 seconds. Press again to scrub faster. |
| `[` `]` | Previous or next line. In the Studio, previous or next cue. |
| `/` | Search the Repertory, the script or the manuscript |
| `?` | Show the shortcuts |
| Esc | Close a sheet or dialog |

Keys do nothing while focus is in a text field. The `?` dialog is titled "Keyboard" and lists exactly this table.

### 1.7 Media Session (lock screen, headset, car)
- `title`: the work ("The Allegory of the Cave"); `artist`: "Plato, translated by Benjamin Jowett"; `album`: "Dial · 514 · No. 001"; artwork: the arch mark on console ground at 96, 192 and 512 px. Studio productions: title from the import, artist "Dial Studio", no album.
- Actions: play, pause, seekbackward and seekforward (10 s), seekto, previoustrack and nexttrack mapped to the previous and next **section** (cues are too fine for a lock screen). `setPositionState` on every line change.

### 1.8 Vocabulary
Listeners hear **lines**; authors direct **cues**. "Tune in" starts a work. "Sealed" means nothing has left the tab. Never "unlock", "upload", "AI-powered", "magic" or "cloud".

Listener copy uses plain words: "made on your device", "Dial made this recording in advance", "the voice". Words like render, engine, register, spec, dBFS and tab belong to the Studio and the spec, not to the Repertory or the Broadcast.

Two ways to keep a work, never confused:
| Label | What it does | Where the audio ends up |
|---|---|---|
| **Save for offline** | Keeps the work playable inside Dial with no connection | Dial's own storage on this device (Cache Storage); removable with Remove |
| **Download the file** | Writes a WAV (M4A later) to the device's downloads | The user's files, playable in any app |

In the Studio, "Keep" is a third thing: an encrypted copy of a production, on this device only.

---

## 2. Repertory `/`
**Job:** choose a work to hear. **Hero:** the programme guide, works as listings, never a feed.

**Layout.** Phone: header, then "The Repertory" and one column of listings. Tablet: listings as a compact list (catalogue number, title, credit) beside a detail pane with the selected listing in full, Bookplate open. Desktop: title and intro side by side, listings in three columns (a printed guide), "In preparation" as a quiet row beneath. 1920: the same guide, one type size up.

**A listing** (card, one work):
- Eyebrow: `514 · No. 001` left, `about 20 min` right.
- Title (Fraunces), credit (Fraunces italic), one descriptive sentence.
- **Turn map**, the listing's fingerprint: every turn of the text as a mark along the running time, the first speaker above the line and the second below, marks as long as the turn; one-voice works sit above the line with their section silences visible. It is drawn from the engine's script (form only, available before any render). Once a work is rendered, mark heights come from each turn's measured loudness. Speaker names label the two rows.
- Meta (mono): words, voices, "Public domain worldwide" in magic-eye green (a checked basis).
- Actions: **Tune in** (to `/play/<work>`), then where it plays from: "Plays at once: Dial made this recording in advance." (the Cave) or "Made on your device as you listen." (the others).
- **Save for offline** row, always visible under the actions, labelled with what it will store:
  - Cave: "Save for offline" / "7.3 MB: the recording Dial made. No voice download."
  - Crito: "29 kB of text, plus the voice, once (115 MB)". Meditations: "13 kB of text, plus the voice, once (115 MB)"; once the voice is saved: "13 kB of text. The voice is already saved."
  - While saving: "Saving…", "48.2 of 114.6 MB", a progress line, Cancel.
  - Saved: green pip, "Saved for offline", the size, and Remove.
  - **The Cave saves differently, and says so.** It stores the recording Dial made in advance (Opus, about 7.3 MB at 48 kbps; the real size comes from the catalogue manifest), with no voice download. Works without a prepared recording store their text and the voice, and the audio is made on the device when played, offline too.
- Bookplate (drill, collapsed): Source, Public domain, Voices, Corrections, Direction, Also.

**v1 shelf (all facts checked against the texts on 2026-09-26):**
| | No. 001 | No. 002 | No. 003 |
|---|---|---|---|
| Title | The Allegory of the Cave | Crito | Meditations, Book II |
| Credit | Plato, Republic, Book VII, 514a–521b. Translated by Benjamin Jowett. | Plato. Translated by Benjamin Jowett. | Marcus Aurelius. Translated by George Long. |
| Sentence | Prisoners in the dark take shadows for the world. One of them is turned toward the light. | Socrates in prison before dawn. His friend has a plan for escape. The Laws of Athens answer him. | An emperor's notes to himself, written on campaign by the Danube. Seventeen short sections, each followed by a silence. |
| Words, time | 2,990 · about 20 min | 5,347 · about 36 min | 2,350 · about 16 min |
| Source | Gutenberg eBook No. 1497, from "And now, I said" to "I will choose them, he replied." Jowett's introduction and the rest of the Republic are not performed. | Gutenberg eBook No. 1657, from "Why have you come at this hour, Crito?" to "whither he leads." Jowett's introduction is not performed. | Gutenberg eBook No. 15877 (Thoughts of Marcus Aurelius Antoninus), Book II, from "Begin the morning by saying to thyself" to "This in Carnuntum." Long's footnotes are not performed; the words he supplied in brackets are. |
| PD basis | Published 1871; Jowett died 1893. | Same. | First published 1862; Long died 1879. |
| Voices | Socrates, George. Glaucon, Lewis. | Socrates, George. Crito, Lewis. (Order of first appearance.) | George, one voice. |
| Corrections | "a underground den" spoken "an underground den"; Glaucon spoken GLAW-kon. | Phthia and Sunium given English pronunciations. | None. |

Times are words at 155 per minute plus the pause table; the real running time replaces them from the rendered file. The Bookplate's Direction line for every work: "Nobody directed this performance. The same fixed rules perform every work, from the layout of the text alone." The Cave's Voices line: "Socrates, George. Glaucon, Lewis. The voice is Kokoro-82M, an open speech model that runs on your device. AI-voiced; the words are Jowett's, exactly as printed." LibriVox: the Cave links to the Spark's `librivox.org/platos_republic/`; the other two link to LibriVox until the catalogue build resolves and checks a per-work link (F1).

**In preparation** (only works the brief names, no dates): Apology and Phaedo, Plato, translated by Benjamin Jowett. "With Crito, they complete the trial and death of Socrates. They join the shelf when their performances pass the same checks as the rest."

**States and copy**
| State | What shows |
|---|---|
| First visit (default) | Eyebrow "First shelf · Philosophy · 3 works". Title "The Repertory". Lede "Philosophy, performed as radio theatre. Free to hear and to keep, with no account." Under it: "Each performance is made from the words on the page and nothing else. Nothing you do here leaves your device. See the Seal" (link). Every listing shows "Save for offline" with its size. No mini-player, no install prompt. |
| Listening | The same, with the mini-player and (tablet and up) the player bar. |
| Saving, Saved | As the Save for offline row above. |
| After a first completed listen, where the browser offers an install prompt (Chrome, Edge, Android) | Card: "Keep Dial on this device" / "Install it to open from your home screen, with lock-screen controls. Works you save for offline stay with it." Buttons: Install, Not now. Shown once; Not now hides it for 30 days. |
| After a first completed listen, iPhone and iPad Safari (no install prompt exists) | Card: "Add Dial to your Home Screen", numbered steps: "In Safari, tap Share: the square with an arrow pointing up." / "Scroll down and tap Add to Home Screen." / "Tap Add." Then "From the Home Screen, Dial keeps your saved works and shows lock-screen controls. In a Safari tab, iPhone can clear saved works if you do not open Dial for a week." Button: Not now. No Install button, because none would work. |
| Loading | Standing-wave loader, "Tuning in to the Repertory.", shimmer placeholders (one on a phone, three on a desktop). |
| Offline | Notice: "Offline. Works saved on this device play as usual. The others need a connection for their first listen." Saved listings: "Saved for offline" / "Plays with no connection." Unsaved: "Not saved" / "Needs a connection to save or play." |
| Did not load | "The Repertory did not load" / "The list of works could not be fetched from dial.voidvision.org. Check your connection, then try again. Works you have saved still play from the Broadcast tab." Button: Try again. |
| Search, no results | "Nothing on the shelf matches "Seneca"" / "The Repertory holds public-domain works only, and its first shelf is philosophy. Search looks at titles, authors and translators." Button: Clear the search. Search placeholder: "Search the Repertory"; `/` focuses it. |

Events: `work_opened` fires when a Broadcast opens from a listing.

---

## 3. Broadcast `/play/<work>`
**Job:** listen, following the words. **Hero:** the script page with the live line in amber, and the VU pair.

**Layout.** Phone: a sheet. Top: grabber, Minimise, `514 · No. 001`, and a **Bookplate** button (44 px tall) that opens the Bookplate as a bottom sheet (grabber, title, close button, the full Bookplate; tapping the scrim or Esc closes it; on tablet and up it is a centred dialog). Title and credit, the status line, then the script in a scrolling window with faded edges that keeps the live line about 40% down. The dock: the level pair as two thin horizontal bars (Voice, Music), the cue ribbon, elapsed and remaining time, the transport (Previous line, Back 10 s, Play/Pause 56 px, Forward 10 s, Next line), then two labelled buttons side by side: **Save for offline** and **Download the file**. Tablet: script beside a rail (chapter card, VU pair, download, Bookplate), player bar below. Desktop: three columns: the VU rail (vertical meters, legend), the script at 68ch with speaker names in the left margin, the side rail. 1920: rails widen and meters lengthen; the script does not.

**The script page.** Verbatim text in Fraunces 300. Speech tags ("I said", "he replied") are set in the muted cream of the telling register; turns are in cream. The live line is amber on a faint amber glow and changes by `needle-drop`. Clicking a line plays from it. Speaker names in the margin come from the engine's script, never from a curator.

**The VU pair.** Two meters, labelled Voice and Music for listeners (Score in the Studio), on a dBFS scale from 0 to -40. Voice height is loudness with a 300 ms integration and a peak hold; its hue is the current cue's register, switched by hard cut. The voice meter marks the target band (-23 to -18 dBFS). Under it: a green pip and "Voice level in range" while the level sits in the band; nothing when it does not. Music sits at zero under dialogue, labelled "Music: silent under dialogue", which is Law 3's music rule made visible. Legend: Narration, Speech, Letter or verse.

**Cue ribbon.** One segment per line along the running time, in the work's realm colour: played solid, ahead at 42%, not yet rendered as faint ghost. Amber needle at the playhead; a tally line at the render head while rendering. Scrubbing drags the needle (`dial-drift`); releasing lands on the nearest line start (`needle-drop`).

**Chapter card** (realm-coloured top edge): catalogue number, title, "Now: Glaucon, speaking", and Line 11 of 118, Time 01:27 of 20:12, Voices George, Lewis. (118 is the Spark segmenter's real line count for the Cave.)

**Keep this work** (side rail on tablet and up; the two dock buttons on a phone):
- "Save for offline" / "Keeps this work playable in Dial with no connection. It stays inside Dial on this device. 7.3 MB: the recording Dial made in advance, with no voice download." Button: Save for offline. Then "Saving… 3.1 of 7.3 MB" with a progress line and Cancel; then a green pip, "Saved for offline", "Plays in Dial with no connection. 7.3 MB on this device.", Remove. The phone dock button shows "Save for offline", then "Saving… 42%", then "Saved for offline".
- "Download the file" / "A WAV file in your downloads, 58.2 MB, to play in any app or keep. Its tags carry the Bookplate. A smaller M4A file comes later." Button: Download the file. For a work being made on the device, the file is offered once all lines are made.

**States and copy**
| State | Status line or panel |
|---|---|
| First visit (default) | Panel "Tune in" / "Plays at once: Dial made this recording in advance, from Jowett's words and nothing else. Or your device can make its own copy as you listen." Buttons: Tune in, Make it on this device. Note: "Making it here downloads the voice once, about 115 MB. Tune in needs no download." Works without a prepared recording show only "Tune in" (which makes it on the device) and "The voice downloads once, about 115 MB." Save for offline and Download the file are visible from here. |
| Playing Dial's recording | Lamp. "On air. Playing a recording Dial made in advance from Jowett's words. Nothing is made or sent while you listen." |
| Saving, Saved | As Keep this work above. |
| Made on this device, ahead | Lamp. "On air. Your device is making the recording just ahead of you: line 64 of 118." Ribbon shows the render head. |
| Getting the voice ready | Standing wave, "Getting the voice ready", a progress line, "48.2 of 114.6 MB. It downloads once, from dial.voidvision.org, and then stays on this device. The first line plays as soon as it is ready." Button: Stop, and play Dial's recording instead (only where one exists). |
| Device too slow | "This device makes the recording slower than it plays" / "It makes 0.6 seconds of audio each second, so listening now would stop and start. Making the whole work first takes about 34 min; leave this page open while it does." Buttons: Play Dial's recording (where one exists), Make it first, then play. The rate is measured on the first 20 s of audio, never guessed. |
| Paused | Unlit lamp. "Paused at 01:27. Line 11 of 118." |
| Made on this device, finished (`rendered`) | Green pip. "Made on this device. All 118 lines, 20:12. Nothing was sent anywhere." Download the file enabled. On a phone, after the first completed listen, the install card: on iPhone Safari the Add to Home Screen steps (as in the Repertory); where the browser offers the prompt, "Keep Dial on this phone" with Install. |
| Offline, no voice | "You are offline, and the voice is not on this device yet" / "The voice downloads once (about 115 MB). Connect once to fetch it; after that, this work plays with no connection. The words below are saved and readable now." Button: Try again. |
| Making it stopped | "Making the recording stopped at line 64" / "Your browser stopped the graphics chip that runs the voice. Lines 1 to 63 are kept. Resume, and Dial carries on in a slower mode, about three times slower on this device." Buttons: Resume from line 64, Play Dial's recording. Other causes use the same shape: what stopped, what is kept, the one action. |
| Bookplate open (`bookplate`) | The phone Bookplate sheet over the player. |
| Silence cue (transient) | The VU falls to zero and the arch's wave flattens for exactly the cue's duration. No text. |

The prepared recording and the in-tab render both count `chapter_rendered` at the end of a completed listen (see open question 1).

---

## 4. Studio `/studio`
**Job:** turn a chapter into a labelled recording the author can publish. **Hero:** the Tuning Dial.

The mock's manuscript is Chapter I of Pride and Prejudice (Gutenberg eBook No. 1342), a public-domain text a user may bring for free. Its cues, times, casting and Direction report are computed in the mock by applying the brief's rules to the real text; they illustrate the F1 engine and are not its output.

The Studio opens on its import screen (a first visit); the production bar, console and player bar appear only once a chapter is loaded.

**Desktop layout (1280).** Production bar: title, file name, words, cues, "sealed in this tab"; status chips; Keep and Export.

**One production model drives the chips, the header Export button and the Export panel**, so they can never disagree (the author read a mismatch as a reason to doubt the privacy claims):
| Production | Corrections chip | Rights chip | Render chip | Header button | Export panel |
|---|---|---|---|---|---|
| Rights not stated, rendering | ochre "Corrections: 2 to review" | ochre "Rights: not stated" | lamp "Rendering: 41 of 47" | Export, disabled ("State the rights in the Export tab first") | "Not stated yet"; Export chapter disabled with "State the rights above, and let the render finish (41 of 47 cues)." |
| Voices downloading | same | same | lamp "Getting the voices ready" | Export, disabled | same |
| Rights stated, rendered (`keep`) | ochre "Corrections: 2 to review" | check "Rights: public domain" | green "Rendered: 47 of 47" | Export, enabled | Source filled, Export chapter enabled, and "2 corrections are not reviewed, so the voice says those words as written. You can review them first or export now." |
| Exported | ochre "Corrections: 2 not reviewed" | check "Rights: public domain" | green "Rendered: 47 of 47", plus green "Exported 21:46" | Export again, enabled | The Exported panel |
Pending corrections never block an export; unstated rights and an unfinished render do. Tapping the Corrections or Rights chip opens that inspector tab. Three panes below, each scrolling on its own:
1. **Manuscript**, verbatim (Fraunces 300, 68ch max). Cues are spans; the selected cue has an amber outline and, while playing, the amber live treatment. Pending corrections carry an ochre dotted underline; accepted ones a thin rule. Italics marked `_like this_` in a .txt display as italics; the characters stay in the source.
2. **Tuning Dial and cue sheet.** The dial sits on the console texture (filament glow from above plus 4% grain: the only textured surface in Dial). Top: a time scale, a tick per second and a mono label every 10 s. Middle: each cue as a block along time, height its loudness, hue its register; unresolved speakers drawn hollow; ochre pins where a correction waits; the selected cue in a dashed amber frame; past the render head, a hatched static band and a tally line labelled RENDERING; the amber needle with a cap at the playhead. Readout: "Rendered 41 of 47 cues · 1.8× real time on this device (WebGPU) · about 1 min left". Legend underneath. The cue sheet: Cue, Start, Voice, Register, Text, Pause; overridden values carry a "yours" tag; unresolved voices are italic.
3. **Inspector**, four tabs: Cue, Voices, Corrections, Export (ochre pips where something waits).

At 1920 the manuscript column caps at the reading measure plus padding, the inspector is 400 px, and the Tuning Dial takes the rest.

**Cue tab: the Direction report and overrides.** For the selected cue: "Cue 7 · 00:41.2", the verbatim text, "Characters 526 to 537 of the source, verbatim", then each decision with the rule that produced it:
- Register: Speaking. "Rule: text inside quotation marks is dialogue."
- Speaker: Unresolved. "Rule: the speech tag's subject is a pronoun ("returned she"). Dial never guesses who a pronoun means."
- Voice: Emma, the narrator. "Rule: an unresolved turn falls back to the narrator's voice."
- Pause after: 0.15 s. "Rule: a comma closing the quotation, from the punctuation table."

"Your override": "Overrides stay in this tab, and in your Keep file if you keep one. They are the only direction a production has." Fields: Speaker (engine value, detected speakers, "Name a speaker"), Apply to (This cue only / This turn: cues 7 and 9), Pause after in seconds. Buttons: Apply override, Reset to the engine.

**Voices tab.** Casting table (In the text, Engine, Yours): Narrator, Emma; "his lady", first at cue 3, Lewis, yours Isabella; "his wife", Isabella; Mr. Bennet, named by you, yours George. Note: "Dial casts speakers in the order they first speak. It never infers gender or character from a name. Change any line here; the change stays in this tab." Voice palette: "Six voices, the same for every production." Emma, Isabella, Alice, George, Lewis, Daniel (Kokoro British English voices; the founder confirms the palette once), each with Hear.

**Corrections tab.** "A correction changes only what the voice says. The manuscript and every cue keep the text exactly as written. Nothing applies until you accept it." Then "2 to review · 1 accepted" and rows (original, "spoken as", spoken; reason; cue; Accept, Keep as written, Hear both):
- Michaelmas spoken as Mickle-mus. "A feast-day name the voice misreads. Found in the pronunciation lexicon."
- chaise spoken as shays. "A French loanword the voice misreads. Found in the pronunciation lexicon."
- develope spoken as develop. "A period spelling the voice reads as four syllables. Accepted; the page keeps Austen's spelling." (green pip, Undo)

**Export tab.**
- Rights: "Required before each export. There is no default; choose the one that is true." Radios: "I wrote this, or I hold the audio rights to it." / "It is public domain." (reveals Source, required). Pending line: ochre pip, "Not stated yet".
- Free trial: "This chapter: 847 words. The free trial covers one chapter of your own writing, up to 8,000 words. Public-domain texts with a source are free at any length."
- Written into the file: Label "AI-voiced with Dial"; Made "26 September 2026"; Rights; Source text "SHA-256 9c1e44a0 7b3d2f18 …, computed on this device"; Mark "An inaudible 64-bit mark: the Dial tag and a short fingerprint of this text. It never contains who you are."
- File: "WAV · 24 kHz mono · about 16.9 MB. M4A and Opus come with the full engine." Button Export chapter; when disabled: "State the rights above, and let the render finish (41 of 47 cues)."
- Keep: "Closing this tab erases this production. Keep saves it on this device, encrypted with a passphrase you choose. Nothing is uploaded, and Dial cannot recover a forgotten passphrase." Passphrase field; Keep on this device.

**States and copy**
| State | What shows |
|---|---|
| First visit, import (default) | Drop zone "Bring a chapter" / "Paste it, or drop a .txt or .docx file here. It is read in this tab and never uploaded." Buttons: Paste text, Choose a file. One line of terms: "Free: one chapter, up to 8,000 words, and any public-domain text. Your whole book: $15 once, not on sale yet. Nothing is sent: check it on the Seal." (Seal is a link.) No player bar. |
| Reading the structure | "Reading the structure" / "pride-and-prejudice-ch1.txt: 34 paragraphs, 28 with quotations, 847 words. Dial reads the form of the text, never its meaning." |
| Import error | "This file could not be read" / "manuscript.pages is a Pages document. Dial reads .txt and .docx. In Pages, choose File, Export To, Word, then drop the .docx here." Buttons: Choose another file, Paste text instead. |
| Warming the voices | In the dial: "Warming the voices: 61.0 of 115.6 MB" / "The voice model, its runtime and the three voices this chapter casts download once from dial.voidvision.org, then stay on this device. You can read the Direction report and set overrides meanwhile." |
| Device renders slowly | Readout: "This computer renders at 0.7× real time: no WebGPU here, so the processor does the work. About 8 min for this chapter. Keep editing while it renders." Not a blocker. |
| Console (default), Voices, Corrections, Export, Keep | As above. |
| Exported | Chip "Exported 21:46" (green). Panel: "Exported" / "pride-and-prejudice-chapter-i.wav, 16.9 MB, is in your downloads." / "Its label reads: AI-voiced with Dial. Public domain, Project Gutenberg eBook No. 1342. 26 September 2026." / link "Check it on the Seal". Then "This production is still sealed in this tab. Keep it, or it is erased when the tab closes." |
| Longer than the free chapter | Sheet: "This manuscript is longer than the free chapter" / "manuscript.docx has 41,260 words in 12 chapters. The free trial covers one chapter of your own writing, up to 8,000 words. Chapter 1 (6,912 words) is ready to render now." Price box: "$15 once, no subscription"; "Your own books, any length", "Cast voices and Keep", "The Repertory's motif palettes"; disabled button **Not on sale yet**; "The Studio's terms, rights statement and file labels are with a lawyer before Dial takes money. Until then, the free chapter works in full and public-domain texts stay free. When it opens, payment goes through Polar, and the licence is checked once and then works offline." Actions: Render chapter 1 free; "Ask for an accessibility or student waiver" (opens the feedback form with that subject). |
| Licence active (after the lawyer review) | Price box replaced by "The Studio is yours on this device. Licence checked 26 September 2026; it works offline." No other state changes. |
| Crash recovery | On the next open: "The last session ended without closing. Its folder was erased, as it would have been on exit. Kept productions are safe." Button: Open a kept production. |
| Closing with unsaved work | The browser's leave-page prompt, plus in-page before it: "Closing this tab erases this production. Keep it first?" Buttons: Keep, Close without keeping. |

**Tablet.** Manuscript and cue sheet side by side; the Tuning Dial is a bottom sheet above the player bar showing the full dial (71 s in view at 768 px); tapping a cue opens the inspector as a right sheet.

**Phone: import, trial render and export only.** Title "Hear your chapter". First visit: "Bring a chapter" / "Paste it, or choose a .txt or .docx file. It is read on this phone and never uploaded." and the same one line of terms. Cards: This chapter (name, words, voices, running time, a compact whole-chapter strip coloured by register, "Trial render: 41 of 47 cues, 0.9× real time on this phone", Play the trial); Rights (the same two options, no default; Export chapter, "State the rights, and let the trial render finish."); Exported. The note, always visible: "Changing voices, pauses and registers cue by cue needs a larger screen. On a computer, import the same file and the Studio opens in full. On a phone, Dial imports, plays a trial and exports."

Event: `production_exported` when the file is written.

---

## 5. Seal `/seal` and `/verify`
**Job:** show that nothing left the tab, and check where a recording came from. **Hero:** the magic eye.

**The magic eye.** A tuning-eye tube seen end on: dark glass, a green fluorescent fan, a dark cap, and a shadow wedge at the top. While the page reads its request record, the wedge is open and the fan dim; it closes to a hairline by `valve-warm` when the record is complete and every request was to this origin. Closed and green means sealed.

**Layout.** Phone: the eye (104 px) beside "This tab / Sealed", then the sentence, the counts switch, "What this can and cannot show", the log, Verify. Desktop: the eye (200 px), headline, sentence and switch on the left; the request log on the right; Verify full width below, with two drop zones side by side. `/verify` opens this page scrolled to Verify, its heading focused.

**Copy and states**
| State | Headline and sentence |
|---|---|
| First visit (default) | "Sealed" / "This tab has sent nothing. It has fetched 4 files from dial.voidvision.org to show you this page, and they stay on this device." The log lists the page, its code and two typefaces; "Sent: nothing". No mini-player. |
| After a listen, counts on (`sealed`) | "Sealed" / "Since you opened Dial at 21:04, this tab has sent one count: 27 bytes, with no identifier and no content. Everything else was fetched from dial.voidvision.org and stays on this device." |
| Counts off | "Counts are off. This tab has sent nothing since 21:26. The one count sent before then is still listed below, because the log shows everything." |
| Browser blocked a request | "Still sealed. The browser blocked 1 request to another site before it left. Dial loads nothing from other sites, so it came from code Dial did not ship, most likely a browser extension." The row shows struck through with an ochre ✕, size "none"; the limits drill opens. The eye stays closed: nothing left. |
| Opening | Headline "Reading this tab" / "Collecting the browser's record of every request this page has made." Eye open and dim. |

Switch: "Send daily counts" / "Totals per day of listens, exports and checks, and nothing more. Turn this off and Dial sends nothing at all. The setting stays on this device." (Stored in `localStorage`; the `/e` sender checks it before every send.) **This needs a privacy-page amendment at Forge:** it is the first thing Dial keeps in local storage, and `/privacy.html` currently describes only counts, feedback and the rate limit. The same amendment covers works saved for offline (Cache Storage) and Keep (encrypted, in the origin's private file system), all on the device, none sent.

Limits drill, "What this can and cannot show": "The log lists every request this page made, and every request its offline helper (the service worker) made, read from the browser's own record as it happens." / "The page's rules allow requests to dial.voidvision.org only. The browser enforces them and blocks anything else before it leaves." / "Browser extensions and the browser's own services run outside the page, so they cannot appear here. Fetching a file tells the server which file, as every web request does; Dial stores none of it." / "**Check it yourself:** open your browser's developer tools, choose the Network tab, and reload this page. You will see the same list, from the browser rather than from Dial."

**The log.** "Every request this tab made", totals "Sent: 1 count, 27 B · Fetched: 15 files, 114.6 MB". Columns: direction glyph (fetched, sent, blocked), Time, Path on dial.voidvision.org, What it was, Size. Rows come from `PerformanceObserver` (`resource`, buffered) in the page plus a `postMessage` from the service worker for its own fetches, plus `securitypolicyviolation` events for blocked ones. Sent rows are raised. Footer: "Newest last. Nothing has been sent to any other address." The mock's sizes are the real asset sizes (voice parts 21.0 MB each and 8.5 MB, runtime 21.6 MB, George 522 kB, the Cave 16.0 kB); the `/e` body `{"name":"chapter_rendered"}` is 27 bytes.

**Verify.** Eyebrow `/verify`, "Check a recording", "Drop an audio file to read its Dial label and its inaudible mark. If you have the text it may have been made from, drop that too, and Dial compares their fingerprints. Both files are read on this device and never uploaded." Drop zones: "Recording" / "WAV, M4A, Opus or MP3."; "The text, if you have it" / "A .txt or .docx. Dial hashes it here and compares the fingerprint with the one in the recording." The fingerprint is the SHA-256 of the text after the Studio's own import normalisation, so a .docx and its .txt export match when the words match.
| Result | Copy |
|---|---|
| Made with Dial | "Made with Dial on 26 September 2026" (green pip). Label: AI-voiced with Dial. Rights stated: It is public domain. Source: Project Gutenberg eBook No. 1342. Text fingerprint: 9c1e44a0 7b3d2f18, the first 64 bits of the text's SHA-256. Found in: The file's label and the inaudible mark. They agree. Note: "The mark says a file was made with Dial from a particular text. It never says who made it; Dial does not know." |
| Mark only (label stripped) | "Made with Dial" / "The date and rights statement were in the file's label, which has been removed. The inaudible mark survives, with the text fingerprint 9c1e44a0 7b3d2f18." |
| Match | "Match" (green pip) / "This recording was made from this text. The text's fingerprint, 9c1e44a0 7b3d2f18, is the one in the recording's mark. Neither file left this device." |
| No match | "No match" / "This recording was not made from this text, or it was made from a version with changes. One changed character gives a different fingerprint, so compare the exact file you think it came from." |
| No mark | "No Dial mark in this file" / "Either it was not made with Dial, or the mark did not survive: re-recording through a speaker removes it. The mark records where a file came from; it is not proof on its own, and it is not copy protection." |
| Not audio | "This file could not be decoded" / "meeting-notes.pdf is a PDF, not audio. Dial reads WAV, M4A, Opus and MP3. Choose the recording itself." |

Footer: "Rights questions: rights@voidvision.org. We host nothing people make with Dial, so there is nothing of theirs for us to take down; this page is how anyone can check a file." Event: `verify_run` when a recording is read.

---

## 6. Notes for Forge
- **Verbatim text versus the em-dash lint.** Jowett prints "unenlightened:—Behold!", and the Cave has 7 em dashes. The no-em-dash rule governs Dial's own copy, never an author's words (Law 2 wins). Runtime text is fetched from `/works/*.txt`, outside the lint. In the static mocks the dash is written as `&mdash;`, which the lint does not read as a dash. Forge should make the lint's exemption explicit (skip `web/public/works/` and any element marked `lang` + `data-verbatim`) rather than rely on the entity.
- The Spark's tally-as-text-ground and tally-as-error styles change (see 1.1).
- Palette hexes and roles are unchanged, so the Spark and the lint keep working; new tokens are additive. `html` steps to 18 px at 1920.
- The first voice download is about **115 MB** (model 92.4 MB, runtime 21.6 MB, voice 0.5 MB), not 90 MB. The Spark's status line should say "about 115 MB".
- Reading positions are kept in memory only. What Dial stores on the device, all of it disclosed on an amended `/privacy.html` before G3: the counts switch (`localStorage`), works saved for offline and the voice (Cache Storage), and kept Studio productions (encrypted, private file system).
- "Save for offline" asks for persistent storage (`navigator.storage.persist()`) on the first save; where the browser refuses, the saved state still shows, and on iPhone the Home Screen card explains the one-week rule.

## 7. Where the charter asks for more than the design can do well
1. **"Meditations, Book II (inner voice)."** Law 3 reads form only, and Long's text has no italics, indents or labels that mark an inner voice. The engine will perform it in the narrator's telling register with section silences, and the listing says so ("one voice"). Giving it the letter register would need a work-level declaration, which is direction the Repertory does not allow. The design does not pretend otherwise.
2. **Phone to computer in the Studio.** With no account and no upload, a production cannot follow the author from phone to desk. The phone says so and asks them to import the same file on a computer. A Keep file carried by hand is the only bridge, and it is not designed here.
3. **The Seal proves the page, not the device.** It can list what this page and its service worker requested and what the browser blocked. Extensions and the browser's own traffic are invisible to it, and the copy says so rather than claiming more.
4. **The brief's Cave figures are wrong.** The passage is 2,990 words and about 20 minutes, not about 5,000 words and 33 minutes (the brand sheet's listing says 33 MIN). The mocks use the measured numbers.
5. **Locked-phone playback on iOS** can pause for a PWA. The design offers Media Session and a real downloadable file; it cannot make background playback reliable.

## 8. Anti-slop checklist
| # | Question | Repertory | Broadcast | Studio | Seal |
|---|---|---|---|---|---|
| 1 | Template-marketplace look? | No: a programme guide with catalogue numbers and turn maps drawn from the texts | No: a script page with a live line and broadcast VU meters | No: a console with a tuning dial, cue sheet and rule-by-rule report | No: a tuning-eye tube and a raw request log |
| 2 | Every accent semantic? | Pass: amber on actions only; green only on the checked PD basis | Pass: amber live line and actions; tally lamp while live; register hues only on meters | Pass: ochre only on pending corrections and rights; tally only on the render head and lamps | Pass: green eye and pip mean sealed; ochre only on a blocked row |
| 3 | Numerals in the data face? | Pass | Pass | Pass (cue sheet, dial scale, readouts, sizes) | Pass (times, sizes, totals, fingerprints) |
| 4 | Exclaiming or cliché copy? | Pass | Pass (the one "!" is Jowett's, verbatim) | Pass ("Not on sale yet", never "unlock") | Pass |
| 5 | Motion means state? | Pass: rack focus on hover, shimmer on load, the tab wave marks the current room | Pass: needle-drop on the live line, 300 ms VU ballistics, hard cut on register | Pass: needle-drop to cues, dial-drift scrub, render head advance | Pass: valve-warm closing the eye as the record completes |
| 6 | Negative space? | Pass | Pass: one column of text at 68ch | **Watch:** dense by nature at 1280 × 800; three panes scroll separately and the inspector keeps one tab open at a time | Pass |

All four mocks pass `scripts/lint-design.mjs` (no colour literals outside `tokens.css`, no em dashes). Reduced motion: every mock collapses motion through the tokens' reduced-motion block, and scripted motion (the eye, the arch wave, the VU) checks `prefers-reduced-motion` and draws its final state.
