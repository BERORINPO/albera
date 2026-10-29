// Content identity for an executable observed through one open file handle.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const IDENTITY_FIELDS = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'];

/**
 * Capture metadata and a SHA-256 digest from the same opened file. This detects
 * in-place content edits that metadata-only identity checks can miss. It does
 * not pin a later path-based OS process creation to this handle.
 */
export async function captureExecutableIdentity(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('not_regular_file');

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (!Number.isSafeInteger(position)) throw new Error('file_too_large');
    }

    const after = await handle.stat({ bigint: true });
    if (identityMetadata(before) !== identityMetadata(after) || BigInt(position) !== after.size) {
      throw new Error('file_changed_during_capture');
    }
    return Object.freeze({
      ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, String(after[field])])),
      sha256: hash.digest('hex'),
    });
  } finally {
    await handle.close();
  }
}

export function sameExecutableIdentity(left, right) {
  return Boolean(left && right && IDENTITY_FIELDS.every((field) => left[field] === right[field])
    && left.sha256 === right.sha256);
}

function identityMetadata(stats) {
  return IDENTITY_FIELDS.map((field) => String(stats[field])).join(':');
}
