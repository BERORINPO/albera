function waitForSignal(signal, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    Promise.resolve(signal).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value === true);
    });
  });
}

/** Request an orderly GPT-Live close. Returns true only after session.closed. */
export async function requestLiveSessionClose({ channel, isStarted, isClosed, startedSignal, closedSignal, closeEventId, timeoutMs = 5000 }) {
  if (!channel || channel.readyState !== 'open' || typeof channel.send !== 'function') return false;
  if (isClosed?.()) return true;
  if (!isStarted?.() && !await waitForSignal(startedSignal, timeoutMs)) return false;
  if (isClosed?.()) return true;
  try {
    channel.send(JSON.stringify({ type: 'session.close', event_id: closeEventId }));
  } catch {
    return false;
  }
  return waitForSignal(closedSignal, timeoutMs);
}
