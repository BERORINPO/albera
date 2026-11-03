// Fake store for room-bootstrap-file.mjs, for tests. It keeps the files in memory, touches no disk and sets no ACL, and it
// records every ACL it was asked to apply. It refuses an ACL the real store would refuse, so a wrong ACL fails here too.
import { RoomBootstrapFileError, validBootstrapAcl } from './room-bootstrap-file.mjs';

/**
 * @param {{writeDelayMs?: number}} [options] `writeDelayMs` makes a write slow, to test that the host keeps the order of the codes.
 * @returns store `{ write, remove }` plus `files` (path -> {text, acl}), `writes` (every write, in order), `removes` and `failWrites(count)`.
 */
export function createFakeBootstrapStore({ writeDelayMs = 0 } = {}) {
  const files = new Map();
  const writes = [];
  const removes = [];
  let failing = 0;
  return {
    files, writes, removes,
    /** The next `count` writes fail (a disk or ACL error). */
    failWrites(count = 1) { failing = count; },
    /** The parsed content of a file, or null when it is not there. */
    read(filePath) { const file = files.get(filePath); return file ? JSON.parse(file.text) : null; },
    async write(filePath, text, acl) {
      if (writeDelayMs > 0) await new Promise((resolve) => { setTimeout(resolve, writeDelayMs); });
      if (!validBootstrapAcl(acl)) throw new RoomBootstrapFileError('bootstrap_file_write_failed');
      if (failing > 0) { failing--; throw new RoomBootstrapFileError('bootstrap_file_write_failed'); }
      writes.push({ filePath, text, acl });
      files.set(filePath, { text, acl });
    },
    async remove(filePath) { removes.push(filePath); files.delete(filePath); },
  };
}
