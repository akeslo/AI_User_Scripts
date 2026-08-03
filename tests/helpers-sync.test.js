// Runs validate-helpers-sync.js as part of `npm test`.
//
// Why this exists: the validator is the ONLY enforcement of two invariants this
// repo documents as enforced — the XSS-safety rule that log() uses textContent
// and never innerHTML in every duplicated copy, and the requirement that the
// hand-mirrored sleep/get/showLog/log helpers keep identical signatures across
// the three bulk deleters. Until this file existed, `npm run check-sync` was a
// separate script nobody ran automatically and there is no CI workflow in the
// repo at all, so a commit that broke either invariant passed the only
// automated gate (`npm test`) completely clean. Shelling out to the real
// validator rather than reimplementing its checks here keeps a single source of
// truth: `npm run check-sync` and `npm test` cannot drift apart.

import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('validate-helpers-sync.js', () => {
  it('passes: helper markers, signatures, and the no-innerHTML invariant all hold', () => {
    let stdout = '';
    let failure = null;

    try {
      stdout = execFileSync(process.execPath, ['validate-helpers-sync.js'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // execFileSync throws on a non-zero exit. The validator prints its
      // specific failures to stderr, so surface them instead of just the code.
      failure = `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message;
    }

    expect(failure, failure ? `check-sync failed:\n${failure}` : undefined).toBeNull();
    expect(stdout).toContain('All sync checks passed!');
  });
});
