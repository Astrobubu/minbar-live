# Evidence and implementation decisions — 2026-10-09

## Current official OpenAI documentation

- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription): `gpt-live-transcribe` is the live baseline, `languages` replaces singular language, adjustable delay levels are not fixed millisecond guarantees, turn_detection must be null, client commits turns. Transcript completions can arrive unordered; item IDs are durable ordering keys. No word timestamps, confidence or speaker labels.
- [File transcription](https://developers.openai.com/api/docs/guides/speech-to-text): `gpt-transcribe` is recorded-audio baseline. 25 MB limit; AAC is not in the supported input list. File streaming emits text while a completed file is processed; it does not establish microphone latency.
- [Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation): dedicated `gpt-realtime-translate` endpoint sends translated audio and input/output transcript deltas continuously. One session per target language, shared by audience. This is a future direct audio interpretation comparator; present slice prioritizes immutable source transcription and controllable text translation.
- [GPT-Realtime-Whisper](https://developers.openai.com/api/docs/models/gpt-realtime-whisper) is a documented realtime-transcription candidate; benchmarks record actual account/schema access errors rather than silently substitute.
- [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc): client secrets minted server-side, normal API key never exposed. Browser transport posts SDP to realtime calls endpoint.

## QuranRAG inspection

Reviewed user's exact [Astrobubu/QuranRAG](https://github.com/Astrobubu/QuranRAG), default master branch, read-only. [processor.ts](https://github.com/Astrobubu/QuranRAG/blob/master/src/lib/processor.ts) auto-annotates at 0.5 despite README 0.7, computes chunk offsets assuming two separators despite trimming, uses first global `indexOf` for repeated quote replacement, trusts model-generated match_index, and searches model-corrected text plus context. [rag.ts](https://github.com/Astrobubu/QuranRAG/blob/master/src/lib/rag.ts) mixes Quran and Hadith vector search results; lexical helper is ordinary full-text search rather than normalized alignment. [openai.ts](https://github.com/Astrobubu/QuranRAG/blob/master/src/lib/openai.ts) uses older gpt-4-turbo-preview and asks for guesses. [seed-hadith.ts](https://github.com/Astrobubu/QuranRAG/blob/master/scripts/seed-hadith.ts) falls back to six sample narrations; API collection fetch has no pagination handling. These observations explain risks, not measured failure rates.

Present matcher uses corpus evidence and immutable Arabic source text. Hadith is queued for source-corpus and human verification. No generated religious citations replace speaker wording.

## Corpus provenance

Official [Tanzil download](https://tanzil.net/pub/download/index.php), Simple 1.1, 6236 numbered records; verbatim text and notice retained. SHA256 C8C2EA9E004CF3F4B7AFC5BA00DE859556F4ED09BD9CF5D1BC79E877406EF678. Search normalization never overwrites corpus. License: [Tanzil Text License](https://tanzil.net/docs/Text_License), attribution and link required, text changes forbidden. No English translation corpus is bundled yet.

## Benchmark boundaries

Four explicitly supplied Arabic/English recordings only; Turkish deferred. Ten-second initial clips resampled to mono PCM16 24kHz; original AAC files untouched. Compare file-upload elapsed time separately from wall-clock-paced live first-delta and post-audio-final latency. Models: gpt-transcribe file; gpt-4o-mini-transcribe file comparator; gpt-live-transcribe minimal/low; gpt-realtime-whisper low. Tests use no quote answer hints. Real model errors are retained. Without independently verified reference text, WER/faithfulness or religious-recitation accuracy cannot be measured. Quantitative prices are not invented; provider usage recorded when returned, bill reconciliation pending.

## Remaining service work

Private opaque owner tokens and a single-host cost gate support this local app. Local account identity, account-bound session ownership, optional Stripe checkout, signature-verified subscription webhooks, request allowances and session-duration limits are now implemented. Email verification/recovery, provider-cost reconciliation and venue approvals remain incomplete. HTTPS public origin, actual Android mic tests and large room fanout remain unverified. See [benchmark report](benchmark-report.md) for measured application behavior.

## Hadith corpus feasibility — reviewed 2026-10-10

No sourced Hadith corpus is bundled; detections remain review requests with no invented reference or grade.

[HadeethEnc's official API repository](https://github.com/islamhouse-dev/hadith-api) documents language, category, paginated Hadith-list and detail endpoints. Its [publisher terms](https://hadeethenc.com/en/home) permit republishing translations subject to preserving content and document information, attribution, version identification, updates and appropriate presentation. This provides a plausible curated Arabic/English source, but is not evidence of complete collection coverage. A future ingestion must preserve source IDs, wording, attribution, source-provided references/grades and language/version provenance; build normalization separately and establish how version updates are tracked. If API data lacks required version metadata, obtain publisher clarification before distributing it. No data was bulk downloaded or integrated here.

[Sunnah.com's developer page](https://sunnah.com/developers) states its API covers a checked portion of its data and requires an API key requested through its repository; an offline dump is described as not yet available. API access is not itself an unrestricted corpus redistribution license. Confirm explicit rights and source metadata before using it for a bundled corpus. An open-source API implementation's software license does not establish rights to its underlying translations.

The practical next option is a small attributed HadeethEnc pilot with publisher metadata preserved, independently reviewed phrase matches and ambiguous results routed to human review. A complete or authoritative automatic Hadith verification claim is unsupported by the current implementation or these sources.

## Default pipeline judgment — 2026-10-10

The requirement combines Arabic/English source preservation, early output and a GPT-Transcribe second pass. The measured default remains `gpt-live-transcribe` source partials, natural-pause source commits, app text translation and audio-window GPT-Transcribe revisions. This retains source item history and source-based scripture matching. It is an architectural choice, not a demonstrated accuracy winner. Natural-pause trials still contained serious errors; English first translated text was 11.548 seconds. Do not promise consistently fast or correct final translations from these runs.

| Enumerated option | Evidence and consequence | Decision |
| --- | --- | --- |
| Source ASR → translated captions → GPT-Transcribe window revisions | Durable source items, app SSE and revision reconciliation exercised; provisional text inaccurate; second pass variable | Keep as current default with visible provisional/revision labels |
| Direct realtime audio translation | First output audio around 0.9 seconds; translated text 1.671 seconds Arabic and 6.701 seconds English; text contained errors | Separate experimental interpretation mode; does not replace source preservation or canonical checks |
| Wait for complete/window file ASR before showing anything | Simpler review boundary, but withholds source feedback until audio collection finishes | Optional delayed-review mode, unsuitable as sole live feedback |

For translated listening, prefer speaking the revised translation after its source audio double-check, while displaying provisional captions promptly. This avoids speaking every known-unstable live draft, but adds audio collection and verification delay, and does not guarantee correctness. The browser now implements this gate: translated speech consumes double-checked items or labelled demo samples, and revision events speak the canonical translation. Physical playback remains to verify. Direct translated audio was timed but not listened to or independently rated; text errors cannot quantify the audio's quality. Original audio listening preserves the speaker's actual voice and must remain distinctly labelled.

The Jev routing skill was read for this bounded choice. Neither its MCP tools nor its CLI were available to this delegated agent, so no Jev verdict was obtained; the above is explicit engineering judgment from the saved measurements. Before switching the default, compare both approaches on independently reviewed Arabic/English references and on the actual browser/Android capture path.
