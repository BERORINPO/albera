import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createHandler } from '../src/entry/http.mjs';
import { createLiveVoiceSession } from '../src/entry/live-voice.mjs';
import { stopVoiceRecorders } from '../public/voice.mjs';
import { deleteVoiceSession, getVoiceAudio, listVoiceSessions, saveVoiceSession, voiceStorageAvailable } from '../public/voice-store.mjs';
import { appendVoiceCaption, projectVoiceDelta } from '../public/voice-transcript.mjs';

const SESSION_ID = 'voice_00000000-0000-4000-8000-000000000001';

test('GPT-Live server adapter uses fixed non-stored config and returns only session id and SDP', async () => {
  let call;
  const session = createLiveVoiceSession({ apiKey: 'secret-test-key', fetchImpl: async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ session: { id: 'live_test_123' }, transport: { type: 'webrtc', sdp: 'safe-answer' } }), { status: 201, headers: { 'content-type': 'application/json' } });
  } });
  const result = await session('synthetic-offer');
  assert.deepEqual(result, { ok: true, sessionId: 'live_test_123', answerSdp: 'safe-answer' });
  assert.equal(call.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(call.options.headers.authorization, 'Bearer secret-test-key');
  const body = JSON.parse(call.options.body);
  assert.deepEqual(body.session, {
    model: 'gpt-live-1', store: false, delegation: { type: 'client' }, audio: { output: { voice: 'marin' } },
    client: { data_channel: { allowed_client_events: [], allowed_server_events: ['session.started', 'session.closed', 'session.input_transcript.delta', 'session.output_transcript.delta', 'session.usage.updated', 'error'] } },
  });
  assert.deepEqual(body.transport, { type: 'webrtc', sdp: 'synthetic-offer' });
  assert.equal(session.configured, true);
});

test('GPT-Live adapter fails closed without API key and discards provider error text', async () => {
  let calls = 0;
  const missing = createLiveVoiceSession({ apiKey: '', fetchImpl: async () => { calls++; throw new Error('should not call'); } });
  assert.deepEqual(await missing('offer'), { ok: false, reason: 'not_configured' });
  assert.equal(calls, 0);
  const failing = createLiveVoiceSession({ apiKey: 'secret-test-key', fetchImpl: async () => new Response('private provider details', { status: 401, headers: { 'content-type': 'text/plain' } }) });
  assert.deepEqual(await failing('offer'), { ok: false, reason: 'provider_unavailable' });
  const malformed = createLiveVoiceSession({ apiKey: 'secret-test-key', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'private' } }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(await malformed('offer'), { ok: false, reason: 'provider_unavailable' });
  assert.deepEqual(await failing(''), { ok: false, reason: 'invalid_offer' });
});

test('voice endpoint requires same-origin explicit consent and never returns provider errors', async (t) => {
  let received;
  const server = http.createServer((req, res) => createHandler({
    port: Number(new URL(`http://${req.headers.host}`).port), getBoard: async () => ({ body: '{}', etag: 'x' }), voiceConfigured: true,
    startVoiceSession: async (sdp) => { received = sdp; return { ok: false, reason: 'provider_unavailable', providerText: 'secret diagnostic' }; },
  })(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/api/voice/session`;
  const headers = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  const noConsent = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ sdp: 'synthetic-offer' }) });
  assert.equal(noConsent.status, 400);
  assert.equal(received, undefined);
  const wrongOrigin = await fetch(url, { method: 'POST', headers: { ...headers, origin: 'http://example.invalid' }, body: JSON.stringify({ sdp: 'synthetic-offer', confirmed: true }) });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(received, undefined);
  const denied = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ sdp: 'synthetic-offer', confirmed: true }) });
  assert.equal(denied.status, 502);
  assert.deepEqual(await denied.json(), { error: 'voice_unavailable' });
  assert.equal(received, 'synthetic-offer');
});

class MemoryDb {
  stores = new Map();
  close() {}
  createObjectStore(name) { this.stores.set(name, new Map()); return { createIndex() {} }; }
  transaction(names) {
    const tx = { objectStore: (name) => {
      const map = this.stores.get(name);
      return {
        put: (row) => { map.set(row.id ?? row.key, structuredClone(row)); queueMicrotask(() => tx.oncomplete?.()); },
        getAll: () => { const request = {}; queueMicrotask(() => { request.result = [...map.values()].map((row) => structuredClone(row)); request.onsuccess?.(); }); return request; },
        get: (key) => { const request = {}; queueMicrotask(() => { request.result = structuredClone(map.get(key)); request.onsuccess?.(); }); return request; },
        delete: (key) => { map.delete(key); queueMicrotask(() => tx.oncomplete?.()); },
      };
    } };
    return tx;
  }
}

class MemoryFactory {
  db = new MemoryDb();
  created = false;
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = this.db;
      if (!this.created) { this.created = true; request.onupgradeneeded?.(); }
      request.onsuccess?.();
    });
    return request;
  }
}

test('browser voice store persists both audio tracks and transcript, lists and deletes them', async () => {
  const factory = new MemoryFactory();
  const session = { id: SESSION_ID, createdAt: 100, durationSeconds: 17, outcome: 'complete', transcript: [{ role: 'user', text: 'synthetic question' }, { role: 'assistant', text: 'synthetic answer' }] };
  await saveVoiceSession(session, { user: new Blob(['mic']), assistant: new Blob(['reply']) }, factory);
  assert.equal((await listVoiceSessions(factory))[0].transcript[1].text, 'synthetic answer');
  assert.equal(await (await getVoiceAudio(SESSION_ID, 'user', factory)).text(), 'mic');
  assert.equal(await (await getVoiceAudio(SESSION_ID, 'assistant', factory)).text(), 'reply');
  await deleteVoiceSession(SESSION_ID, factory);
  assert.deepEqual(await listVoiceSessions(factory), []);
  assert.equal(await getVoiceAudio(SESSION_ID, 'user', factory), null);
  assert.equal(await voiceStorageAvailable(factory), true);
  await assert.rejects(saveVoiceSession({ ...session, id: 'bad' }, { user: new Blob(['x']), assistant: new Blob(['y']) }, factory), /invalid_voice_record/);
});

test('browser voice store preserves an interrupted partial capture without inventing missing audio', async () => {
  const factory = new MemoryFactory();
  const session = { id: SESSION_ID, createdAt: 100, durationSeconds: 5, outcome: 'interrupted', transcript: [{ role: 'user', text: 'partial synthetic caption' }] };
  await saveVoiceSession(session, { user: new Blob(['partial mic']), assistant: null }, factory);
  assert.equal((await listVoiceSessions(factory))[0].outcome, 'interrupted');
  assert.equal(await (await getVoiceAudio(SESSION_ID, 'user', factory)).text(), 'partial mic');
  assert.equal(await getVoiceAudio(SESSION_ID, 'assistant', factory), null);
  await assert.rejects(saveVoiceSession({ ...session, id: 'voice_00000000-0000-4000-8000-000000000002', transcript: [] }, { user: null, assistant: null }, factory), /voice_capture_empty/);
});

test('voice recorder shutdown waits for final data and tolerates stop errors', async () => {
  const chunks = [];
  const listeners = new Map();
  const recorder = {
    state: 'recording',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['final chunk']) });
      listeners.get('stop')?.();
    },
  };
  recorder.ondataavailable = (event) => chunks.push(event.data);
  await stopVoiceRecorders({ user: recorder });
  assert.equal(await chunks[0].text(), 'final chunk');

  const broken = { state: 'recording', addEventListener() {}, removeEventListener() {}, stop() { throw new Error('synthetic stop failure'); } };
  await assert.doesNotReject(stopVoiceRecorders({ assistant: broken }));
});

test('GPT-Live caption projection accepts only bounded caption deltas', () => {
  assert.deepEqual(projectVoiceDelta({ type: 'session.input_transcript.delta', delta: 'question ' }), { role: 'user', delta: 'question ' });
  assert.deepEqual(projectVoiceDelta({ type: 'session.output_transcript.delta', delta: 'answer' }), { role: 'assistant', delta: 'answer' });
  assert.equal(projectVoiceDelta({ type: 'response.output_audio_transcript.delta', delta: 'wrong protocol' }), null);
  assert.equal(projectVoiceDelta({ type: 'session.input_transcript.delta', delta: 'x'.repeat(4097), secret: 'ignored' }), null);
  assert.equal(projectVoiceDelta({ type: 'session.closed', id: 'private-id', delta: 'not a caption' }), null);
  assert.equal(projectVoiceDelta({ type: 'session.output_transcript.delta', delta: { text: 'not text' } }), null);
  assert.equal(projectVoiceDelta('not an event'), null);
});

test('voice transcript keeps speaker turns ordered and joins only adjacent deltas', () => {
  const empty = [];
  const one = appendVoiceCaption(empty, { role: 'user', delta: 'Question' });
  const continued = appendVoiceCaption(one, { role: 'user', delta: ' one' });
  const answer = appendVoiceCaption(continued, { role: 'assistant', delta: 'Answer' });
  const nextQuestion = appendVoiceCaption(answer, { role: 'user', delta: 'Question two' });
  assert.deepEqual(nextQuestion, [
    { role: 'user', text: 'Question one' },
    { role: 'assistant', text: 'Answer' },
    { role: 'user', text: 'Question two' },
  ]);
  assert.deepEqual(empty, []);
});
