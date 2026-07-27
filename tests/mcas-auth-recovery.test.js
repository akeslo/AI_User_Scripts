import { describe, it, expect, beforeAll } from 'vitest';
import { loadMcasLogic, CFG, mcasSrc, mcasCode } from './helpers/loadMcasLogic.js';

let detectApp, scanAuthSignals, isStuck, shouldAttempt;

beforeAll(() => {
  ({ detectApp, scanAuthSignals, isStuck, shouldAttempt } = loadMcasLogic());
});

describe('detectApp', () => {
  it('maps the proxied Teams host to the canonical origin', () => {
    expect(detectApp('teams.cloud.microsoft.mcas.ms')).toEqual({
      app: 'teams',
      canonicalHost: 'teams.cloud.microsoft',
      target: 'https://teams.cloud.microsoft/',
    });
  });

  it('maps the proxied Outlook host to the mail deep link', () => {
    expect(detectApp('outlook.cloud.microsoft.mcas.ms')).toEqual({
      app: 'outlook',
      canonicalHost: 'outlook.cloud.microsoft',
      target: 'https://outlook.cloud.microsoft/mail/',
    });
  });

  it('handles the legacy proxied hostnames', () => {
    expect(detectApp('teams.microsoft.com.mcas.ms').target).toBe('https://teams.microsoft.com/');
    expect(detectApp('outlook.office.com.mcas.ms').target).toBe('https://outlook.office.com/mail/');
  });

  it('ignores non-proxied hosts, so the script never fires on a direct session', () => {
    expect(detectApp('teams.cloud.microsoft')).toBeNull();
    expect(detectApp('outlook.office.com')).toBeNull();
  });

  it('ignores other apps behind the same proxy', () => {
    expect(detectApp('sharepoint.com.mcas.ms')).toBeNull();
    expect(detectApp('')).toBeNull();
    expect(detectApp(undefined)).toBeNull();
  });

  it('does not match a lookalike host that merely contains .mcas.ms', () => {
    expect(detectApp('teams.cloud.microsoft.mcas.ms.evil.example')).toBeNull();
  });
});

describe('scanAuthSignals', () => {
  // Verbatim from the stuck tab observed 2026-07-27.
  const REAL_TELEMETRY =
    '{"failedRequests":[863,"Core-1e8ee981-530a-4db9-8d9e-3d33fc2d7333",861,' +
    '"019fa2c7-a382-7ee0-810a-b52729e365ee"],"errors":["interaction_required",' +
    '"failed_to_redirect"],"cacheHits":0}';

  it('extracts both MSAL error codes from the real failing payload', () => {
    const signals = scanAuthSignals([
      ['server-telemetry-5e3ce6c0-2b1f-4285-8d4b-75ee78787346', REAL_TELEMETRY],
    ]);
    expect(signals).toContain('interaction_required');
    expect(signals).toContain('failed_to_redirect');
  });

  it('flags a sign-in that started and never finished', () => {
    const signals = scanAuthSignals([
      ['tmp.auth.v1.GLOBAL.PreviousSignInProgressState.PreviousSignInProgressState',
       '{"item":"Started","shouldRefresh":false,"hitCount":0}'],
    ]);
    expect(signals).toEqual(['signin_stuck_started']);
  });

  it('does not flag a sign-in that reached a terminal state', () => {
    const signals = scanAuthSignals([
      ['tmp.auth.v1.GLOBAL.PreviousSignInProgressState.PreviousSignInProgressState',
       '{"item":"Completed","shouldRefresh":false,"hitCount":0}'],
    ]);
    expect(signals).toEqual([]);
  });

  it('flags a non-zero incomplete-boot counter but not a zero one', () => {
    expect(scanAuthSignals([['tmp.default.default.react-web-client.incomplete-boot-attempts', '1']]))
      .toEqual(['incomplete_boot']);
    expect(scanAuthSignals([['tmp.default.default.react-web-client.incomplete-boot-attempts', '0']]))
      .toEqual([]);
  });

  it('returns nothing for a healthy session, which vetoes any action', () => {
    const signals = scanAuthSignals([
      ['msal.version', '5.6.3'],
      ['timezone', 'America/New_York'],
      ['tmp.deviceId', 'b7db4251-1866-47f8-a0ff-4a77318aef91'],
      ['server-telemetry-abc', '{"failedRequests":[],"errors":[],"cacheHits":12}'],
    ]);
    expect(signals).toEqual([]);
  });

  it('survives unparseable and non-string values without throwing', () => {
    expect(() => scanAuthSignals([
      ['tmp.auth.v1.GLOBAL.PreviousSignInProgressState', 'not json {{{'],
      ['server-telemetry-x', null],
      [null, 'orphan'],
      ['tmp.incomplete-boot-attempts', 'NaN'],
    ])).not.toThrow();
    expect(scanAuthSignals([['tmp.auth.PreviousSignInProgressState', 'not json {{{']])).toEqual([]);
  });

  it('deduplicates a code that appears in several telemetry keys', () => {
    const signals = scanAuthSignals([
      ['server-telemetry-a', '{"errors":["interaction_required"]}'],
      ['server-telemetry-b', '{"errors":["interaction_required"]}'],
    ]);
    expect(signals).toEqual(['interaction_required']);
  });
});

describe('isStuck', () => {
  const stuckShell = { elapsedMs: 100_000, bodyTextLen: 0, hasSpinner: true };

  it('fires on the observed signature: dead shell past grace, with auth evidence', () => {
    const v = isStuck({ ...stuckShell, signals: ['interaction_required', 'failed_to_redirect'] }, CFG);
    expect(v.stuck).toBe(true);
    expect(v.reason).toMatch(/interaction_required/);
  });

  it('waits out the grace period rather than racing a slow cold boot', () => {
    const v = isStuck({ ...stuckShell, elapsedMs: 5_000, signals: ['interaction_required'] }, CFG);
    expect(v.stuck).toBe(false);
    expect(v.reason).toBe('within grace period');
  });

  it('never fires once the app shell has rendered', () => {
    const v = isStuck({ ...stuckShell, bodyTextLen: 4000, signals: ['interaction_required'] }, CFG);
    expect(v.stuck).toBe(false);
    expect(v.reason).toBe('app shell rendered');
  });

  it('refuses to act on a blank page with no auth evidence', () => {
    // This is the guard that keeps a slow network or an unrelated outage from
    // triggering a redirect the user did not ask for.
    const v = isStuck({ ...stuckShell, signals: [] }, CFG);
    expect(v.stuck).toBe(false);
    expect(v.reason).toBe('no auth-failure evidence');
  });

  it('treats a body just over the text threshold as alive', () => {
    expect(isStuck({ ...stuckShell, bodyTextLen: CFG.maxBodyTextLen + 1, signals: ['x'] }, CFG).stuck)
      .toBe(false);
    expect(isStuck({ ...stuckShell, bodyTextLen: CFG.maxBodyTextLen, signals: ['x'] }, CFG).stuck)
      .toBe(true);
  });
});

describe('shouldAttempt', () => {
  const now = 1_700_000_000_000;

  it('allows the first recovery', () => {
    expect(shouldAttempt(now, [], CFG).allowed).toBe(true);
  });

  it('stops after the cap, so a redirect can never loop', () => {
    const history = [now - 1000, now - 2000];
    const { allowed, recent } = shouldAttempt(now, history, CFG);
    expect(allowed).toBe(false);
    expect(recent).toHaveLength(2);
  });

  it('forgets attempts older than the window', () => {
    const history = [now - CFG.attemptWindowMs - 1, now - CFG.attemptWindowMs - 2];
    expect(shouldAttempt(now, history, CFG).allowed).toBe(true);
  });

  it('ignores corrupt history entries instead of throwing', () => {
    expect(shouldAttempt(now, ['garbage', null, undefined, now - 500], CFG))
      .toEqual({ allowed: true, recent: [now - 500] });
    expect(shouldAttempt(now, null, CFG).allowed).toBe(true);
  });
});

describe('script invariants', () => {
  it('runs only at the top level, since MSAL renews tokens in hidden iframes', () => {
    expect(mcasSrc).toMatch(/^\/\/ @noframes\s*$/m);
  });

  it('never wipes storage wholesale', () => {
    expect(mcasCode).not.toMatch(/localStorage\.clear\(/);
    expect(mcasCode).not.toMatch(/sessionStorage\.clear\(/);
  });

  it('builds its banner with textContent, never innerHTML', () => {
    // Same XSS invariant the bulk-delete scripts hold for log().
    expect(mcasCode).not.toMatch(/\.innerHTML\s*=/);
    expect(mcasCode).toMatch(/\.textContent\s*=/);
  });

  it('navigates to the canonical origin rather than reloading the dead page', () => {
    expect(mcasCode).toMatch(/location\.assign\(target\.target\)/);
    expect(mcasCode).not.toMatch(/location\.reload\(/);
  });
});
