// ==UserScript==
// @name         Claude Bulk Deleter
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Button to bulk delete all Claude.ai chats with log, two click confirmation, and auto remount UI
// @author       akeslo
// @match        https://claude.ai/*
// @grant        GM_addStyle
// @license      MIT
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Replace this with your own org id from claude.ai
  const orgId = "4befc324-fd04-42d4-9b05-d0c21d644337";

  // supervisor object
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

  // ---------- UI ----------
  GM_addStyle(`
    #bd-btn{position:fixed;top:12px;left:12px;z-index:2147483647;padding:10px 14px;border:none;border-radius:10px;background:#D97757;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}
    #bd-btn[disabled]{opacity:.6;cursor:not-allowed}
    #bd-log{position:fixed;bottom:12px;left:12px;width:460px;max-height:55vh;overflow:auto;border:1px solid #2e2e2e;background:#111;color:#ddd;border-radius:10px;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.35);font:12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;display:none}
    #bd-log header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #2e2e2e;background:#181818;border-top-left-radius:10px;border-top-right-radius:10px}
    #bd-log header b{font-size:12px}
    #bd-log header button{background:#333;border:1px solid #444;color:#eee;border-radius:6px;padding:4px 8px;cursor:pointer}
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
    S.logStore.push(line);
    const pre = get('#bd-pre');
    if (pre) pre.textContent = S.logStore.join('\n');
    console.log('[ClaudeBulkDeleter]', ...a);
  }

  // ---------- Claude API helpers ----------
  async function fetchAllChats() {
    try {
      const resp = await fetch(`${apiBase()}/chat_conversations`, {
        credentials: 'include',
        cache: 'no-store'
      });
      if (!resp.ok) {
        log('failed to fetch chats', resp.status);
        return [];
      }
      const data = await resp.json();
      if (Array.isArray(data)) {
        log(`fetched ${data.length} chats`);
        return data;
      }
      // in case it ever wraps in an object
      const arr = Array.isArray(data.conversations) ? data.conversations : [];
      log(`fetched ${arr.length} chats (wrapped)`);
      return arr;
    } catch (e) {
      log('error fetching chats', String(e));
      return [];
    }
  }

  async function deleteChat(chat) {
    const url = `${apiBase()}/chat_conversations/${chat.uuid}`;
    try {
      const res = await fetch(url, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        log(`ok delete "${chat.name}" (${chat.uuid})`);
        return true;
      } else {
        log(`fail delete "${chat.name}" (${chat.uuid}) status ${res.status}`);
        return false;
      }
    } catch (e) {
      log(`error delete "${chat.name}" (${chat.uuid}) ${String(e)}`);
      return false;
    }
  }

  // ---------- Mount and resilience ----------
  function mountUI() {
    // button
    let btn = get('#bd-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'bd-btn';
      btn.textContent = 'Delete All Chats';
      btn.addEventListener('click', onButtonClick, { passive: true });
      document.body.appendChild(btn);
    }

    // log window
    let box = get('#bd-log');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bd-log';
      box.innerHTML = `
        <header>
          <b>Claude Bulk Deleter Log</b>
          <div>
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
    history.pushState = function (...args) {
      const r = origPush.apply(this, args);
      onChange();
      return r;
    };
    history.replaceState = function (...args) {
      const r = origReplace.apply(this, args);
      onChange();
      return r;
    };
    window.addEventListener('popstate', onChange);
    new MutationObserver(() => ensureUI()).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // rescue hotkeys: Ctrl Alt D remounts, Shift D toggles log
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd') {
      ensureUI();
    }
    if (e.shiftKey && e.key.toLowerCase() === 'd') {
      const el = get('#bd-log');
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
  });

  // ---------- Button logic (two click arm like ChatGPT script) ----------
  async function onButtonClick() {
    if (S.running) return;
    const btn = get('#bd-btn');

    // first click: scan and arm
    if (!S.armed) {
      S.running = true;
      showLog(true);
      btn.disabled = true;
      btn.textContent = 'Scanning Claude chats...';
      log('scan start');

      const chats = await fetchAllChats();
      S.chats = chats || [];

      S.running = false;
      btn.disabled = false;
      showLog(false);

      if (!S.chats.length) {
        log('no chats found');
        btn.textContent = 'Claude: Delete All Chats';
        return;
      }

      S.armed = true;
      btn.textContent = `Click again to delete ${S.chats.length} chats`;
      log(`armed with ${S.chats.length} chats`);
      return;
    }

    // second click: delete
    if (S.armed) {
      S.armed = false;
      S.running = true;
      showLog(true);
      btn.disabled = true;

      const chats = Array.isArray(S.chats) ? S.chats : [];
      if (!chats.length) {
        log('no chats in memory, aborting');
        btn.disabled = false;
        btn.textContent = 'Claude: Delete All Chats';
        S.running = false;
        showLog(false);
        return;
      }

      const ok = { count: 0 };
      const fail = { count: 0 };

      // one last confirmation
      if (!confirm(`This will permanently delete ${chats.length} chats in this Claude org.\n\nAre you sure?`)) {
        log('user cancelled on second click');
        btn.disabled = false;
        btn.textContent = 'Claude: Delete All Chats';
        S.running = false;
        showLog(false);
        return;
      }

      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const name = chat.name || '(no title)';
        btn.textContent = `Deleting ${i + 1}/${chats.length}...`;
        log(`deleting ${i + 1}/${chats.length}: "${name}"`);
        const good = await deleteChat(chat);
        if (good) ok.count++; else fail.count++;
        await sleep(500); // match original rate limit
      }

      log(`done ok ${ok.count} fail ${fail.count}`);
      btn.textContent = 'Claude: Delete All Chats';
      btn.disabled = false;
      S.running = false;
      showLog(false);
      if (ok.count > 0) {
        setTimeout(() => location.reload(), 1200);
      }
    }
  }

  // ---------- boot ----------
  function boot() {
    if (!document.body) { requestAnimationFrame(boot); return; }
    ensureUI();
    hookSPARouteChanges();
    if (!S.ensureTimer) {
      S.ensureTimer = setInterval(ensureUI, 1500);
    }
  }

  boot();
})();
