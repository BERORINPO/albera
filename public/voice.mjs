// UI adapter: microphone audio, assistant audio, and captions stay in browser storage.
import { createVoiceSession, VoiceApiError, voiceAvailability } from './api.mjs';
import { deleteVoiceSession, getVoiceAudio, listVoiceSessions, saveVoiceSession, voiceStorageAvailable } from './voice-store.mjs';
import { appendVoiceCaption, projectVoiceDelta } from './voice-transcript.mjs';
import { requestLiveSessionClose } from './live-close.mjs';

/** @param {Record<string, MediaRecorder>} recorders */
export async function stopVoiceRecorders(recorders) {
  await Promise.all(Object.values(recorders ?? {}).map((recorder) => new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') { resolve(undefined); return; }
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(undefined); };
    try {
      recorder.addEventListener('stop', finish, { once: true });
      recorder.stop();
    } catch {
      recorder.removeEventListener?.('stop', finish);
      finish();
    }
  })));
}

/** @param {{t: () => (key: string) => string}} options */
export function initVoice({ t }) {
  const $ = (id) => document.getElementById(id);
  const dialog = /** @type {HTMLDialogElement} */ ($('voice-dialog'));
  const status = /** @type {HTMLElement} */ ($('voice-status'));
  const transcript = /** @type {HTMLElement} */ ($('voice-transcript'));
  const start = /** @type {HTMLButtonElement} */ ($('voice-start'));
  const mute = /** @type {HTMLButtonElement} */ ($('voice-mute'));
  const stop = /** @type {HTMLButtonElement} */ ($('voice-stop'));
  const audio = /** @type {HTMLAudioElement} */ ($('voice-audio'));
  const history = /** @type {HTMLElement} */ ($('voice-history-list'));
  const detail = /** @type {HTMLElement} */ ($('voice-record-detail'));
  let available = false;
  let peer = null;
  let stream = null;
  let channel = null;
  let recorders = /** @type {Record<string, MediaRecorder>} */ ({});
  let parts = /** @type {Record<string, Blob[]>} */ ({ user: [], assistant: [] });
  let transcriptRows = /** @type {Array<{role:'user'|'assistant',text:string}>} */ ([]);
  let startedAt = 0;
  let captureStartedAt = 0;
  let sessionStarted = false;
  let sessionClosed = false;
  let resolveSessionStarted = () => {};
  let resolveSessionClosed = () => {};
  let sessionStartedSignal = Promise.resolve(false);
  let sessionClosedSignal = Promise.resolve(false);
  let pendingDeleteId = '';
  let stopping = false;
  let objectUrls = /** @type {string[]} */ ([]);

  const say = (key) => { status.textContent = t()(key); };
  const mimeType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
  const addRecorder = (role, media) => {
    if (typeof MediaRecorder === 'undefined') throw new Error('voice_recorder_unavailable');
    const type = mimeType();
    const recorder = new MediaRecorder(media, type ? { mimeType: type } : undefined);
    recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) parts[role].push(event.data); });
    recorder.start(1000);
    recorders[role] = recorder;
  };
  const appendDelta = (role, delta) => {
    const previousLength = transcriptRows.length;
    transcriptRows = appendVoiceCaption(transcriptRows, { role, delta });
    if (transcriptRows.length > previousLength) {
      const line = document.createElement('p');
      line.className = `voice__line voice__line--${role}`;
      const label = document.createElement('strong');
      label.textContent = `${t()(`voice.${role}`)}: `;
      line.append(label, document.createTextNode(delta));
      transcript.append(line);
    } else transcript.lastElementChild?.append(document.createTextNode(delta));
  };
  const setTranscript = (item) => {
    const caption = projectVoiceDelta(item);
    if (caption) appendDelta(caption.role, caption.delta);
    if (item?.type === 'session.started') say('voice.listening');
    if (item?.type === 'error') say('voice.sessionError');
  };
  function clearActive() {
    if (channel) channel.close();
    channel = null;
    if (peer) peer.close();
    peer = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    audio.srcObject = null;
    mute.hidden = true;
    stop.hidden = true;
    start.hidden = false;
    start.disabled = !available;
    recorders = {};
    parts = { user: [], assistant: [] };
    transcriptRows = [];
    captureStartedAt = 0;
    sessionStarted = false;
    sessionClosed = false;
    resolveSessionStarted(false);
    resolveSessionClosed(false);
  }
  async function finishCapture(outcome) {
    if (stopping) return;
    stopping = true;
    stop.disabled = true;
    stop.hidden = true;
    say(outcome === 'interrupted' ? 'voice.savingInterrupted' : 'voice.saving');
    let closeConfirmed = null;
    if (outcome === 'complete') {
      say('voice.closing');
      closeConfirmed = await requestLiveSessionClose({
        channel,
        isStarted: () => sessionStarted,
        isClosed: () => sessionClosed,
        startedSignal: sessionStartedSignal,
        closedSignal: sessionClosedSignal,
        closeEventId: `pigeonholes-close-${crypto.randomUUID()}`,
      });
      if (!closeConfirmed) say('voice.closeUnconfirmed');
    }
    if (channel) channel.close(); channel = null;
    await stopVoiceRecorders(recorders);
    if (peer) peer.close(); peer = null;
    for (const track of stream?.getTracks() ?? []) track.stop(); stream = null; audio.srcObject = null;
    const audioRows = Object.fromEntries(['user', 'assistant'].map((role) => {
      const blobs = parts[role];
      const blob = blobs.length ? new Blob(blobs, { type: blobs[0]?.type || 'audio/webm' }) : null;
      return [role, blob];
    }));
    const hasCapture = Object.values(audioRows).some((blob) => blob?.size) || transcriptRows.length > 0;
    try {
      if (!hasCapture) { say(outcome === 'interrupted' ? 'voice.interruptedEmpty' : 'voice.noCapture'); return; }
      const now = Date.now();
      const session = { id: `voice_${crypto.randomUUID()}`, createdAt: captureStartedAt || startedAt || now, durationSeconds: Math.max(1, Math.round((now - (captureStartedAt || startedAt || now)) / 1000)), outcome, closeConfirmed, transcript: transcriptRows };
      await saveVoiceSession(session, audioRows); say(outcome === 'interrupted' ? 'voice.interruptedSaved' : closeConfirmed ? 'voice.saved' : 'voice.savedCloseUnconfirmed'); await refreshHistory();
    } catch { say('voice.saveFailed'); }
    finally { clearActive(); stopping = false; stop.disabled = false; start.hidden = false; start.disabled = !available; }
  }
  async function refreshHistory() {
    history.replaceChildren();
    try {
      const rows = await listVoiceSessions();
      if (!rows.length) history.append(document.createTextNode(t()('voice.noHistory')));
      for (const row of rows) {
        const item = document.createElement('li');
        const open = document.createElement('button');
        open.type = 'button'; open.className = 'textbtn'; open.dataset.voiceOpen = row.id;
        open.textContent = `${new Date(row.createdAt).toLocaleString()} — ${Math.round(row.durationSeconds / 60)} ${t()('voice.minutes')}`;
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'textbtn'; remove.dataset.voiceDelete = row.id; remove.textContent = t()('voice.delete');
        item.append(open, remove); history.append(item);
      }
    } catch { history.append(document.createTextNode(t()('voice.storageError'))); }
  }
  async function showSaved(id) {
    const record = (await listVoiceSessions()).find((row) => row.id === id);
    if (!record) return;
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
    detail.replaceChildren(); detail.hidden = false;
    const outcome = record.outcome === 'interrupted' ? 'interrupted' : 'complete';
    const heading = document.createElement('h3'); heading.textContent = `${new Date(record.createdAt).toLocaleString()} — ${t()(`voice.outcome.${outcome}`)}`; detail.append(heading);
    if (record.closeConfirmed === false) { const note = document.createElement('p'); note.textContent = t()('voice.closeUnconfirmed'); detail.append(note); }
    const lines = document.createElement('div'); lines.className = 'voice__transcript';
    for (const row of record.transcript) {
      const line = document.createElement('p'); line.className = `voice__line voice__line--${row.role}`;
      line.textContent = `${t()(`voice.${row.role}`)}: ${row.text}`; lines.append(line);
    }
    detail.append(lines);
    for (const role of ['user', 'assistant']) {
      const blob = await getVoiceAudio(id, role);
      if (!blob) { const missing = document.createElement('p'); missing.textContent = t()(`voice.${role}AudioMissing`); detail.append(missing); continue; }
      const label = document.createElement('label'); label.textContent = t()(`voice.${role}Audio`);
      const player = document.createElement('audio'); player.controls = true; player.src = URL.createObjectURL(blob);
      objectUrls.push(player.src);
      label.append(player); detail.append(label);
    }
  }

  $('voice-open')?.addEventListener('click', async () => {
    dialog.showModal(); detail.hidden = true; transcript.replaceChildren(); say('voice.checking');
    try {
      const configured = await voiceAvailability();
      const storage = await voiceStorageAvailable();
      available = configured && storage && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
      if (!configured) { say('voice.unconfigured'); start.disabled = true; await refreshHistory(); return; }
      if (!storage) { say('voice.storageError'); start.disabled = true; await refreshHistory(); return; }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { say('voice.unavailable'); start.disabled = true; await refreshHistory(); return; }
      say(available ? 'voice.ready' : 'voice.unconfigured'); start.disabled = !available;
      await refreshHistory();
    } catch { available = false; say('voice.unavailable'); }
  });
  start.addEventListener('click', async () => {
    start.disabled = true; detail.hidden = true; transcript.replaceChildren(); say('voice.connecting'); captureStartedAt = Date.now();
    sessionStarted = false; sessionClosed = false;
    sessionStartedSignal = new Promise((resolve) => { resolveSessionStarted = resolve; });
    sessionClosedSignal = new Promise((resolve) => { resolveSessionClosed = resolve; });
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      addRecorder('user', stream);
      peer = new RTCPeerConnection();
      peer.ontrack = (event) => {
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        audio.srcObject = remote; void audio.play().catch(() => {});
        if (!recorders.assistant) addRecorder('assistant', remote);
      };
      peer.onconnectionstatechange = () => { if (!stopping && peer && ['failed', 'closed'].includes(peer.connectionState)) { void finishCapture('interrupted'); say('voice.disconnected'); } };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      channel = peer.createDataChannel('live-events');
      channel.addEventListener('open', () => { startedAt = Date.now(); say('voice.listening'); start.hidden = true; mute.hidden = false; stop.hidden = false; });
      channel.addEventListener('message', (event) => { try {
        const item = JSON.parse(event.data);
        if (item?.type === 'session.started') { sessionStarted = true; resolveSessionStarted(true); }
        if (item?.type === 'session.closed') { sessionClosed = true; resolveSessionClosed(true); }
        setTranscript(item);
      } catch {} });
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ice_timeout')), 8000);
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); return; }
        peer.addEventListener('icegatheringstatechange', () => { if (peer?.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
      });
      const value = await createVoiceSession(peer.localDescription?.sdp ?? '');
      await peer.setRemoteDescription({ type: 'answer', sdp: value.sdp });
    } catch (error) {
      const key = error instanceof Error && ['NotAllowedError', 'NotFoundError', 'SecurityError'].includes(error.name) ? 'voice.micDenied' : error instanceof VoiceApiError && error.reason === 'not_configured' ? 'voice.unconfigured' : 'voice.unavailable';
      if (Object.values(parts).some((rows) => rows.length) || transcriptRows.length) { say(key); await finishCapture('interrupted'); }
      else { clearActive(); say(key); }
    }
  });
  mute.addEventListener('click', () => {
    const track = stream?.getAudioTracks()[0]; if (!track) return;
    track.enabled = !track.enabled; mute.textContent = t()(track.enabled ? 'voice.mute' : 'voice.unmute');
  });
  stop.addEventListener('click', async () => {
    await finishCapture('complete');
  });
  mute.hidden = stop.hidden = true;
  history.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    const id = target?.dataset.voiceOpen ?? target?.dataset.voiceDelete;
    if (!id) return;
    if (target.dataset.voiceOpen) { try { await showSaved(id); } catch { say('voice.storageError'); } }
    else { pendingDeleteId = id; /** @type {HTMLDialogElement} */ ($('voice-delete-dialog')).showModal(); }
  });
  $('voice-delete-cancel')?.addEventListener('click', () => /** @type {HTMLDialogElement} */ ($('voice-delete-dialog')).close());
  $('voice-delete-confirm')?.addEventListener('click', async () => {
    try { await deleteVoiceSession(pendingDeleteId); for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls = []; detail.hidden = true; detail.replaceChildren(); await refreshHistory(); say('voice.deleted'); }
    catch { say('voice.storageError'); }
    pendingDeleteId = ''; /** @type {HTMLDialogElement} */ ($('voice-delete-dialog')).close();
  });
  $('voice-close')?.addEventListener('click', () => {
    if (peer || stream) { stop.click(); return; }
    dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (peer || stream) { event.preventDefault(); stop.click(); }
  });
  window.addEventListener('beforeunload', (event) => {
    if ((peer || stream) && !stopping) { event.preventDefault(); event.returnValue = ''; }
  });
  dialog.addEventListener('close', () => {
    if (peer || stream) void finishCapture('interrupted');
    for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls = [];
  });
  void refreshHistory();
}
