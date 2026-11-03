import net from 'node:net';
import { deflateSync } from 'node:zlib';

// Shared by desktop-client.test.mjs and desktop-helper-client.test.mjs: the Broker's frames, a PNG of the shape its encoder makes, and a scripted Broker on a named pipe.

/** One frame as the Broker and its clients speak it: [int32 little-endian length][payload]. */
export const frame = (body) => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const size = Buffer.alloc(4);
  size.writeInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
};

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, tail]);
};
/** An 8-bit truecolour PNG, the shape the Broker's encoder makes (signature, IHDR, IDAT, IEND). `brokenEnd` damages the last byte of IEND. */
export function png(width, height, { brokenEnd = false } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
  if (brokenEnd) bytes[bytes.length - 1] ^= 0xff;
  return bytes;
}

/**
 * A scripted Broker on a pipe this process owns. `script(body, index, connection)` runs for every request frame; `connection.send(x)` writes a frame, `connection.end()` closes. `state.received` is every
 * request body (as text), `state.bytes` the number of bytes any client sent. The caller closes `server`.
 */
export async function listenFakeBroker(pipe, script) {
  const state = { pipe, received: [], bytes: 0, connections: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    let buffer = Buffer.alloc(0);
    let index = 0;
    const connection = { send: (body) => socket.write(frame(body)), sendRaw: (bytes) => socket.write(bytes), end: () => socket.end() };
    socket.on('error', () => {});
    socket.on('data', (chunkBytes) => {
      state.bytes += chunkBytes.length;
      buffer = Buffer.concat([buffer, chunkBytes]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const length = buffer.readInt32LE(0);
        const body = buffer.subarray(4, 4 + length).toString('utf8');
        buffer = buffer.subarray(4 + length);
        state.received.push(body);
        script(body, index, connection);
        index += 1;
      }
    });
  });
  await new Promise((resolve) => server.listen(`\\\\.\\pipe\\${pipe}`, resolve));
  return { server, state };
}
