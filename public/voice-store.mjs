// Browser persistence adapter: voice recordings never reach the Pigeonholes server.

const DB_NAME = 'pigeonholes:voice';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';
const AUDIO_STORE = 'audio';

/** @param {IDBFactory} factory */
function openDb(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const sessions = db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      sessions.createIndex('createdAt', 'createdAt');
      db.createObjectStore(AUDIO_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('voice_storage_unavailable'));
    request.onblocked = () => reject(new Error('voice_storage_blocked'));
  });
}

/** @param {IDBRequest} request */
const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('voice_storage_unavailable'));
});

/** @param {{id:string,createdAt:number,durationSeconds:number,transcript:Array<{role:string,text:string}>}} session @param {{user:Blob,assistant:Blob}} audio @param {IDBFactory} [factory] */
export async function saveVoiceSession(session, audio, factory = indexedDB) {
  if (!session || !/^voice_[0-9a-f-]{36}$/i.test(session.id) || !Number.isSafeInteger(session.createdAt) || session.createdAt < 0 || !Number.isFinite(session.durationSeconds) || session.durationSeconds < 0 || !Array.isArray(session.transcript) || session.transcript.length > 10_000 || !session.transcript.every((line) => ['user', 'assistant'].includes(line.role) && typeof line.text === 'string' && line.text.length <= 100_000) || session.transcript.reduce((sum, line) => sum + line.text.length, 0) > 1_000_000) throw new Error('invalid_voice_record');
  if (!(audio?.user instanceof Blob) || !(audio?.assistant instanceof Blob) || !audio.user.size || !audio.assistant.size) throw new Error('voice_audio_missing');
  const db = await openDb(factory);
  try {
    const tx = db.transaction([SESSION_STORE, AUDIO_STORE], 'readwrite');
    tx.objectStore(SESSION_STORE).put({ ...session, transcript: session.transcript.map(({ role, text }) => ({ role, text })) });
    tx.objectStore(AUDIO_STORE).put({ key: `${session.id}:user`, blob: audio.user, type: audio.user.type });
    tx.objectStore(AUDIO_STORE).put({ key: `${session.id}:assistant`, blob: audio.assistant, type: audio.assistant.type });
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(new Error('voice_storage_unavailable'));
      tx.onabort = () => reject(new Error('voice_storage_unavailable'));
    });
  } finally { db.close(); }
}

/** @param {IDBFactory} [factory] */
export async function listVoiceSessions(factory = indexedDB) {
  const db = await openDb(factory);
  try {
    const tx = db.transaction(SESSION_STORE, 'readonly');
    const rows = await requestResult(tx.objectStore(SESSION_STORE).getAll());
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } finally { db.close(); }
}

/** @param {string} id @param {'user'|'assistant'} role @param {IDBFactory} [factory] */
export async function getVoiceAudio(id, role, factory = indexedDB) {
  if (!/^voice_[0-9a-f-]{36}$/i.test(id) || !['user', 'assistant'].includes(role)) throw new Error('invalid_voice_record');
  const db = await openDb(factory);
  try {
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    return (await requestResult(tx.objectStore(AUDIO_STORE).get(`${id}:${role}`)))?.blob ?? null;
  } finally { db.close(); }
}

/** @param {string} id @param {IDBFactory} [factory] */
export async function deleteVoiceSession(id, factory = indexedDB) {
  if (!/^voice_[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid_voice_record');
  const db = await openDb(factory);
  try {
    const tx = db.transaction([SESSION_STORE, AUDIO_STORE], 'readwrite');
    tx.objectStore(SESSION_STORE).delete(id);
    tx.objectStore(AUDIO_STORE).delete(`${id}:user`);
    tx.objectStore(AUDIO_STORE).delete(`${id}:assistant`);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(new Error('voice_storage_unavailable'));
      tx.onabort = () => reject(new Error('voice_storage_unavailable'));
    });
  } finally { db.close(); }
}

export async function voiceStorageAvailable(factory = globalThis.indexedDB) {
  if (!factory) return false;
  try { const db = await openDb(factory); db.close(); return true; }
  catch { return false; }
}
