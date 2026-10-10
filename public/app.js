const $ = (selector) => document.querySelector(selector);
const e = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let profiles = [];
let selectedProfile = null;
let roomError = '';
const audioSources = new Set();
let draft = null;
let accountRoomIds = new Set();
let followLatest = true;
let transcriptScroll = 0;
let recordingStatus = 'Ready';
let starting = false;
let config = {};
let session = null;
let segments = [];
let view = 'home';
let role = 'imam';
let stream;
let rec;
let hostKey = '';
let archiveRecording = false;
let listening = false;
let roomLocation = null;
let audioContext = null;
let audioUntil = 0;
let originalAudio = false;
let audioSequence = null;
let moreOpen = false;
let textScale = Number(localStorage.getItem('minbar-scale')) || 1;
const revealed = new Map();
let booted = false;
const WORD_STAGGER = 80;
const WORD_FADE = 1200;
document.documentElement.style.setProperty('--scale', textScale);

const owners = () => JSON.parse(localStorage.getItem('minbar-rooms') || '{}');
const token = () => owners()[session?.id]?.ownerToken;
const isHost = () => Boolean(session && (token() || accountRoomIds.has(session.id)));
const languageName = (code) => (code === 'en' ? 'English' : 'Arabic');
const targetLanguage = () => session?.language || (session?.sourceLanguage === 'en' ? 'ar' : 'en');
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.style.display = 'block';
  setTimeout(() => { node.style.display = 'none'; }, 4500);
}
const act = (fn) => async () => {
  try { await fn(); } catch (err) { toast(err.message); }
};

async function api(path, options = {}) {
  if ($('#host-key')) hostKey = $('#host-key').value || hostKey;
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(hostKey ? { 'X-Host-Key': hostKey } : {}),
      ...options.headers
    }
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Request failed');
  return data;
}

function statusLine() {
  if (session?.status === 'ended') return 'Session ended';
  if (session?.isDemo) return 'Saved sample. Start a new room for a microphone.';
  return recordingStatus;
}

function liveLabel() {
  if (!session) return 'Ready';
  if (session.status === 'ended') return 'Ended';
  if (rec) return 'Listening';
  if (session.status === 'live') return 'Live';
  return 'Ready';
}

function controls() {
  const blocked = !config.liveAvailable;
  return `<aside class="desk">
      <p class="kicker">Imam</p>
      <h2>Start a recording</h2>
      <p class="lede">This desk transcribes what is spoken. Translation is a separate step, during or after the sermon.</p>
      <fieldset class="choice">
        <legend>Spoken language</legend>
        <label class="choice-card"><input type="radio" name="source" value="ar" checked><span><b lang="ar">العربية</b><small>transcribed in Arabic</small></span></label>
        <label class="choice-card"><input type="radio" name="source" value="en"><span><b>English</b><small>transcribed in English</small></span></label>
      </fieldset>
      <label class="field" for="title">Session name</label>
      <input id="title" placeholder="Friday sermon" maxlength="120">
      <fieldset class="segmented">
        <legend>Who else can watch</legend>
        <label><input type="radio" name="kind" value="venue" checked><span>Hall and phones</span></label>
        <label><input type="radio" name="kind" value="personal"><span>This desk only</span></label>
      </fieldset>
      <p class="hint" id="privacy-copy">The hall screen and a phone QR can open the transcript. They cannot control the recording.</p>
      <details>
        <summary>Options</summary>
        ${profiles.length ? `<label class="field" for="profile">Venue or speaker</label><select id="profile"><option value="">No profile</option>${profiles.map((p) => `<option value="${e(p.id)}">${e(p.name)}</option>`).join('')}</select>` : ''}
        <label class="check"><input id="archive-create" type="checkbox" disabled> Save the microphone audio on this server</label>
        <button type="button" id="location" class="quiet full">Add approximate venue location</button>
        <p class="hint" id="location-status">Location stays off until you add it. Hall sessions only.</p>
        ${config.localDevelopmentAvailable ? '' : `<label class="field" for="host-key">Host access key</label><input id="host-key" type="password" autocomplete="off" placeholder="Configured host key"><p class="hint">Kept in this tab only.</p>`}
      </details>
      <div class="stack">
        <button type="button" id="create" class="primary full" ${blocked ? 'disabled' : ''}>Start recording</button>
      </div>
      <p class="hint">${blocked ? 'This server has no OpenAI project key yet. Add OPENAI_API_KEY and refresh.' : 'Audio is sent to OpenAI for transcription. A second pass may revise the wording. Translation is not included until you ask for it.'}</p>
    </aside>`;
}

function controlBar() {
  const status = `<span class="control-status"><i class="dot ${rec ? 'on' : ''}"></i><span id="record-status">${e(statusLine())}</span><span class="meta">· ${e(languageName(session.sourceLanguage))}</span></span>`;
  if (session.isDemo) return `<div class="control-bar">${status}</div>`;
  if (session.status === 'ended') {
    return `<div class="control-bar">${status}<button type="button" id="new" class="rec-btn start">New recording</button></div>`;
  }
  const translating = Boolean(session.translationEnabled);
  return `<div class="control-bar">
    ${status}
    ${session.visibility === 'public' ? '<button type="button" id="open-screen" class="secondary">Hall screen</button><button type="button" id="join" class="secondary">Listener QR</button>' : ''}
    <button type="button" id="${translating ? 'translate-off' : 'translate'}" class="switch ${translating ? 'on' : ''}" role="switch" aria-checked="${translating}">Translate to ${e(languageName(targetLanguage()))}<i class="knob"></i></button>
    <button type="button" id="end" class="quiet" ${starting ? 'disabled' : ''}>End session</button>
    ${rec
      ? `<button type="button" id="stop" class="rec-btn" ${starting ? 'disabled' : ''}><i class="dot on"></i>Stop recording</button>`
      : `<button type="button" id="start" class="rec-btn start" ${starting ? 'disabled' : ''}>Start recording</button>`}
  </div>`;
}

function deskMore() {
  const hostKeyField = !config.localDevelopmentAvailable
    ? `<label class="field" for="host-key">Host access key</label><input id="host-key" type="password" autocomplete="off" placeholder="Configured host key" value="${e(hostKey)}"><p class="hint">Kept in this tab only.</p>`
    : '';
  return `<details class="desk-more" id="desk-more" ${moreOpen ? 'open' : ''}>
    <summary>Full transcript and tools</summary>
    <div class="tools">
      <button type="button" id="original" class="quiet" ${session.isDemo ? 'disabled' : ''}>${originalAudio ? 'Stop original' : 'Original audio'}</button>
      ${session.translationEnabled ? `<button type="button" id="listen" class="quiet">${listening ? 'Stop voice' : 'Read translation'}</button>` : ''}
      <button type="button" id="follow" class="quiet">${followLatest ? 'Pause following' : 'Follow latest'}</button>
      <button type="button" id="export" class="quiet">Export</button>
      <button type="button" id="insights" class="quiet">Summary</button>
      ${session.status === 'ended' ? '' : '<button type="button" id="new" class="quiet">New recording</button>'}
    </div>
    <div class="transcript" id="transcript">${transcriptMarkup()}</div>
    ${session.isDemo ? '<p class="hint">This is an old sample room. It cannot take a microphone.</p>' : `<div class="desk-input">
      ${hostKeyField}
      <label class="field" for="manual">Type a passage</label>
      <textarea id="manual" placeholder="Arabic or English, as spoken"></textarea>
      <button type="button" id="send" class="secondary full">Add to transcript</button>
      <label class="field" for="audio">${session.kind === 'personal' ? 'Upload a recording to keep' : 'Upload audio to transcribe'}</label>
      <input id="audio" type="file" accept="audio/*">
      <label class="check"><input id="archive-audio" type="checkbox" ${session.kind === 'personal' ? '' : 'disabled'}> Save microphone audio. Available for a private recording only.</label>
      <p class="hint">Uploaded audio goes to the transcription provider. Saved files follow the server retention period.</p>
      ${(session.recordings || []).map((r) => `<div class="recording"><span>Audio · ${e(new Date(r.createdAt).toLocaleDateString())}</span><span><button type="button" class="quiet" data-download="${e(r.id)}">Download</button> <button type="button" class="quiet" data-delete="${e(r.id)}">Delete</button></span></div>`).join('')}
    </div>`}
  </details>`;
}

function passage(item, { draftItem = false } = {}) {
  const source = item.sourceLanguage || session?.sourceLanguage || 'ar';
  const target = session?.language || (source === 'ar' ? 'en' : 'ar');
  const sourceText = item.text || '';
  const translation = item.translation || '';
  const sourceClass = source === 'ar' ? 'arabic' : 'english';
  const targetClass = target === 'ar' ? 'arabic' : 'english';
  const checked = item.status === 'double-checked';
  const label = draftItem ? 'Draft' : checked ? 'Revised' : 'Live';
  const citations = (item.citations || []).map((c) => `<a class="citation" ${/^https:\/\//.test(c.sourceUrl || '') ? `href="${e(c.sourceUrl)}" target="_blank" rel="noopener"` : ''}>${e(c.reference)} · ${c.kind === 'quran' ? 'Quran text match' : e(c.matchType || 'Possible match')}<span dir="rtl" lang="ar">${e(c.arabic)}</span><span>A text match is not certainty of attribution.</span></a>`).join('');
  return `<article class="passage ${draftItem ? 'drafting' : ''}">
    <header><time>${draftItem ? 'Now' : new Date(item.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span class="tag ${draftItem ? 'draft' : ''}">${label}</span></header>
    <p class="${sourceClass}" lang="${source}" dir="${source === 'ar' ? 'rtl' : 'ltr'}">${e(sourceText)}</p>
    ${session?.translationEnabled && translation ? `<p class="${targetClass}" lang="${target}" dir="${target === 'ar' ? 'rtl' : 'ltr'}">${e(translation)}</p>` : ''}
    ${citations}
  </article>`;
}

function transcriptMarkup() {
  const body = `${segments.map((item) => passage(item)).join('')}${draft ? passage(draft, { draftItem: true }) : ''}`;
  if (body) return body;
  if (roomError) return `<div class="waiting"><strong>This room did not open.</strong><p>${e(roomError)}</p></div>`;
  if (!session) return '';
  if (session.status === 'ended') return `<div class="waiting"><strong>Nothing was captured.</strong><p>This session has ended.</p></div>`;
  return `<div class="waiting"><strong>Waiting for speech.</strong><p>Speak in ${languageName(session.sourceLanguage)}. The transcript appears here. Translation stays off until you turn it on.</p></div>`;
}

function applyRole() {
  document.body.classList.remove('role-imam', 'role-screen', 'role-listen', 'screen', 'dark');
  document.body.classList.add(role === 'screen' ? 'role-screen' : role === 'listen' ? 'role-listen' : 'role-imam');
}

function wordsMarkup(text, key, animate) {
  const parts = String(text || '').split(/\s+/).filter(Boolean);
  const now = performance.now();
  let times = revealed.get(key);
  if (!times) {
    times = animate ? [] : parts.map(() => 0);
    revealed.set(key, times);
  }
  let fresh = 0;
  return parts.map((word, index) => {
    if (times[index] === undefined) times[index] = now + Math.min(fresh++, 10) * WORD_STAGGER;
    const age = now - times[index];
    if (!times[index] || age > WORD_FADE) return `<span class="w">${e(word)}</span>`;
    return `<span class="w new" style="animation-delay:${Math.round(-age)}ms">${e(word)}</span>`;
  }).join(' ');
}

function caption(item, { current = false, draftItem = false, inline = false } = {}) {
  const source = item.sourceLanguage || session?.sourceLanguage || 'ar';
  const target = targetLanguage();
  const rtl = source === 'ar';
  const translation = inline && session?.translationEnabled && item.translation
    ? `<p class="sub-translation" lang="${target}" dir="${target === 'ar' ? 'rtl' : 'ltr'}">${e(item.translation)}</p>`
    : '';
  return `<article class="sub ${current ? 'current' : 'earlier'}" dir="${rtl ? 'rtl' : 'ltr'}">
    <p class="${rtl ? 'arabic' : 'english'}" lang="${source}">${wordsMarkup(item.text, item.itemId || item.id || 'draft', current && booted)}${draftItem ? '<span class="caret"></span>' : ''}</p>
    ${translation}
  </article>`;
}

function subtitleMarkup(limit, inline) {
  const history = segments.filter((item) => item.text).slice(-limit);
  const lines = [];
  if (draft?.text) {
    history.slice(-(limit - 1)).forEach((item) => lines.push(caption(item, { inline })));
    lines.push(caption(draft, { current: true, draftItem: true, inline }));
  } else if (history.length) {
    history.slice(0, -1).forEach((item) => lines.push(caption(item, { inline })));
    lines.push(caption(history.at(-1), { current: true, inline }));
  }
  return lines.join('');
}

function bandMarkup() {
  if (!session?.translationEnabled) return '';
  const target = targetLanguage();
  const latest = [...segments].reverse().find((item) => item.translation);
  return `<div class="band">
    <span class="band-label">Translation · ${e(languageName(target))}</span>
    <p lang="${target}" dir="${target === 'ar' ? 'rtl' : 'ltr'}">${latest ? e(latest.translation) : 'Appears after each finished sentence.'}</p>
  </div>`;
}

function stageBody() {
  const inline = role === 'listen';
  const lines = subtitleMarkup(role === 'listen' ? 6 : 3, inline);
  if (lines) return `<div class="lines">${lines}</div>${inline ? '' : bandMarkup()}`;
  const ended = session.status === 'ended';
  const title = ended ? 'This session has ended.'
    : role !== 'imam' ? 'Waiting for the imam.'
    : rec ? 'Listening. Start speaking.' : 'Press Start recording.';
  const note = session.translationEnabled
    ? `Translation into ${languageName(targetLanguage())} is on.`
    : role === 'imam' ? 'The words appear here as subtitles the moment they are spoken.' : 'Subtitles appear here as the imam speaks.';
  return `<div class="stage-wait"><strong>${e(title)}</strong><p>${e(note)}</p></div>`;
}

function pill() {
  const on = role === 'imam' ? Boolean(rec) : session?.status === 'live';
  const label = role === 'imam' ? liveLabel() : session?.status === 'ended' ? 'Ended' : on ? 'Live' : 'Ready';
  return `<span id="live-pill" class="pill ${on ? 'live' : ''}">${on ? '<i class="dot on"></i>' : ''}${e(label)}</span>`;
}

function liveStage(actions = '') {
  return `<section class="live-stage">
    <header class="live-head">
      <span class="live-title">${e(session.title || 'Minbar')}${role === 'imam' ? ' <small>· Imam desk</small>' : ''}</span>
      <span class="live-actions">${actions}${pill()}</span>
    </header>
    <div class="live-body" id="live">${stageBody()}</div>
  </section>`;
}

function renderAudience() {
  applyRole();
  if (!session) {
    $('#main').innerHTML = `<section class="live-stage"><div class="live-body"><div class="stage-wait"><strong>${role === 'screen' ? 'This screen did not open.' : 'These subtitles did not open.'}</strong><p>${e(roomError || (role === 'screen' ? 'Open it from the imam desk.' : 'Scan the QR from the imam desk.'))}</p></div></div></section>`;
    return;
  }
  const sizer = role === 'listen'
    ? '<span class="sizer"><button type="button" id="smaller" aria-label="Smaller text">A−</button><button type="button" id="bigger" aria-label="Larger text">A+</button></span>'
    : '';
  const ask = role === 'listen' && !session.translationEnabled
    ? `<button type="button" id="ask-translation" class="ask-pill"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>Translate to ${e(languageName(targetLanguage()))}</button>`
    : '';
  $('#main').innerHTML = `${liveStage(sizer)}${ask}`;
  bind();
}

function setScale(step) {
  textScale = Math.min(1.8, Math.max(0.7, Math.round((textScale + step) * 10) / 10));
  localStorage.setItem('minbar-scale', String(textScale));
  document.documentElement.style.setProperty('--scale', textScale);
}

function render() {
  const old = $('#transcript');
  if (old && !followLatest) transcriptScroll = old.scrollTop;
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === view && role === 'imam'));
  if (role !== 'imam') return renderAudience();
  applyRole();
  if (view === 'account') return accountView();
  if (view === 'profile') return profileView();
  if (view !== 'home') return listView();
  if (!session) {
    $('#main').innerHTML = `<div class="imam-home"><section class="role-list"><p class="kicker">Three places</p><h1>One sermon, three screens.</h1><article class="role-card"><p class="kicker">1 · Imam</p><h2>This desk</h2><p>Record the sermon here. The words are transcribed as they are spoken.</p></article><article class="role-card"><p class="kicker">2 · Screen</p><h2>The hall</h2><p>A separate full-screen view for the display in the room.</p></article><article class="role-card"><p class="kicker">3 · Listener</p><h2>A phone</h2><p>Someone scans a QR code and reads subtitles on their own screen.</p></article></section>${controls()}</div>`;
  } else $('#main').innerHTML = `<div class="desk-live">${liveStage()}${controlBar()}${deskMore()}</div>`;
  bind();
  const pane = $('#transcript');
  if (pane) pane.scrollTop = followLatest ? pane.scrollHeight : transcriptScroll;
}

function patchTranscript() {
  const live = $('#live');
  if (!live || (role === 'imam' && view !== 'home')) return render();
  live.innerHTML = stageBody();
  const pane = $('#transcript');
  if (pane) {
    const top = pane.scrollTop;
    pane.innerHTML = transcriptMarkup();
    pane.scrollTop = followLatest ? pane.scrollHeight : top;
  }
  const status = $('#record-status');
  if (status) status.textContent = statusLine();
  const badge = $('#live-pill');
  if (badge) badge.outerHTML = pill();
  const follow = $('#follow');
  if (follow) follow.textContent = followLatest ? 'Pause following' : 'Follow latest';
}

const on = (id, fn) => { const node = $(id); if (node) node.onclick = act(fn); };

function bind() {
  const pane = $('#transcript');
  if (pane && role === 'imam') {
    const pause = () => { followLatest = false; const follow = $('#follow'); if (follow) follow.textContent = 'Follow latest'; };
    pane.addEventListener('wheel', pause, { passive: true });
    pane.addEventListener('touchmove', pause, { passive: true });
  }
  const more = $('#desk-more');
  if (more) more.ontoggle = () => { moreOpen = more.open; };
  on('#smaller', () => setScale(-0.1));
  on('#bigger', () => setScale(0.1));
  document.querySelectorAll('input[name="kind"]').forEach((input) => {
    input.onchange = () => {
      const copy = $('#privacy-copy');
      const save = $('#archive-create');
      if (copy) copy.textContent = input.value === 'venue' && input.checked ? 'The hall screen and a phone QR can open the transcript. They cannot control the recording.' : 'This recording stays on this desk. No hall screen and no phone QR.';
      if (save) save.disabled = document.querySelector('input[name="kind"]:checked')?.value !== 'personal';
    };
  });
  if ($('#title')) {
    $('#title').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); $('#create')?.click(); }
    });
  }
  on('#location', () => navigator.geolocation.getCurrentPosition((position) => {
    roomLocation = { optIn: true, latitude: Math.round(position.coords.latitude * 100) / 100, longitude: Math.round(position.coords.longitude * 100) / 100 };
    $('#location-status').textContent = 'Approximate location will be stored with a public venue room.';
  }, () => toast('Location is unavailable. You can still open a room.'), { enableHighAccuracy: false, timeout: 10000 }));
  on('#create', async () => {
    if (!config.liveAvailable) throw Error('Add an OpenAI project key on the server, then refresh.');
    const button = $('#create');
    if (button) button.disabled = true;
    const sourceLanguage = document.querySelector('input[name="source"]:checked')?.value === 'en' ? 'en' : 'ar';
    const kind = document.querySelector('input[name="kind"]:checked')?.value === 'venue' ? 'venue' : 'personal';
    const saveAudio = kind === 'personal' && Boolean($('#archive-create')?.checked);
    const title = $('#title').value.trim() || 'Live session';
    const profileId = $('#profile')?.value || undefined;
    try {
      const created = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title,
          profileId,
          kind,
          visibility: kind === 'personal' ? 'private' : 'public',
          sourceLanguage,
          language: sourceLanguage === 'ar' ? 'en' : 'ar',
          translation: false,
          location: kind === 'venue' ? roomLocation : null
        })
      });
      session = created.session;
      segments = [];
      draft = null;
      roomError = '';
      role = 'imam';
      const saved = owners();
      saved[session.id] = { ownerToken: created.ownerToken };
      localStorage.setItem('minbar-rooms', JSON.stringify(saved));
      history.replaceState(null, '', `/?room=${session.id}&as=imam`);
      subscribe();
      recordingStatus = 'Opening the microphone…';
      render();
      await beginCapture(saveAudio);
    } catch (err) {
      if (!session && button?.isConnected) button.disabled = false;
      throw err;
    }
  });
  on('#start', async () => { await beginCapture(); });
  on('#stop', async () => {
    if (!rec) return;
    starting = true;
    recordingStatus = 'Stopping…';
    render();
    try {
      await rec.stop();
      rec = null;
      recordingStatus = 'Recording stopped. Start again when you are ready.';
    } finally {
      starting = false;
      render();
    }
  });
  on('#end', async () => {
    starting = true;
    recordingStatus = 'Ending the session…';
    render();
    try {
      await rec?.stop();
      rec = null;
      await api(`/api/sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ended' }) });
      session = await api(`/api/sessions/${session.id}`);
      segments = session.segments || segments;
      recordingStatus = 'Session ended';
    } finally {
      starting = false;
      render();
    }
  });
  on('#new', async () => {
    await stopOriginal();
    await rec?.stop();
    rec = null;
    recordingStatus = 'Ready';
    stream?.close();
    session = null;
    segments = [];
    draft = null;
    roomError = '';
    roomLocation = null;
    audioContext = null;
    audioUntil = 0;
    originalAudio = false;
    audioSequence = null;
    role = 'imam';
    history.replaceState(null, '', '/');
    render();
  });
  on('#send', async () => {
    const text = $('#manual').value.trim();
    if (!text) return;
    await api(`/api/sessions/${session.id}/segments`, { method: 'POST', body: JSON.stringify({ text }) });
    $('#manual').value = '';
  });
  on('#join', qr);
  on('#open-screen', () => { window.open(`/?room=${session.id}&as=screen`, 'minbar-screen'); });
  on('#translate', () => setTranslation(true));
  on('#translate-off', () => setTranslation(false));
  on('#ask-translation', () => setTranslation(true));
  on('#export', async () => download(`/api/sessions/${session.id}/export?format=txt`, 'minbar-transcript.txt'));
  on('#insights', async () => {
    const data = await api(`/api/sessions/${session.id}/insights`, { method: 'POST' });
    let box = $('#insights-output');
    if (!box) {
      box = document.createElement('div');
      box.id = 'insights-output';
      box.className = 'notice panel';
      $('#main').append(box);
    }
    box.textContent = data.summary;
  });
  on('#follow', () => { followLatest = !followLatest; patchTranscript(); });
  on('#original', async () => {
    if (originalAudio) await stopOriginal();
    else {
      listening = false;
      speechSynthesis.cancel();
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      await audioContext.resume();
      originalAudio = true;
      audioUntil = 0;
      audioSequence = null;
    }
    render();
  });
  on('#listen', async () => {
    await stopOriginal();
    listening = !listening;
    speechSynthesis.cancel();
    if (listening) segments.filter((item) => item.status === 'double-checked' || session.isDemo).forEach(speak);
    render();
  });
  if ($('#host-key')) $('#host-key').oninput = () => { hostKey = $('#host-key').value; };
  if ($('#audio')) {
    $('#audio').onchange = act(async () => {
      const file = $('#audio').files[0];
      if (!file) return;
      const data = await api(`/api/sessions/${session.id}/audio`, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': file.name, 'X-Recording-Consent': 'true' }
      });
      if (data.recording) session.recordings = [...(session.recordings || []), data.recording];
      render();
      toast('Audio transcribed');
    });
  }
  document.querySelectorAll('[data-download]').forEach((button) => {
    button.onclick = act(() => download(`/api/sessions/${session.id}/recordings/${button.dataset.download}`, 'minbar-recording'));
  });
  document.querySelectorAll('[data-delete]').forEach((button) => {
    button.onclick = act(async () => {
      if (!confirm('Delete this audio? The transcript stays.')) return;
      await api(`/api/sessions/${session.id}/recordings/${button.dataset.delete}`, { method: 'DELETE' });
      session.recordings = session.recordings.filter((item) => item.id !== button.dataset.delete);
      render();
    });
  });
}

async function download(path, name) {
  const response = await fetch(path, { headers: token() ? { Authorization: `Bearer ${token()}` } : {} });
  if (!response.ok) throw Error('Download unavailable');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function speak(item) {
  if (!item.translation) return;
  const utterance = new SpeechSynthesisUtterance(item.translation);
  utterance.lang = session.language === 'ar' ? 'ar-SA' : 'en-GB';
  speechSynthesis.speak(utterance);
}

async function stopOriginal() {
  originalAudio = false;
  for (const source of audioSources) { try { source.stop(); } catch { /* already ended */ } }
  audioSources.clear();
  await audioContext?.close();
  audioContext = null;
  audioUntil = 0;
}

function receiveAudio(packet) {
  if (!originalAudio || !audioContext || packet.format !== 'pcm16' || packet.sampleRate !== 24000) return;
  const raw = atob(packet.audio);
  if (raw.length % 2 || raw.length > 48000) return;
  const buffer = audioContext.createBuffer(1, raw.length / 2, 24000);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    let value = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
    if (value >= 32768) value -= 65536;
    samples[i] = value / 32768;
  }
  const now = audioContext.currentTime;
  if (audioUntil - now > 2 || (audioSequence !== null && packet.sequence !== audioSequence + 1)) {
    for (const queued of audioSources) { try { queued.stop(); } catch { /* already ended */ } }
    audioSources.clear();
    audioUntil = now;
  }
  audioSequence = packet.sequence;
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  audioSources.add(source);
  source.onended = () => audioSources.delete(source);
  source.connect(audioContext.destination);
  const start = Math.max(now + 0.05, audioUntil);
  source.start(start);
  audioUntil = start + buffer.duration;
}

function subscribe() {
  stream?.close();
  stream = new EventSource(`/api/sessions/${session.id}/events${token() ? `?token=${encodeURIComponent(token())}` : ''}`);
  stream.addEventListener('revision', (ev) => {
    const data = JSON.parse(ev.data);
    const removed = new Set(data.supersedes || []);
    const indices = segments.map((item, index) => (removed.has(item.itemId) ? index : -1)).filter((index) => index >= 0);
    const insert = indices.length ? Math.min(...indices) : segments.length;
    segments = segments.filter((item) => !removed.has(item.itemId) && item.id !== data.segment.id);
    segments.splice(Math.min(insert, segments.length), 0, data.segment);
    draft = null;
    patchTranscript();
    if (listening) speak(data.segment);
  });
  stream.addEventListener('partial', (ev) => {
    draft = JSON.parse(ev.data);
    if (!draft.text) draft = null;
    patchTranscript();
  });
  stream.addEventListener('audio', (ev) => {
    try { receiveAudio(JSON.parse(ev.data)); } catch { if ($('#event-status')) $('#event-status').textContent = 'Audio interrupted'; }
  });
  stream.addEventListener('snapshot', (ev) => {
    const next = JSON.parse(ev.data);
    const translationChanged = !!next.translationEnabled !== !!session.translationEnabled;
    session = { ...session, ...next, recordings: session.recordings?.length ? session.recordings : next.recordings };
    segments = next.segments || [];
    if (draft && segments.some((item) => item.itemId === draft.itemId)) draft = null;
    if (translationChanged || !$('#live')) render();
    else patchTranscript();
  });
  stream.addEventListener('segment', (ev) => {
    const item = JSON.parse(ev.data);
    if (draft?.itemId === item.itemId) draft = null;
    const index = segments.findIndex((current) => current.id === item.id);
    if (index < 0) segments.push(item);
    else segments[index] = item;
    patchTranscript();
    if (listening && item.status === 'double-checked') speak(item);
  });
  stream.addEventListener('status', (ev) => {
    const next = JSON.parse(ev.data);
    const translationChanged = next.translationEnabled !== undefined && !!next.translationEnabled !== !!session.translationEnabled;
    session = { ...session, ...next };
    if (session.status === 'ended' || translationChanged || !$('#live')) render();
    else patchTranscript();
  });
  stream.onerror = () => {
    if (originalAudio) { audioUntil = 0; audioSequence = null; }
    if ($('#event-status')) $('#event-status').textContent = 'Connection interrupted · reconnecting';
  };
}

async function setTranslation(enabled) {
  const data = await api(`/api/sessions/${session.id}/translation`, { method: 'POST', body: JSON.stringify({ enabled }) });
  session = { ...session, ...data.session, recordings: session.recordings?.length ? session.recordings : data.session.recordings };
  if (data.session.segments) segments = data.session.segments;
  if (data.warning) toast(data.warning);
  render();
}

async function qr() {
  const base = config.publicBaseUrl || location.origin;
  const url = `${base}/?room=${session.id}&as=listen`;
  const local = /localhost|127\.0\.0\.1/.test(base);
  $('#join-url').value = url;
  $('#join-dialog h2').textContent = 'Subtitles on a phone';
  $('#join-note').textContent = local
    ? 'This QR works on this computer only. Set a public HTTPS address before people in the hall scan it.'
    : 'Scan with a phone to read the subtitles.';
  const response = await fetch(`/api/sessions/${session.id}/qr?url=${encodeURIComponent(url)}`);
  $('#qr').innerHTML = response.ok ? await response.text() : 'QR is unavailable. Use the room link.';
  $('#join-dialog').showModal();
}

const card = (item) => `<article class="session-card"><span class="pill">${e(item.status)}</span><h3>${e(item.title)}</h3><p>${e(languageName(item.sourceLanguage))} · ${e(item.visibility)}</p><a href="/?room=${item.id}&as=${owners()[item.id] ? 'imam' : 'listen'}">Open</a></article>`;

async function listView() {
  const archive = view === 'archive';
  $('#main').innerHTML = `<div class="page-head"><h1>${archive ? 'Archive' : 'Sessions'}</h1><p>${archive ? 'Rooms opened in this browser, and rooms on your signed-in account.' : 'Public venue rooms on this server.'}</p></div>${archive ? '' : '<div class="notice panel">Location is optional. <button type="button" id="near" class="quiet">Use approximate location</button></div>'}<div id="sessions" class="session-list">Loading…</div>`;
  try {
    let list;
    if (archive) {
      list = (await Promise.all(Object.keys(owners()).map(async (id) => {
        try { return await api(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${owners()[id].ownerToken}` } }); } catch { return null; }
      }))).filter(Boolean);
      try {
        const accountRooms = (await api('/api/me/sessions')).sessions || [];
        accountRoomIds = new Set(accountRooms.map((item) => item.id));
        list = [...new Map([...list, ...accountRooms].map((item) => [item.id, item])).values()];
      } catch { /* signed out */ }
    } else list = (await api('/api/sessions?public=true')).sessions;
    $('#sessions').innerHTML = list.length ? list.map(card).join('') : '<div class="notice panel">No rooms yet.</div>';
    on('#near', () => navigator.geolocation.getCurrentPosition((position) => {
      const lat = Math.round(position.coords.latitude * 100) / 100;
      const lng = Math.round(position.coords.longitude * 100) / 100;
      const found = list.filter((item) => item.location && Math.hypot(item.location.latitude - lat, (item.location.longitude - lng) * Math.cos(lat * Math.PI / 180)) * 111 <= 30);
      $('#sessions').innerHTML = found.length ? found.map(card).join('') : '<div class="notice panel">No public rooms with a shared location within about 30 km.</div>';
      toast('Approximate location was used for this search only.');
    }, () => toast('Location is unavailable. The public list still works.'), { enableHighAccuracy: false, timeout: 10000 }));
  } catch (err) {
    $('#sessions').textContent = err.message;
  }
}

document.querySelectorAll('[data-view]').forEach((n) => {
  n.onclick = () => { view = n.dataset.view; render(); };
});
$('.dialog-close').onclick = () => $('#join-dialog').close();
$('#copy-link').onclick = act(async () => { await navigator.clipboard.writeText($('#join-url').value); toast('Link copied'); });

try {
  config = await api('/api/config');
  try { profiles = (await api('/api/me/profiles')).profiles; } catch { /* signed out */ }
  try { accountRoomIds = new Set((await api('/api/me/sessions')).sessions.map((item) => item.id)); } catch { /* signed out */ }
  $('#connection').textContent = config.liveAvailable ? 'Ready' : 'Needs a project key';
  $('#connection').className = config.liveAvailable ? 'pill live' : 'pill warn';
  const parameters = new URLSearchParams(location.search);
  selectedProfile = parameters.get('profile');
  if (selectedProfile) view = 'profile';
  const requested = parameters.get('as');
  const id = parameters.get('room');
  if (id) {
    try {
      session = await api(`/api/sessions/${id}`, { headers: owners()[id] ? { Authorization: `Bearer ${owners()[id].ownerToken}` } : {} });
      segments = session.segments || [];
      subscribe();
    } catch (err) {
      roomError = err.message;
    }
  }
  if (requested === 'screen') role = 'screen';
  else if (requested === 'listen' || (id && !isHost())) role = 'listen';
  else role = 'imam';
  if (role !== 'imam') view = 'home';
  render();
  booted = true;
} catch (err) {
  $('#connection').textContent = 'Offline';
  $('#main').innerHTML = `<div class="page-head"><h1>Minbar is offline</h1><p>Start the server and refresh.</p></div><div class="notice panel">${e(err.message)}</div>`;
}

async function accountView() {
  $('#main').innerHTML = `<div class="page-head"><h1>Account</h1><p>Sign in to keep venue profiles and rooms on this server.</p></div><div class="panel account-form">Loading account…</div>`;
  try {
    const me = await api('/api/auth/me');
    const box = $('.account-form');
    if (me.user) {
      const billing = await api('/api/billing/status');
      box.innerHTML = `<h2>${e(me.user.email)}</h2><p class="meta">Signed in on this server.</p><p>Subscription: ${e(billing.subscription?.status || 'None')}</p><p class="hint">${billing.configured ? 'Checkout uses the price configured on the server.' : 'Billing is not configured, so no payment is collected.'}</p>${billing.configured ? '<button type="button" id="checkout" class="primary">Open checkout</button>' : ''}<div class="stack"><button type="button" id="logout" class="secondary full">Sign out</button></div>`;
      on('#logout', async () => {
        await api('/api/auth/logout', { method: 'POST' });
        profiles = [];
        accountRoomIds.clear();
        accountView();
      });
      await profileEditor(box);
      on('#checkout', async () => {
        const data = await api('/api/billing/checkout', { method: 'POST', body: '{}' });
        if (/^https:\/\//.test(data.url)) location.href = data.url;
        else throw Error('Invalid checkout address');
      });
    } else {
      box.innerHTML = `<h2>Sign in</h2><label class="field" for="email">Email</label><input id="email" type="email" autocomplete="username"><label class="field" for="password">Password</label><input id="password" type="password" autocomplete="current-password" minlength="12"><p class="hint">New accounts need at least 12 characters. The password is not stored in this browser.</p><div class="row"><button type="button" id="login" class="primary">Sign in</button><button type="button" id="register" class="secondary">Create account</button></div>`;
      for (const action of ['login', 'register']) {
        on(`#${action}`, async () => {
          await api(`/api/auth/${action}`, { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
          profiles = (await api('/api/me/profiles')).profiles;
          accountRoomIds = new Set((await api('/api/me/sessions')).sessions.map((item) => item.id));
          accountView();
        });
      }
    }
  } catch (err) {
    $('.account-form').textContent = err.message;
  }
}

async function profileView() {
  $('#main').innerHTML = `<div class="page-head"><h1>Profile</h1><p>Public venue rooms for this speaker or place.</p></div><div id="public-profile" class="panel">Loading…</div>`;
  try {
    const data = await api(`/api/profiles/${encodeURIComponent(selectedProfile)}`);
    $('#public-profile').innerHTML = `<p class="kicker">${e(data.profile.type)}</p><h2>${e(data.profile.name)}</h2><p>${e(data.profile.bio)}</p><div class="session-list">${data.sessions.length ? data.sessions.map(card).join('') : '<p class="meta">No public sessions yet.</p>'}</div>`;
  } catch (err) {
    $('#public-profile').textContent = err.message;
  }
}

async function profileEditor(box) {
  profiles = (await api('/api/me/profiles')).profiles;
  const section = document.createElement('section');
  section.className = 'profile-editor';
  section.innerHTML = `<h2>Profiles</h2><p class="hint">A public profile is a lasting link. Private recordings stay off it.</p>${profiles.map((p) => `<p><a href="/?profile=${e(p.id)}">${e(p.name)}</a> <button type="button" class="quiet" data-edit-profile="${e(p.id)}">Edit</button></p>`).join('')}<label class="field" for="profile-name">Public name</label><input id="profile-name" maxlength="100"><label class="field" for="profile-type">Type</label><select id="profile-type"><option value="venue">Venue</option><option value="speaker">Speaker</option></select><label class="field" for="profile-bio">Description</label><textarea id="profile-bio" maxlength="1000"></textarea><button type="button" id="save-profile" class="secondary">Save profile</button>`;
  box.append(section);
  let editing = null;
  section.querySelectorAll('[data-edit-profile]').forEach((button) => {
    button.onclick = () => {
      editing = button.dataset.editProfile;
      const profile = profiles.find((item) => item.id === editing);
      $('#profile-name').value = profile.name;
      $('#profile-type').value = profile.type;
      $('#profile-bio').value = profile.bio;
      $('#save-profile').textContent = 'Save changes';
    };
  });
  on('#save-profile', async () => {
    await api(`/api/profiles${editing ? `/${editing}` : ''}`, {
      method: editing ? 'PATCH' : 'POST',
      body: JSON.stringify({ name: $('#profile-name').value, type: $('#profile-type').value, bio: $('#profile-bio').value })
    });
    await accountView();
    toast('Profile saved');
  });
}

async function beginCapture(saveAudio) {
  if (!session || rec || starting || session.isDemo) return;
  archiveRecording = session.kind === 'personal' && (saveAudio ?? Boolean($('#archive-audio')?.checked));
  starting = true;
  recordingStatus = 'Connecting microphone…';
  render();
  try {
    if (config.localDevelopmentAvailable) await api('/api/local-access', { method: 'POST', body: '{}' });
    const { startTranscription } = await import('./realtime.js');
    rec = await startTranscription({
      sessionId: session.id,
      ownerToken: token(),
      hostKey,
      model: config.models?.live || 'gpt-live-transcribe',
      delay: 'low',
      archiveRecording,
      onStatus: (status) => { recordingStatus = status; if ($('#record-status')) $('#record-status').textContent = status; },
      onTranscript: () => {}
    });
    recordingStatus = 'Listening';
  } catch (err) {
    recordingStatus = err.message;
    throw err;
  } finally {
    starting = false;
    render();
  }
}
