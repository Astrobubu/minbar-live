// Minbar live capture: a thin, event-driven wrapper around the existing realtime pipeline.
//
//   import { createCapture, uploadAudioFile } from '/js/capture.mjs';
//
//   const cap = createCapture({ sessionId });
//   cap.on('status',  ({ state, reason, attempt }) => {});  // see STATES below
//   cap.on('level',   level => {});                          // 0..1, ~15 Hz while audio is flowing
//   cap.on('partial', ({ itemId, text }) => {});             // draft (not yet committed) source text
//   cap.on('final',   ({ text, segment, verified }) => {});  // committed line (verified = double-checked revision)
//   cap.on('error',   ({ code, message, fatal }) => {});     // see ERROR CODES
//   cap.on('notice',  ({ level: 'info'|'warn', message }) => {}); // non-fatal remarks from the pipeline
//
//   await cap.start({ kind: 'mic' });                        // microphone
//   await cap.start({ kind: 'file', audio: audioElement }); // play audio AS LIVE (audible here AND streamed)
//   cap.pause(); cap.resume(); await cap.stop();
//
// STATES: idle | connecting | listening | paused | stopping | stopped | error
// ERROR CODES: mic-denied, mic-missing, mic-failed, audio-failed, no-owner, host-key, no-live, ended,
//              realtime, network, timeout, connection, unknown
//
// What lives where: realtime.js (unchanged) owns the WebRTC session, ephemeral-key request
// (POST /api/sessions/:id/realtime), commit policy, partial posting (/partials, throttled to 2/s),
// final posting (/segments with itemId/previousItemId), original-audio relay (/audio-live, PCM16 24k)
// and the double-check flow (/verify). This module owns what surrounds it: acquiring the source stream
// (microphone, or an <audio> element routed through Web Audio), level metering, pause/resume,
// error classification, and automatic reconnects. The ephemeral key lives 60 s and is only used to open
// the connection, so "expiry" is handled by simply requesting a fresh one on every (re)connect.

import { startTranscription } from '/realtime.js';
import { ensureLocalAccess, ownerToken as storedOwnerToken, api } from './core.mjs';

const MAX_RECONNECTS = 3;
const HOST_KEY_STORAGE = 'minbar-host-key'; // same key core.mjs api() uses
const readHostKey = () => { try { return localStorage.getItem(HOST_KEY_STORAGE) || ''; } catch { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AudioCtx = () => window.AudioContext || window.webkitAudioContext;

/** Map an Error (or message) from the pipeline / server / browser to a stable `code`. */
export function classifyError(err) {
  const name = err?.name || '';
  const message = String(err?.message ?? err ?? '');
  const code = (() => {
    if (name === 'NotAllowedError' || name === 'SecurityError' || /permission denied|not allowed/i.test(message)) return 'mic-denied';
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || /requested device not found/i.test(message)) return 'mic-missing';
    if (name === 'NotReadableError' || name === 'AbortError' && /media|device/i.test(message)) return 'mic-failed';
    if (/APP_ACCESS_TOKEN|host access key|host key/i.test(message) || err?.status === 403) return 'host-key';
    if (/Host authorization required/i.test(message) || err?.status === 401) return 'no-owner';
    if (/OPENAI_API_KEY|Configure a project/i.test(message) || err?.status === 503) return 'no-live';
    if (/session has ended|time limit|non-demo session/i.test(message)) return 'ended';
    if (/Realtime connection failed/i.test(message)) return 'realtime';
    if (name === 'TimeoutError' || /did not respond|timed out|timeout/i.test(message)) return 'timeout';
    if (/failed to fetch|networkerror|load failed|network error|offline/i.test(message) || err?.status === 0) return 'network';
    return 'unknown';
  })();
  return { code, message };
}

/* ------------------------------------------------------------ source feeds */

// One AudioContext + MediaElementSource per <audio> element (the browser allows createMediaElementSource only once).
const fileFeeds = new WeakMap();
function fileGraph(audio) {
  let g = fileFeeds.get(audio);
  if (!g) {
    const ctx = new (AudioCtx())();
    const node = ctx.createMediaElementSource(audio);
    node.connect(ctx.destination); // audible on this device
    g = { ctx, node };
    fileFeeds.set(audio, g);
  }
  return g;
}

/** Microphone feed. Throws a classified Error when the mic cannot be opened. */
async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('Microphone is not available in this browser (HTTPS or localhost is required).'), { name: 'NotFoundError' });
  const stream = await Promise.race([
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('Microphone permission or device did not respond within 20 seconds.'), { name: 'TimeoutError' })), 20000))
  ]);
  const ctx = new (AudioCtx())();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const track = stream.getAudioTracks()[0];
  return {
    kind: 'mic', stream, analyser,
    start() {},
    pause() { track.enabled = false; },
    resume() { track.enabled = true; },
    close() { stream.getTracks().forEach(tr => tr.stop()); ctx.close().catch(() => {}); }
  };
}

/** File feed: `audio` plays audibly AND is mirrored into a MediaStream for the pipeline. */
async function openFile(audio) {
  if (!audio) throw Object.assign(new Error('No audio element.'), { name: 'AudioError' });
  const { ctx, node } = fileGraph(audio);
  await ctx.resume().catch(() => {}); // runs inside the Start click's user activation
  const dest = ctx.createMediaStreamDestination();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  node.connect(dest);
  node.connect(analyser);
  return {
    kind: 'file', stream: dest.stream, analyser,
    start() { return audio.play(); },       // called by the pipeline once the data channel is open
    pause() { audio.pause(); },
    resume() { return audio.play(); },
    close() { try { node.disconnect(dest); node.disconnect(analyser); } catch { /* already gone */ } dest.stream.getTracks().forEach(tr => tr.stop()); }
  };
}

/* ------------------------------------------------------------------ capture */

/**
 * @param {object} opts
 * @param {string} opts.sessionId   room id
 * @param {string} [opts.ownerToken] defaults to this device's stored owner token for the room
 * @param {string} [opts.model]     'gpt-live-transcribe' (default) | 'gpt-transcribe'
 * @param {string} [opts.delay]     realtime delay hint, default 'low'
 */
export function createCapture({ sessionId, ownerToken, model = 'gpt-live-transcribe', delay = 'low' } = {}) {
  const listeners = { status: new Set(), level: new Set(), partial: new Set(), final: new Set(), error: new Set(), notice: new Set() };
  const emit = (name, value) => { for (const fn of [...listeners[name]]) { try { fn(value); } catch (e) { console.error(`[capture] ${name} listener failed`, e); } } };

  let state = 'idle', source = null, audioEl = null, feed = null, rec = null;
  let generation = 0, attempts = 0, cancelled = false, stopPromise = null, levelTimer = null, level = 0;
  let audioListeners = null;

  const setState = (next, extra = {}) => { state = next; emit('status', { state, ...extra }); };
  const fail = (err, { fatal = true } = {}) => {
    const { code, message } = err?.code && err?.message !== undefined && !err.name ? err : classifyError(err);
    emit('error', { code, message, fatal });
    return code;
  };

  function startLevel() {
    stopLevel();
    const analyser = feed?.analyser;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    levelTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const raw = state === 'listening' ? Math.min(1, Math.sqrt(rms) * 1.7) : 0;
      level = raw > level ? raw : level * 0.8; // fast attack, slow release
      emit('level', level < 0.01 ? 0 : level);
    }, 66);
  }
  function stopLevel() { clearInterval(levelTimer); levelTimer = null; level = 0; emit('level', 0); }

  function watchAudio() {
    unwatchAudio();
    if (source !== 'file' || !audioEl) return;
    const onPause = () => { if (state === 'listening' && !audioEl.ended) setState('paused'); };
    const onPlay = () => { if (state === 'paused') setState('listening'); };
    const onEnded = () => { void stop({ reason: 'file-ended' }); };
    const onError = () => { fail({ code: 'audio-failed', message: 'The audio file could not be played.' }); void stop({ reason: 'audio-failed' }); };
    audioEl.addEventListener('pause', onPause);
    audioEl.addEventListener('play', onPlay);
    audioEl.addEventListener('ended', onEnded);
    audioEl.addEventListener('error', onError);
    audioListeners = () => { for (const [n, f] of [['pause', onPause], ['play', onPlay], ['ended', onEnded], ['error', onError]]) audioEl.removeEventListener(n, f); };
  }
  function unwatchAudio() { audioListeners?.(); audioListeners = null; }

  function teardownFeed() {
    stopLevel();
    try { feed?.close(); } catch { /* ignore */ }
    feed = null;
  }

  function onPipelineStatus(gen, message) {
    if (gen !== generation) return; // a previous (replaced) connection
    if (/^Connecting/i.test(message)) return;
    if (/^Listening$/i.test(message)) { attempts = 0; if (state === 'connecting') setState('listening'); return; }
    if (/Connection interrupted/i.test(message)) { void recover(); return; }
    if (/session has ended|time limit/i.test(message)) { fail({ code: 'ended', message }); void stop({ reason: 'ended' }); return; }
    if (/^Stopped —/i.test(message)) { if (/incomplete/i.test(message)) emit('notice', { level: 'warn', message }); return; }
    const warn = /unavailable|dropped|expired|incomplete|pending|interrupted|failed|retain|reached/i.test(message);
    emit('notice', { level: warn ? 'warn' : 'info', message, verified: /double-checked with/i.test(message) });
  }
  function onPipelineTranscript(event) {
    if (event.final) emit('final', { text: event.text, segment: event.segment, verified: Boolean(event.verified) });
    else emit('partial', { itemId: event.itemId, text: event.text });
  }

  /** Open the source and the realtime session. Throws classified errors. */
  async function connect() {
    const gen = ++generation;
    setState('connecting', attempts ? { reason: 'reconnecting', attempt: attempts } : {});
    await ensureLocalAccess(); // loopback operator cookie (no-op where unavailable)
    feed = source === 'file' ? await openFile(audioEl) : await openMic();
    startLevel();
    const token = ownerToken || storedOwnerToken(sessionId);
    try {
      const started = await startTranscription({
        sessionId, ownerToken: token, hostKey: readHostKey(), model, delay,
        sourceStream: feed.stream,
        sourceStart: () => { if (gen === generation) Promise.resolve(feed?.start()).catch(e => { fail({ code: 'audio-failed', message: e?.message || 'Playback was blocked.' }); void stop({ reason: 'audio-failed' }); }); },
        onStatus: m => onPipelineStatus(gen, m),
        onTranscript: onPipelineTranscript
      });
      if (gen !== generation || cancelled) { await started.stop().catch(() => {}); return; }
      rec = started;
    } catch (e) {
      teardownFeed();
      throw e;
    }
  }

  /** The connection dropped mid-session: reconnect with a fresh ephemeral key (up to MAX_RECONNECTS times). */
  async function recover() {
    if (state === 'stopping' || state === 'stopped' || state === 'idle' || state === 'error') return;
    const old = rec; rec = null;
    generation++; // ignore any further callbacks from the dead connection
    feed?.pause?.();
    teardownFeed();
    old?.stop().catch(() => {}); // flush what can still be flushed, in the background
    if (attempts >= MAX_RECONNECTS) {
      fail({ code: 'connection', message: 'The connection to live transcription was lost.' });
      setState('error', { reason: 'connection' });
      return;
    }
    attempts++;
    setState('connecting', { reason: 'reconnecting', attempt: attempts });
    await sleep(1200 * attempts);
    if (cancelled || state !== 'connecting') return;
    try { await connect(); } catch (e) { const code = fail(e); setState('error', { reason: code }); }
  }

  async function start({ kind = 'mic', audio } = {}) {
    if (!['idle', 'stopped', 'error'].includes(state)) return;
    source = kind === 'file' ? 'file' : 'mic';
    audioEl = source === 'file' ? audio : null;
    cancelled = false; attempts = 0; stopPromise = null;
    watchAudio();
    // Create + resume the audio graph synchronously, while the Start click's user activation is fresh.
    if (source === 'file' && audioEl) { try { fileGraph(audioEl).ctx.resume().catch(() => {}); } catch (e) { fail(e); setState('error', { reason: 'audio-failed' }); return; } }
    if (source === 'file' && audioEl?.ended) audioEl.currentTime = 0;
    try { await connect(); }
    catch (e) {
      if (cancelled) return; // stop() was pressed while connecting
      const code = fail(e);
      unwatchAudio();
      setState('error', { reason: code });
    }
  }

  function pause() { if (state === 'listening') { feed?.pause(); if (feed?.kind === 'mic') setState('paused'); } }
  function resume() {
    if (state !== 'paused') return;
    Promise.resolve(feed?.resume()).catch(e => fail({ code: 'audio-failed', message: e?.message || 'Playback was blocked.' }, { fatal: false }));
    if (feed?.kind === 'mic') setState('listening');
  }

  async function stop({ reason } = {}) {
    if (stopPromise) return stopPromise;
    if (state === 'idle' || state === 'stopped') return;
    cancelled = true;
    stopPromise = (async () => {
      const wasError = state === 'error';
      if (!wasError) setState('stopping', reason ? { reason } : {});
      unwatchAudio();
      feed?.pause?.();   // silence reaches the pipeline, so the commit policy flushes the last phrase
      const current = rec; rec = null;
      try { await current?.stop(); } catch (e) { emit('notice', { level: 'warn', message: e?.message || 'Stopped with errors.' }); }
      teardownFeed();
      generation++;
      setState(wasError ? 'error' : 'stopped', reason ? { reason } : {});
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }

  return {
    on(name, fn) { listeners[name]?.add(fn); return () => listeners[name]?.delete(fn); },
    start, pause, resume, stop,
    get state() { return state; },
    get kind() { return source; }
  };
}

/* ------------------------------------------------------- batch file upload */

/**
 * "Transcribe a file (not live)": POST the whole recording to /audio; the server transcribes and
 * translates it as one segment. Resolves to the API response ({segment, ...}).
 */
export function uploadAudioFile(sessionId, file) {
  if (file.size > 25 * 1024 * 1024) throw Object.assign(new Error('File is larger than 25 MB.'), { code: 'too-large' });
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/audio`, {
    method: 'POST',
    owner: sessionId,
    body: file,
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
      'X-Recording-Consent': 'true'
    }
  });
}
