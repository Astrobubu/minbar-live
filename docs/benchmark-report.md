# Measured evidence and limits

Evidence recorded 2026-10-09, reviewed 2026-10-10. Raw local artifacts remain ignored: `benchmark-results/results.json`, `translation-results.json`, and `app-pipeline.json`. This report omits recording paths, account/session identifiers and transcripts. Four supplied recordings produced approximately 9.983-second mono PCM16 24 kHz clips; original recordings were preserved. Each measurement is a small single-run observation, not a service guarantee or accuracy evaluation.

## Engine microbenchmarks

| Workflow | Observed timing | Boundary |
| --- | --- | --- |
| `gpt-live-transcribe`, minimal delay, four clips | First source delta 0.69–0.90 s | Paced API stream; source text, not translated caption |
| `gpt-transcribe`, completed file, four clips | Complete response 0.77–1.82 s | Uploading an already complete ten-second clip |
| `gpt-4o-mini-transcribe`, completed file, four clips | Complete response 1.02–1.28 s | Same completed-file boundary |
| Direct `gpt-realtime-translate`, Arabic → English | First audio 0.865 s; first translated text 1.671 s | Engine comparator, not integrated app behavior |
| Direct `gpt-realtime-translate`, English → Arabic | First audio 0.922 s; first translated text 6.701 s | Engine comparator, not integrated app behavior |
| Text translation after completed ASR | Arabic → English 1.326 s; English → Arabic 0.950 s | Translation time alone excludes ASR and audio collection |

The initial `gpt-realtime-whisper` benchmark rejected the `languages` parameter. A subsequent comparator run used its supported schema and returned results; initial failures remain in the raw evidence. The file response times cannot establish live caption latency, and early translated audio does not establish early translated text.

## Application pipeline baseline

`scripts/benchmark-app.mjs` streams prerecorded audio at wall-clock pace to the real API using a secret minted by a local application server. It posts partials and completed source items through app routes, observes SSE events, calls the application's verification endpoint, and exercises an Arabic WAV upload. It bypasses physical microphone capture, browser WebRTC, browser rendering, listener audio playback and internet hosting.

| Direction | First source delta | First translated caption response | Separate double-check request |
| --- | --- | --- | --- |
| Arabic → English | 1.063 s | 6.489 s | 2.744 s |
| English → Arabic | 0.689 s | 8.770 s | 1.761 s |

Caption timing starts when paced audio begins; it includes audio collection, source completion and app translation. It is the app segment response, not time to rendered pixels. Arabic SSE segment receipt was 6.505 s and English receipt 8.770 s. Verification timing starts at the later verification request and must not be interpreted as total caption latency. Arabic WAV upload returned HTTP 200 with a stored recording and translated segment. No equivalent English upload was repeated.

This baseline forced commits every 3.5 seconds. It visibly fragmented sentences and produced incorrect provisional words in both languages. The later whole-window pass changed those words and reconciled the provisional items. That is evidence of a failure and a correction mechanism; it does not prove the second pass is accurate.

## Natural-pause application comparison — 2026-10-10

The updated `scripts/benchmark-app.mjs` imports the browser's shared `shouldCommit` policy: at least 900 ms speech plus 650 ms quiet, or a 12-second speech ceiling. The fixture uses 100 ms PCM RMS samples with a 0.018 speech threshold and flushes at clip end. It creates a fresh capture ID, observes dynamic completions and verifies the whole clip; no recording upload was repeated. Raw output is `benchmark-results/app-pipeline-natural-pauses.json`; the baseline is preserved separately.

| Direction | Commits / nonempty translated items | First source delta | First translated caption response | Separate double-check |
| --- | --- | --- | --- | --- |
| Arabic → English | 2 / 2 | 0.891 s | 5.796 s | 3.152 s |
| English → Arabic | 4 / 2 | 0.681 s | 11.548 s | 1.870 s |

These results do not establish a latency or accuracy improvement: English caption latency increased and some commits returned empty transcripts. The Arabic provisional text still contained clear word errors, and its whole-window second pass differed materially from the prior run. Shared commit policy alone therefore does not solve transcription quality. The remaining physical microphone/browser test is essential, along with tuning based on independently reviewed reference audio. Browser verification collects at least ten seconds when available, bounds each window at 24 seconds and flushes shorter remaining windows on stop; this harness explicitly verifies its roughly ten-second clip afterward.

## Still to measure

Run the revised natural-pause policy through physical Android microphone capture and browser WebRTC, observe rendered source and translated captions on a second listener, and exercise listen-along playback and disconnect/reconnect behavior. Add independently transcribed and reviewed Arabic/English reference audio before reporting WER, translation faithfulness, recitation accuracy or model rankings. Provider usage exists in some raw responses, but reconciled cost has not been measured. No live Stripe payment or public deployment was exercised.

