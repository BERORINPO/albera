// Stand-in for git.mjs. Give it the log text, last commit and work tree top it should return.
import { GitUnavailable } from './git.mjs';

export function createFakeGit({ logText = '', lastCommit = null, fail = null, top = null } = {}) {
  const calls = [];
  const guard = () => { if (fail) throw new GitUnavailable(fail); };
  return {
    calls,
    topLevel(dir) {
      calls.push(['topLevel', dir]);
      guard();
      return top ?? dir;
    },
    lastCommit(dir) {
      calls.push(['lastCommit', dir]);
      guard();
      return lastCommit;
    },
    log(dir, sinceIso) {
      calls.push(['log', dir, sinceIso]);
      guard();
      return logText;
    },
  };
}
