// ==UserScript==
// @name         Claude Bulk Deleter
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Bulk delete Claude.ai chats. Auto detects org id, paginates, keeps log visible on error.
// @author       akeslo
// @match        https://claude.ai/*
// @grant        GM_addStyle
// @license      MIT
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Leave blank to auto detect from /api/bootstrap. Or hardcode your org id here.
  let orgId = "";

  window.__CLAUDE_BD_SUP__ = window.__CLAUDE_BD_SUP__ || {
    mounted: false,
    running: false,
    armed: false,
    logStore: [],
    ensureTimer: null,
    lastUrl: location.href,
    chats: []
  };
  const S = window.__CLAUDE_BD_SUP__;

  GM_addStyle(`
    #bd-btn{position:fixed;top:12px;left:12px;z-index:2147483647;padding:10px 14px;border:none;border-radius:10px;background:#D97757;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}
    #bd-btn[disabled]{opacity:.6;cursor:not-allowed}
    #bd-log{position:fixed;bottom:12px;left:12px;width:520px;max-height:55vh;overflow:auto;border:1px solid #2e2e2e;background:#111;color:#ddd;border-radius:10px;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.35);font:12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;display:none}
    #bd-log header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #2e2e2e;background:#181818;border-top-left-radius:10px;border-top-right-radius:10px}
    #bd-log header b{font-size:12px}
    #bd-log header button{background:#333;border:1px solid #444;color:#eee;border-radius:6px;padding:4px 8px;cursor:pointer;margin-left:4px}
    #bd-log pre{white-space:pre-wrap;margin:0;padding:10px;line-height:1.35}
  `);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = sel => document.querySelector(sel);
  const apiBase = () => `${location.origin}/api/organizations/${orgId}`;

  function showLog(show) {
    const el = get('#bd-log');
    if (el) el.style.display = show ? 'block' : 'none';
  }

  function log(...a) {
    const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    S.logStore.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    const pre = get('#bd-pre');
    if (pre) pre.textContent = S.logStore.join('\n');
    console.log('[ClaudeBulkDeleter]', ...a);
  }

  // Pull common headers Claude's own UI sends. Helps with CSRF style checks.
  function commonHeaders(extra) {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    // some deployments check this header
    h['anthropic-client-platform'] = 'web_claude_ai';
    return Object.assign(h, extra || {});
  }

  async function detectOrgId() {
    if (orgId) return orgId;
    try {
      const r = await fetch(`${location.origin}/api/bootstrap`, {
        credentials: 'include',
        cache: 'no-store',
        headers: commonHeaders()
      });
      if (!r.ok) {
        log(`bootstrap failed status ${r.status}`);
        return "";
      }
      const j = await r.json();
      // shape varies. try a few common spots.
      const candidates = [];
      if (j && j.account && Array.isArray(j.account.memberships)) {
        for (const m of j.account.memberships) {
          if (m && m.organization && m.organization.uuid) candidates.push(m.organization.uuid);
        }
      }
      if (Array.isArray(j.organizations)) {
        for (const o of j.organizations) if (o && o.uuid) candidates.push(o.uuid);
      }
      if (j && j.organization && j.organization.uuid) candidates.push(j.organization.uuid);
      if (candidates.length) {
        orgId = candidates[0];
        log(`auto detected org id ${orgId}`);
        if (candidates.length > 1) {
          log(`note: ${candidates.length} orgs found, using the first. Edit script if wrong.`);
        }
        return orgId;
      }
      log('could not find org id in bootstrap. Open DevTools network tab, find /api/bootstrap, copy your uuid into the orgId variable.');
      return "";
    } catch (e) {
      log(`bootstrap error ${String(e)}`);
      return "";
    }
  }

  async function fetchAllChats() {
    if (!orgId) {
      log('no org id, cannot fetch chats');
      return [];
    }
    // try paginated first, fall back to plain
    const all = [];
    const seen = new Set();
    let page = 0;
    let url = `${apiBase()}/chat_conversations?limit=100&offset=0`;
    while (true) {
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          headers: commonHeaders()
        });
        if (!resp.ok) {
          log(`fetch chats failed status ${resp.status} url ${url}`);
          // if first paginated try fails with 400 or 422, retry without params once
          if (page === 0 && (resp.status === 400 || resp.status === 422)) {
            log('retrying without pagination params');
            const r2 = await fetch(`${apiBase()}/chat_conversations`, {
              credentials: 'include',
              cache: 'no-store',
              headers: commonHeaders()
            });
            if (!r2.ok) {
              log(`plain fetch also failed status ${r2.status}`);
              return all;
            }
            const data = await r2.json();
            const arr = Array.isArray(data) ? data : (Array.isArray(data.conversations) ? data.conversations : []);
            for (const c of arr) {
              if (c && c.uuid && !seen.has(c.uuid)) { seen.add(c.uuid); all.push(c); }
            }
            log(`fetched ${all.length} chats (plain)`);
            return all;
          }
          return all;
        }
        const data = await resp.json();
        const arr = Array.isArray(data) ? data : (Array.isArray(data.conversations) ? data.conversations : []);
        let added = 0;
        for (const c of arr) {
          if (c && c.uuid && !seen.has(c.uuid)) { seen.add(c.uuid); all.push(c); added++; }
        }
        log(`page ${page} returned ${arr.length} (new ${added}, total ${all.length})`);
        if (arr.length < 100) break; // last page
        page++;
        url = `${apiBase()}/chat_conversations?limit=100&offset=${page * 100}`;
        if (page > 200) { log('safety stop at 200 pages'); break; }
      } catch (e) {
        log(`fetch error ${String(e)}`);
        break;
      }
    }
    log(`total chats fetched ${all.length}`);
    return all;
  }

  async function deleteChat(chat) {
    const url = `${apiBase()}/chat_conversations/${chat.uuid}`;
    try {
      const res = await fetch(url, {
        method: 'DELETE',
        credentials: 'include',
        headers: commonHeaders()
      });
      if (res.ok) {
        log(`ok "${chat.name || '(no title)'}" ${chat.uuid}`);
        return true;
      } else {
        let body = '';
        try { body = (await res.text()).slice(0, 200); } catch {}
        log(`fail status ${res.status} "${chat.name || '(no title)'}" ${chat.uuid} body ${body}`);
        return false;
      }
    } catch (e) {
      log(`error delete ${chat.uuid} ${String(e)}`);
      return false;
    }
  }

  function mountUI() {
    let btn = get('#bd-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'bd-btn';
      btn.textContent = 'Delete All Chats';
      btn.addEventListener('click', onButtonClick, { passive: true });
      document.body.appendChild(btn);
    }

    let box = get('#bd-log');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bd-log';
      box.innerHTML = `
        <header>
          <b>Claude Bulk Deleter Log</b>
          <div>
            <button id="bd-show">Show/Hide</button>
            <button id="bd-copy">Copy</button>
            <button id="bd-clear">Clear</button>
          </div>
        </header>
        <pre id="bd-pre"></pre>
      `;
      document.body.appendChild(box);
    }

    const clearBtn = get('#bd-clear');
    const copyBtn  = get('#bd-copy');
    if (clearBtn && !clearBtn.__bdHooked) {
      clearBtn.__bdHooked = true;
      clearBtn.onclick = () => {
        S.logStore.length = 0;
        const pre = get('#bd-pre');
        if (pre) pre.textContent = '';
      };
    }
    if (copyBtn && !copyBtn.__bdHooked) {
      copyBtn.__bdHooked = true;
      copyBtn.onclick = () => navigator.clipboard.writeText(S.logStore.join('\n')).catch(() => {});
    }

    S.mounted = true;
  }

  function ensureUI() {
    if (!document.body) return;
    if (!get('#bd-btn') || !get('#bd-log')) mountUI();
  }

  function hookSPARouteChanges() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    function onChange() {
      if (S.lastUrl !== location.href) {
        S.lastUrl = location.href;
        setTimeout(ensureUI, 50);
        setTimeout(ensureUI, 300);
        setTimeout(ensureUI, 1200);
      }
    }
    history.pushState = function () {
      const r = origPush.apply(this, arguments);
      onChange();
      return r;
    };
    history.replaceState = function () {
      const r = origReplace.apply(this, arguments);
      onChange();
      return r;
    };
    window.addEventListener('popstate', onChange);
    new MutationObserver(() => ensureUI()).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd') ensureUI();
    if (e.shiftKey && e.key.toLowerCase() === 'd') {
      const el = get('#bd-log');
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
  });

  async function onButtonClick() {
    if (S.running) return;
    const btn = get('#bd-btn');

    if (!S.armed) {
      S.running = true;
      showLog(true);
      btn.disabled = true;
      btn.textContent = 'Scanning...';
      log('scan start');

      if (!orgId) await detectOrgId();
      if (!orgId) {
        log('no org id available, aborting');
        btn.disabled = false;
        btn.textContent = 'Delete All Chats';
        S.running = false;
        // keep log visible so user sees the error
        return;
      }

      const chats = await fetchAllChats();
      S.chats = chats || [];

      S.running = false;
      btn.disabled = false;

      if (!S.chats.length) {
        log('no chats found. If you have chats, the API shape may have changed. Check Network tab for /chat_conversations.');
        btn.textContent = 'Delete All Chats';
        // keep log visible for diagnosis
        return;
      }

      // success, hide the log to avoid clutter before the second click
      showLog(false);
      S.armed = true;
      btn.textContent = `Click again to delete ${S.chats.length} chats`;
      log(`armed with ${S.chats.length} chats`);
      return;
    }

    if (S.armed) {
      S.armed = false;
      S.running = true;
      showLog(true);
      btn.disabled = true;

      const chats = Array.isArray(S.chats) ? S.chats : [];
      if (!chats.length) {
        log('no chats in memory, aborting');
        btn.disabled = false;
        btn.textContent = 'Delete All Chats';
        S.running = false;
        return;
      }

      if (!confirm(`This will permanently delete ${chats.length} chats.\n\nAre you sure?`)) {
        log('user cancelled');
        btn.disabled = false;
        btn.textContent = 'Delete All Chats';
        S.running = false;
        showLog(false);
        return;
      }

      let ok = 0, fail = 0;
      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        btn.textContent = `Deleting ${i + 1}/${chats.length}...`;
        const good = await deleteChat(chat);
        if (good) ok++; else fail++;
        await sleep(500);
      }

      log(`done ok ${ok} fail ${fail}`);
      btn.textContent = 'Delete All Chats';
      btn.disabled = false;
      S.running = false;
      // leave log visible if anything failed
      if (fail === 0) {
        showLog(false);
        if (ok > 0) setTimeout(() => location.reload(), 1200);
      }
    }
  }

  function boot() {
    if (!document.body) { requestAnimationFrame(boot); return; }
    ensureUI();
    hookSPARouteChanges();
    if (!S.ensureTimer) S.ensureTimer = setInterval(ensureUI, 1500);
  }

  boot();
})();