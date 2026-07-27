import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBlock } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(__dirname, '..', '..', 'MCAS Auth Recovery.user.js');

export const mcasSrc = readFileSync(SRC_PATH, 'utf8');

// The same source with whole-line comments removed. The script's comments
// discuss the very calls the invariant tests forbid ("never calls
// localStorage.clear()"), so asserting against raw source would fail on the
// prose explaining why the code is safe.
export const mcasCode = mcasSrc
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

// The userscript brackets its side-effect-free detection logic with these
// markers precisely so it can be tested without a DOM, a browser, or a
// Microsoft session. If the block is renamed or moved, extractBlock throws
// rather than silently testing nothing.
const BLOCK = extractBlock(mcasSrc, '// PURE-LOGIC-START', '// PURE-LOGIC-END');

const BODY = `
  ${BLOCK}
  return { detectApp, scanAuthSignals, isStuck, shouldAttempt };
`;

export function loadMcasLogic() {
  return new Function(BODY)();
}

// The tunables the userscript ships with, mirrored here so the tests exercise
// the real thresholds rather than invented ones.
export const CFG = {
  graceMs: 60_000,
  maxBodyTextLen: 40,
  maxAttempts: 2,
  attemptWindowMs: 10 * 60_000,
};
