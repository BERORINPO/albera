// entry adapter: explicit, user-started GPT-Live WebRTC session creation.
// API key and provider error bodies never cross back into the browser or logs.

const LIVE_URL = 'https://api.openai.com/v1/live/sessions';
const MODEL = 'gpt-live-1';
const MAX_SDP = 128_000;

/** @param {{apiKey?: string, fetchImpl?: typeof fetch}} [options] */
export function createLiveVoiceSession({ apiKey = process.env.OPENAI_API_KEY ?? '', fetchImpl = fetch } = {}) {
  const startVoiceSession = async function startVoiceSession(sdp) {
    if (typeof sdp !== 'string' || !sdp.trim() || sdp.length > MAX_SDP) return { ok: false, reason: 'invalid_offer' };
    if (!apiKey) return { ok: false, reason: 'not_configured' };
    let response;
    try {
      response = await fetchImpl(LIVE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          session: {
            model: MODEL,
            store: false,
            delegation: { type: 'client' },
            audio: { output: { voice: 'marin' } },
            client: { data_channel: {
              allowed_client_events: [],
              allowed_server_events: ['session.started', 'session.closed', 'session.input_transcript.delta', 'session.output_transcript.delta', 'session.usage.updated', 'error'],
            } },
          },
          transport: { type: 'webrtc', sdp },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return { ok: false, reason: 'provider_unavailable' };
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) return { ok: false, reason: 'provider_unavailable' };
      const text = await response.text();
      if (text.length > MAX_SDP + 4096) return { ok: false, reason: 'provider_unavailable' };
      const value = JSON.parse(text);
      const id = value?.session?.id;
      const answer = value?.transport?.sdp;
      if (typeof id !== 'string' || !/^live_[A-Za-z0-9_-]{1,128}$/.test(id) || typeof answer !== 'string' || !answer.trim() || answer.length > MAX_SDP) return { ok: false, reason: 'provider_unavailable' };
      return { ok: true, sessionId: id, answerSdp: answer };
    } catch {
      return { ok: false, reason: 'provider_unavailable' };
    }
  };
  Object.defineProperty(startVoiceSession, 'configured', { value: Boolean(apiKey) });
  return startVoiceSession;
}

export const LIVE_VOICE_MAX_SDP = MAX_SDP;
