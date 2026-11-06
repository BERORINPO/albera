import { encodeRequest } from '../../src/runtime/wsl2-bridge-wire.mjs';

// Frames made by the Node wire, for the bridge's own harness to read through Wire.cs (test/wsl-bridge-harness/WireProbeChecks.cs). Replies go the other way: the harness encodes them with Wire.cs and must get
// the frame given here, which the Node test decodes. So both directions are checked by the other language's code, not by a second copy of the format.
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const framed = (payload) => Buffer.concat([u32(payload.length), payload]);
const lease = '{"lease":1}';
const path = 'repo/文字.txt';
const data = Buffer.from([0, 255, 10, 13]);

export const WIRE_PROBE_REPLIES = Object.freeze([
  { ok: true, reason: '', body: Buffer.alloc(0), frame: framed(Buffer.from([0])) },
  { ok: true, reason: '', body: Buffer.from([0xff, 0xff, 0xff, 0xfe, 3, 104, 105]), frame: framed(Buffer.from([0, 0xff, 0xff, 0xff, 0xfe, 3, 104, 105])) },
  { ok: false, reason: 'calls_exhausted', body: Buffer.alloc(0), frame: framed(Buffer.concat([Buffer.from([1]), Buffer.from('calls_exhausted', 'ascii')])) },
]);

export function wireProbe() {
  const request = (verb, frame, body) => ({ verb, id: 'op-1.a:b', frame: b64(frame), body: b64(body) });
  const name = Buffer.from(path, 'utf8');
  return {
    requests: [
      request(1, encodeRequest.begin('op-1.a:b', lease), Buffer.from(lease, 'utf8')),
      request(2, encodeRequest.run('op-1.a:b', 90, 'ls -la 文'), Buffer.concat([u32(90), Buffer.from('ls -la 文', 'utf8')])),
      request(3, encodeRequest.put('op-1.a:b', path, data), Buffer.concat([u32(name.length), name, data])),
      request(4, encodeRequest.get('op-1.a:b', path), name),
      request(5, encodeRequest.end('op-1.a:b'), Buffer.alloc(0)),
      request(6, encodeRequest.stop('op-1.a:b'), Buffer.alloc(0)),
    ],
    replies: WIRE_PROBE_REPLIES.map(({ ok, reason, body, frame }) => ({ ok, reason, body: b64(body), frame: b64(frame) })),
  };
}
