# Minbar Live — UI rebuild spec (2026-10-11)

Goal: a working **live demo** with three clear, purpose-built screens. Live API usage is fine (OPENAI_API_KEY is in the shell env; `.env` has `LOCAL_DEVELOPMENT=true`).

## Product rules
- One room = one khutbah. Khatib speaks in a **source language** (default `ar`).
- Every final segment is translated server-side into **all of the room's target languages** (always on, no toggle). Default targets for an Arabic room: `en`. For an English room: `ar`. Supported codes: `ar, en, ur, id, fr, tr` (names shown natively). Khatib picks targets at creation (multi-select, default = the "other" of ar/en).
- **Each viewer picks the language they read.** Hall screen default = first target language (e.g. Arabic speech → English on screen). Phone default = first target, switchable to any target or the original.
- Two ways to feed audio, both go through the SAME realtime pipeline (WebRTC `gpt-live-transcribe` → commit policy → `/segments` → translation):
  1. **Microphone** — press Start, speak.
  2. **Play audio as live** — pick a bundled sample sermon or any local audio file; it plays out loud on the khatib device AND is streamed as the source `MediaStream` (use `<audio>` + `AudioContext.createMediaElementSource` → `MediaStreamDestination`, also connected to `ctx.destination` so it is audible). Pause/stop supported. This is how the demo runs without speaking.
- File upload as one batch (`/audio`) stays available as a secondary "Transcribe a file (not live)" action.

## Screens (separate HTML entry points, shared JS core)
| URL | Who | Purpose |
|---|---|---|
| `/` | anyone | Home: **Start a khutbah** (title, spoken language, target languages, public/private) → goes to khatib console. **Join** by room code. **Recent rooms** on this device (from localStorage) with links to each screen + export. **Try the demo** = creates a room and opens the khatib console with the sample preselected. |
| `/khatib.html?room=ID` | khatib / operator | Control console. Big primary control: **Start microphone** / **Play sample** (sample picker + file picker) / Stop. Live status (Connecting / Listening / Paused / Error with reason), mic level meter, elapsed time. Live panel: own transcript (draft line in grey, finals solid) with translation under each line in the first target language. **Share** panel: hall-screen link (opens in new window), phone link + QR, room code. End khutbah. Export TXT/JSON. If owner token missing → explain clearly + link to listen view. |
| `/screen.html?room=ID&lang=en` | projector / TV in the hall | Fullscreen, dark, huge high-contrast captions in the chosen language: last 2–3 translated lines, newest at bottom, smooth fade/slide-in, proper RTL for ar/ur. Optional small original-language line (toggle `&source=1`). Corner: room title, live dot, QR + "Read on your phone". Waiting state ("The khutbah will appear here") and ended state. Tiny auto-hiding settings button (language, show source, text size, fullscreen). No other chrome. |
| `/listen.html?room=ID` | phone attendee | Mobile-first reader. Sticky top bar: title, live dot, language selector (targets + "Original"), text size A-/A+. Scrolling feed of segments in chosen language (optionally original under it, small). Auto-scroll that pauses when user scrolls up + "Jump to live" pill. Draft/partial shown as faded "…" line only when viewing original. Optional "Listen to original audio" toggle (existing `audio` SSE relay). Works on 360px width. |

Old `?room=&as=imam|screen|listen` URLs on `/` must redirect to the new pages.

## UI language
Interface strings bilingual ar/en (toggle, persisted). Arabic UI = `dir="rtl"`. Fonts from Google Fonts: "IBM Plex Sans Arabic" (+ "Inter" for Latin). Caption text direction follows the *caption* language, not the UI language.

## Visual direction
Calm, dignified, legible. Light theme for home/khatib/listen (warm off-white, deep green `#0f5132`-ish accent, gold hairline accent), dark theme for hall screen (near-black `#0b0f0d`, captions off-white, accent green). No clutter, generous spacing, large touch targets (≥48px). CSS custom properties in `public/css/base.css`; each page has its own CSS file.

## Non-goals for this pass
Accounts/billing/profiles UI (server routes stay untouched and must keep working). Hosting.

## Must keep
`npm test` green (update tests where behavior intentionally changes). No secrets committed. `.gitignore` keeps `mcp.json`, `.env*`, `.data/`, `public/samples/`.
