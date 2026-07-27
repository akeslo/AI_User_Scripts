// ==UserScript==
// @name         MCAS Auth Recovery (Teams / Outlook)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Detects Teams/Outlook hanging on the boot spinner behind the Defender for Cloud Apps (*.mcas.ms) reverse proxy, and recovers it by clearing the stale MSAL sign-in markers and re-navigating to the canonical origin so a real top-level auth redirect can run. Shows a cancellable countdown first; rate-limited so it can never redirect-loop.
// @author       akeslo
// @match        https://teams.cloud.microsoft.mcas.ms/*
// @match        https://outlook.cloud.microsoft.mcas.ms/*
// @match        https://teams.microsoft.com.mcas.ms/*
// @match        https://outlook.office.com.mcas.ms/*
// @match        https://outlook.office365.com.mcas.ms/*
// @grant        GM_addStyle
// @license      MIT
// @noframes
// @run-at       document-idle
// ==/UserScript==

// WHY THIS EXISTS
//
// Observed 2026-07-27 on https://teams.cloud.microsoft.mcas.ms/?ocdiRedirect=index:
// the tab sat on the boot spinner indefinitely. `document.readyState` was
// "complete", the load event had fired at 1.4s and 71 resources had downloaded,
// but `document.body.innerText` was empty and the only rendered node was a
// progressbar reading "Loading...".
//
// The cause was visible in MSAL's own telemetry in localStorage:
//
//   server-telemetry-<clientId> = {"errors":["interaction_required",
//                                            "failed_to_redirect"],"cacheHits":0}
//   tmp.auth.v1.GLOBAL.PreviousSignInProgressState = {"item":"Started",...}
//   tmp.default.default.react-web-client.incomplete-boot-attempts = "1"
//
// Read in order: the token cache was empty (`cacheHits: 0`, no `msal.account.*`
// keys at all), so the app attempted a silent token acquisition; Entra answered
// `interaction_required`, meaning only a real interactive sign-in will do; MSAL's
// remaining path was to navigate the top window to login.microsoftonline.com and
// that navigation did not happen (`failed_to_redirect`). With no token and no
// redirect the shell has nothing to render, so the spinner is a *terminal* state,
// not a slow one. Waiting never fixes it, and a plain F5 re-runs the same silent
// path against the same empty cache and usually hangs again.
//
// What does fix it is a top-level navigation to the canonical (non-proxied) app
// origin, which lets the auth redirect happen at the top level; MCAS re-proxies
// the session on the way back.
//
// DESIGN CONSTRAINTS
//
//  * @noframes is load-bearing. MSAL does silent renewal inside hidden iframes;
//    an auto-redirect firing inside one of those would break auth rather than fix
//    it, and could recurse.
//  * Two independent conditions must both hold before acting (dead shell AND
//    auth-failure evidence). Either alone is a false positive: a slow network
//    gives an empty body, and stale telemetry can outlive a session that then
//    booted fine.
//  * Rate limited and persisted per origin. An auth failure that the redirect
//    cannot fix (expired password, blocked CA policy) would otherwise become a
//    reload loop, which is worse than the spinner it replaces.
//  * The user gets a visible countdown with a Cancel button before anything
//    navigates, and cancelling is sticky for the rest of the tab's life.

(function () {
  'use strict';

  // ---------- Tunables -------------------------------------------------------

  const CFG = {
    // How long the page must have been up before a dead shell counts as stuck.
    // Teams cold-boots in ~2-4s on a good link; 30s is well past any legitimate
    // slow load and still far below a human's patience threshold.
    graceMs: 30_000,
    // Re-check on this interval until we either act or the app renders.
    pollMs: 5_000,
    // Above this much rendered text, the app shell is considered alive. The
    // stuck page measured 0; a booted Teams measures thousands.
    maxBodyTextLen: 40,
    // Seconds of cancellable countdown before navigating.
    countdownSec: 8,
    // At most this many auto-recoveries per origin per window. Beyond it the
    // banner stays up and says so, and nothing navigates.
    maxAttempts: 2,
    attemptWindowMs: 10 * 60_000,
    // Set true to log detection detail to the console on every poll.
    debug: false,
  };

  const STORE_KEY = '__mcasAuthRecovery.attempts';
  const CANCEL_KEY = '__mcasAuthRecovery.cancelled';

  // ---------- Pure logic (extracted by tests — see tests/helpers/loadMcasLogic.js)

  // PURE-LOGIC-START

  // Maps a proxied hostname to the app and the canonical origin to bounce to.
  // The canonical host is the same name with the ".mcas.ms" suffix removed,
  // which is exactly how the proxy rewrites it in the first place.
  function detectApp(hostname) {
    if (!hostname || !hostname.endsWith('.mcas.ms')) return null;
    const canonicalHost = hostname.slice(0, -'.mcas.ms'.length);
    if (/^teams\./.test(canonicalHost)) {
      return { app: 'teams', canonicalHost, target: `https://${canonicalHost}/` };
    }
    if (/^outlook\./.test(canonicalHost)) {
      return { app: 'outlook', canonicalHost, target: `https://${canonicalHost}/mail/` };
    }
    return null;
  }

  // Pulls auth-failure evidence out of localStorage entries. Returns a list of
  // signal names; empty means "no evidence of an auth failure", which is a hard
  // veto on acting no matter how empty the page looks.
  function scanAuthSignals(entries) {
    const signals = [];
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || typeof value !== 'string') continue;

      if (key.includes('server-telemetry')) {
        // MSAL writes the failed-request error codes here verbatim.
        for (const code of ['interaction_required', 'failed_to_redirect',
                            'login_required', 'no_tokens_found',
                            'monitor_window_timeout']) {
          if (value.includes(code)) signals.push(code);
        }
      }

      if (key.includes('PreviousSignInProgressState')) {
        try {
          const parsed = JSON.parse(value);
          // "Started" means sign-in began and never reached a terminal state.
          if (parsed && parsed.item === 'Started') signals.push('signin_stuck_started');
        } catch (_) { /* unparseable state tells us nothing */ }
      }

      if (key.includes('incomplete-boot-attempts')) {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n >= 1) signals.push('incomplete_boot');
      }
    }
    return [...new Set(signals)];
  }

  // The full stuck test. Both halves are required, deliberately.
  function isStuck({ elapsedMs, bodyTextLen, hasSpinner, signals }, cfg) {
    if (elapsedMs < cfg.graceMs) return { stuck: false, reason: 'within grace period' };
    if (bodyTextLen > cfg.maxBodyTextLen) return { stuck: false, reason: 'app shell rendered' };
    if (!signals.length) {
      // A dead shell with no auth evidence is a slow/broken load, not this bug.
      // Reloading it would be a guess, so we leave it alone.
      return { stuck: false, reason: 'no auth-failure evidence' };
    }
    return {
      stuck: true,
      reason: `dead shell (${bodyTextLen} chars${hasSpinner ? ', spinner present' : ''}) + ${signals.join(', ')}`,
    };
  }

  // Rate limiter. `history` is a list of epoch-ms timestamps of prior attempts.
  function shouldAttempt(now, history, cfg) {
    const recent = (history || []).filter(t => typeof t === 'number' && now - t < cfg.attemptWindowMs);
    return { allowed: recent.length < cfg.maxAttempts, recent };
  }

  // PURE-LOGIC-END

  // ---------- Storage access (impure, thin wrappers) --------------------------

  function readEntries() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        out.push([k, localStorage.getItem(k)]);
      }
    } catch (_) { /* storage partitioned or blocked; treated as no evidence */ }
    return out;
  }

  function readHistory() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }

  function writeHistory(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (_) {}
  }

  // Clears ONLY the markers that keep the app re-entering the dead auth path.
  // Deliberately narrow: this never calls localStorage.clear(), never touches a
  // token cache, and never touches keys belonging to another app. In the stuck
  // state the token cache is already empty, so there is nothing here to lose —
  // but a blanket wipe would sign the user out of a session that was merely
  // mid-renewal, which is a strictly worse outcome than the spinner.
  function purgeStaleAuthMarkers() {
    const doomed = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.includes('server-telemetry') ||
            k.includes('PreviousSignInProgressState') ||
            k.includes('incomplete-boot-attempts')) {
          doomed.push(k);
        }
      }
      doomed.forEach(k => localStorage.removeItem(k));
    } catch (_) {}
    return doomed;
  }

  // ---------- Page probes -----------------------------------------------------

  function bodyTextLen() {
    try { return (document.body && document.body.innerText || '').trim().length; }
    catch (_) { return 0; }
  }

  // Informational only -- it sharpens the message shown to the user but is not
  // part of the stuck test, since a spinner is present on a healthy cold boot too.
  function hasSpinner() {
    try { return !!document.querySelector('[role="progressbar"], progress'); }
    catch (_) { return false; }
  }

  function elapsedMs() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.startTime != null) return performance.now() - nav.startTime;
    } catch (_) {}
    return performance.now();
  }

  // ---------- UI --------------------------------------------------------------

  GM_addStyle(`
    #mcas-rec{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;
      max-width:min(560px,92vw);padding:14px 16px;border-radius:12px;
      background:#1f1f1f;color:#f3f3f3;border:1px solid #3d3d3d;
      box-shadow:0 12px 40px rgba(0,0,0,.55);
      font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    #mcas-rec b{color:#6cb6ff;font-weight:600}
    #mcas-rec .mcas-why{opacity:.72;font-size:12px;margin-top:6px}
    #mcas-rec .mcas-row{display:flex;gap:8px;align-items:center;margin-top:12px}
    #mcas-rec button{border:none;border-radius:7px;padding:7px 13px;font-size:12px;
      font-weight:600;cursor:pointer}
    #mcas-go{background:#0f6cbd;color:#fff}
    #mcas-cancel{background:#3d3d3d;color:#e8e8e8}
    #mcas-rec.mcas-quiet{opacity:.9}
  `);

  // Built with textContent only, never innerHTML. Same invariant the bulk-delete
  // scripts hold for log(): the strings here include page-derived values
  // (hostname, detection reason), and a userscript runs with the page's origin,
  // so an injected string would execute as first-party script.
  function banner({ title, why, primaryLabel, onPrimary, secondaryLabel, onSecondary }) {
    dismissBanner();
    const el = document.createElement('div');
    el.id = 'mcas-rec';

    const head = document.createElement('div');
    const strong = document.createElement('b');
    strong.textContent = title;
    head.appendChild(strong);

    const sub = document.createElement('div');
    sub.className = 'mcas-why';
    sub.textContent = why;

    const row = document.createElement('div');
    row.className = 'mcas-row';

    const primary = document.createElement('button');
    primary.id = 'mcas-go';
    primary.textContent = primaryLabel;
    primary.onclick = onPrimary;

    const secondary = document.createElement('button');
    secondary.id = 'mcas-cancel';
    secondary.textContent = secondaryLabel;
    secondary.onclick = onSecondary;

    row.append(primary, secondary);
    el.append(head, sub, row);
    (document.body || document.documentElement).appendChild(el);
    return { el, sub };
  }

  function dismissBanner() {
    const el = document.getElementById('mcas-rec');
    if (el) el.remove();
  }

  // ---------- Main loop -------------------------------------------------------

  const target = detectApp(location.hostname);
  if (!target) return;

  let acting = false;

  function recover() {
    const purged = purgeStaleAuthMarkers();
    const history = readHistory();
    history.push(Date.now());
    writeHistory(history.slice(-10));
    if (CFG.debug) console.log('[mcas-recovery] purged', purged, '-> navigating to', target.target);
    // Top-level navigation, deliberately not location.reload(): reloading the
    // proxied URL re-runs the same silent-auth path that already failed. Going
    // to the canonical origin is what lets the interactive redirect happen.
    location.assign(target.target);
  }

  function offerRecovery(reason) {
    if (acting) return;
    acting = true;

    const now = Date.now();
    const { allowed, recent } = shouldAttempt(now, readHistory(), CFG);

    if (!allowed) {
      banner({
        title: 'Teams/Outlook auth looks stuck — auto-recovery paused.',
        why: `Already retried ${recent.length} time(s) in the last ` +
             `${Math.round(CFG.attemptWindowMs / 60000)} minutes and it came back stuck, so ` +
             `something a reload cannot fix is wrong (expired password, MFA, or a ` +
             `conditional-access block). Sign in manually at ${target.canonicalHost}.`,
        primaryLabel: 'Try anyway',
        onPrimary: recover,
        secondaryLabel: 'Dismiss',
        onSecondary: dismissBanner,
      });
      return;
    }

    let left = CFG.countdownSec;
    const why = n =>
      `Detected: ${reason}. The token cache is empty and the sign-in redirect never fired, ` +
      `so this will not resolve on its own. Reopening ${target.canonicalHost} in ${n}s to ` +
      `force a real sign-in.`;

    // Rendered once; only the explanation's text node is rewritten per tick, so
    // the buttons keep their identity and a click can't land mid-rerender.
    const { sub } = banner({
      title: 'Teams/Outlook is stuck on the loading spinner.',
      why: why(left),
      primaryLabel: 'Go now',
      onPrimary: () => { clearInterval(tick); recover(); },
      secondaryLabel: 'Cancel',
      onSecondary: () => {
        clearInterval(tick);
        dismissBanner();
        // Sticky for this tab only -- a fresh tab gets a fresh judgement.
        try { sessionStorage.setItem(CANCEL_KEY, '1'); } catch (_) {}
      },
    });

    const tick = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(tick); recover(); return; }
      sub.textContent = why(left);
    }, 1000);
  }

  const poll = setInterval(() => {
    try { if (sessionStorage.getItem(CANCEL_KEY)) { clearInterval(poll); return; } } catch (_) {}
    if (acting) return;

    const signals = scanAuthSignals(readEntries());
    const verdict = isStuck({
      elapsedMs: elapsedMs(),
      bodyTextLen: bodyTextLen(),
      hasSpinner: hasSpinner(),
      signals,
    }, CFG);

    if (CFG.debug) console.log('[mcas-recovery]', verdict, signals);

    if (verdict.stuck) {
      clearInterval(poll);
      offerRecovery(verdict.reason);
    }
  }, CFG.pollMs);

  // Once the app renders, stop watching entirely -- no timers left running in a
  // healthy Teams tab that may stay open for days.
  const settled = setInterval(() => {
    if (!acting && bodyTextLen() > CFG.maxBodyTextLen && elapsedMs() > CFG.graceMs) {
      clearInterval(poll);
      clearInterval(settled);
      if (CFG.debug) console.log('[mcas-recovery] app booted, watcher off');
    }
  }, CFG.pollMs);
})();
