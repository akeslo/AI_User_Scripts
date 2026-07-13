// ==UserScript==
// @name         Claude Bulk Deleter (with Claude Code support)
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Bulk delete Claude.ai chats. Auto detects org id, paginates, keeps log visible on error, skips starred legacy chats, auto-queues web chats (cowork-remote sessions), confirms real Claude Code sessions one by one. Collapsible bottom-right pull tab with progress-bar fill.
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

  // module-scoped state, not on window so other page scripts can't read/write the delete queue
  const S = {
    mounted: false,
    running: false,
    armed: false,
    collapsed: true,
    logStore: [],
    ensureTimer: null,
    lastUrl: location.href,
    chats: []
  };

  GM_addStyle(`
    #bd-wrap{position:fixed;bottom:16px;right:0;z-index:2147483647;display:flex;align-items:stretch;transition:transform .25s ease}
    #bd-wrap.bd-collapsed{transform:translateX(calc(100% - 18px))}
    #bd-tab{width:18px;background:#D97757;border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;font-size:13px;user-select:none;flex-shrink:0;box-shadow:-4px 0 12px rgba(0,0,0,.3)}
    #bd-btn{position:relative;overflow:hidden;padding:10px 14px;border:none;border-radius:0 10px 10px 0;background:#8f4429;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:nowrap;transition:background .2s}
    #bd-btn[disabled]{opacity:.6;cursor:not-allowed}
    #bd-btn.bd-armed{background:#b3261e}
    #bd-btn-fill{position:absolute;left:0;top:0;bottom:0;width:100%;background:#D97757;transform:scaleX(0);transform-origin:left;transition:transform .2s linear;z-index:0}
    #bd-btn-text{position:relative;z-index:1}
    #bd-log{position:fixed;bottom:70px;right:12px;width:520px;max-width:calc(100vw - 24px);max-height:55vh;overflow:auto;border:1px solid #2e2e2e;background:#111;color:#ddd;border-radius:10px;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.35);font:12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;display:none}
    #bd-log header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #2e2e2e;background:#181818;border-top-left-radius:10px;border-top-right-radius:10px}
    #bd-log header b{font-size:12px}
    #bd-log header button{background:#333;border:1px solid #444;color:#eee;border-radius:6px;padding:4px 8px;cursor:pointer;margin-left:4px}
    #bd-log pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:10px;line-height:1.35}
  `);

  // DUPLICATED HELPERS (sleep/get/showLog/log): near-identical copies also live in
  // "Gemini Bulk Deleter.user.js" (~L48-64) and "ChatGPT Bulk Deleter.user.js" (~L42-58).
  // This repo has no build system (see CLAUDE.md: "No build/package manager"), so these
  // three copies are kept in sync by hand. If you edit this block, mirror the change in
  // both other files. In particular, the XSS-safety invariant on log() below (textContent
  // only, never innerHTML) MUST hold in all three copies.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = sel => document.querySelector(sel);
  const apiBase = () => `${location.origin}/api/organizations/${orgId}`;

  function showLog(show) {
    const el = get('#bd-log');
    if (el) el.style.display = show ? 'block' : 'none';
  }

  // NOTE: log must stay textContent, never innerHTML, to avoid stored XSS from API response bodies
  // (this invariant must also hold in the Gemini and ChatGPT copies of this function)
  function log(...a) {
    const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    S.logStore.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    const pre = get('#bd-pre');
    if (pre) pre.textContent = S.logStore.join('\n');
    console.log('[ClaudeBulkDeleter]', ...a);
  }

  function setBtn(text, pct) {
    const t = get('#bd-btn-text');
    const f = get('#bd-btn-fill');
    if (t) t.textContent = text;
    if (f) f.style.transform = `scaleX(${(pct == null ? 0 : pct) / 100})`;
  }

  // Pull common headers Claude's own UI sends. Helps with CSRF style checks.
  // anthropic-version is required by the /v1/code/sessions endpoints, harmless elsewhere.
  function commonHeaders(extra) {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'anthropic-client-platform': 'web_claude_ai',
      'anthropic-version': '2023-06-01'
    };
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
      // shape varies. try a few common spots. Prefer an org with chat capability -
      // some accounts have an API-only org listed first that 403s on chat endpoints.
      const candidates = [];
      if (j && j.account && Array.isArray(j.account.memberships)) {
        for (const m of j.account.memberships) {
          if (m && m.organization && m.organization.uuid) {
            candidates.push({
              uuid: m.organization.uuid,
              caps: m.organization.capabilities || []
            });
          }
        }
      }
      if (Array.isArray(j.organizations)) {
        for (const o of j.organizations) {
          if (o && o.uuid) candidates.push({ uuid: o.uuid, caps: o.capabilities || [] });
        }
      }
      if (j && j.organization && j.organization.uuid) {
        candidates.push({ uuid: j.organization.uuid, caps: j.organization.capabilities || [] });
      }
      if (candidates.length) {
        const chatOrg = candidates.find(c => c.caps.includes('chat') || c.caps.includes('claude_max'));
        orgId = (chatOrg || candidates[0]).uuid;
        const shortOrgId = orgId.length > 8 ? `${orgId.slice(0, 8)}...` : orgId;
        log(`auto detected org id ${shortOrgId}${chatOrg ? ' (chat capable)' : ' (no chat-capable org found, using first)'}`);
        if (candidates.length > 1) {
          log(`note: ${candidates.length} orgs found, picked by chat capability. Edit script if wrong.`);
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
    return all.map(c => ({ ...c, _kind: 'chat', _id: c.uuid, _title: c.name || '(no title)' }));
  }

  // As of 2026-07, claude.ai serves BOTH ordinary web chats and Claude Code sessions from
  // /v1/code/sessions (ids like cse_..., routed at /cowork/<id>). The legacy
  // chat_conversations table only holds a few stragglers. Two traps here:
  //
  //   1. Without exclude_tags=- the endpoint silently applies a default tag filter that
  //      drops every web chat. That filter is why a plain ?limit=200 only ever returned
  //      the Claude Code sessions.
  //   2. status is 'active' for essentially everything now, so it cannot be used to tell
  //      a finished chat from a live agent session. status_bucket (working / review_ready /
  //      blocked) is the live field, and tags are what actually separate the two kinds.
  //
  // Web chats carry the 'cowork-remote' tag (environment_kind anthropic_cloud). Real Claude
  // Code sessions carry remote-control-* / cowork-local tags and run on environment_kind
  // 'bridge'. Note cse_ sessions have no starred/pinned field at all - star-skipping only
  // works on legacy chat_conversations.
  //
  // Max limit is 200 and the endpoint doesn't support real backward pagination
  // (resume_token is for forward/incremental sync, not paging older items), so this
  // is best-effort: it grabs the most recent 200 and says so if there may be more.
  const WEB_CHAT_TAG = 'cowork-remote';

  function isWebChatSession(s) {
    const tags = Array.isArray(s.tags) ? s.tags : [];
    return tags.includes(WEB_CHAT_TAG);
  }

  async function fetchAllSessions() {
    try {
      const resp = await fetch(`${location.origin}/v1/code/sessions?limit=200&exclude_tags=-`, {
        credentials: 'include',
        cache: 'no-store',
        headers: commonHeaders()
      });
      if (!resp.ok) {
        log(`fetch sessions failed status ${resp.status}`);
        return [];
      }
      const data = await resp.json();
      const arr = Array.isArray(data.data) ? data.data : [];
      log(`fetched ${arr.length} sessions (chats + Claude Code)`);
      if (arr.length >= 200) {
        log('note: 200-session cap hit, older sessions may exist but the API has no reliable way to page past this. Not deleted this pass.');
      }
      return arr.map(s => {
        const web = isWebChatSession(s);
        return {
          ...s,
          _kind: 'code', // delete route is /v1/code/sessions/<id> for both
          _id: s.id,
          _title: s.title || '(no title)',
          _webChat: web
        };
      });
    } catch (e) {
      log(`fetch sessions error ${String(e)}`);
      return [];
    }
  }

  async function deleteChat(chat) {
    const url = chat._kind === 'code'
      ? `${location.origin}/v1/code/sessions/${chat._id}`
      : `${apiBase()}/chat_conversations/${chat._id}`;
    try {
      const res = await fetch(url, {
        method: 'DELETE',
        credentials: 'include',
        headers: commonHeaders()
      });
      if (res.ok) {
        log(`ok "${chat._title}" ${chat._id}`);
        return true;
      } else {
        let body = '';
        try { body = (await res.text()).slice(0, 200); } catch {}
        log(`fail status ${res.status} "${chat._title}" ${chat._id} body ${body}`);
        return false;
      }
    } catch (e) {
      log(`error delete ${chat._id} ${String(e)}`);
      return false;
    }
  }

  function applyCollapsed() {
    const wrap = get('#bd-wrap');
    const tab = get('#bd-tab');
    if (!wrap) return;
    wrap.classList.toggle('bd-collapsed', S.collapsed);
    if (tab) tab.textContent = S.collapsed ? '‹' : '›';
  }

  function mountUI() {
    let wrap = get('#bd-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'bd-wrap';

      const tab = document.createElement('div');
      tab.id = 'bd-tab';
      tab.title = 'Show/hide bulk deleter';
      tab.addEventListener('click', () => {
        S.collapsed = !S.collapsed;
        applyCollapsed();
      }, { passive: true });

      const btn = document.createElement('button');
      btn.id = 'bd-btn';
      btn.innerHTML = `<span id="bd-btn-fill"></span><span id="bd-btn-text" role="status" aria-live="polite">Delete Unstarred Chats</span>`;
      btn.addEventListener('click', onButtonClick, { passive: true });

      wrap.appendChild(tab);
      wrap.appendChild(btn);
      document.body.appendChild(wrap);
      applyCollapsed();
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
        <pre id="bd-pre" role="log" aria-live="polite"></pre>
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
    if (!get('#bd-wrap') || !get('#bd-log')) mountUI();
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
    let debounceTimer = null;
    new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(ensureUI, 200);
    }).observe(document.documentElement, {
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
      setBtn('Scanning...', null);
      log('scan start');

      if (!orgId) await detectOrgId();
      if (!orgId) {
        log('no org id available, aborting');
        btn.disabled = false;
        setBtn('Delete Unstarred Chats', 0);
        S.running = false;
        return;
      }

      const [legacyChats, allSessions] = await Promise.all([
        fetchAllChats(),
        fetchAllSessions()
      ]);

      const normalChats = [];
      let starredCount = 0;

      legacyChats.forEach(c => {
        if (c.is_starred) {
          starredCount++;
        } else {
          normalChats.push(c);
        }
      });

      // Web chats are ordinary conversations - bulk-queue them, same as legacy chats.
      // Real Claude Code sessions are live agent runs, so they stay behind a per-item confirm.
      const webChats = allSessions.filter(s => s._webChat);
      const codeSessions = allSessions.filter(s => !s._webChat);

      S.chats = normalChats.concat(webChats);

      log(`Found ${normalChats.length} legacy chats and ${webChats.length} web chats (auto-queued).`);

      if (codeSessions.length > 0) {
        log(`Found ${codeSessions.length} Claude Code sessions.`);
        let added = 0;
        for (const s of codeSessions) {
          if (confirm(`Delete Claude Code session:\n"${s._title}"\nstatus: ${s.status_bucket || s.status}?`)) {
            S.chats.push(s);
            added++;
          }
        }
        log(`Individually added ${added} Claude Code sessions to deletion queue.`);
      }

      // de-dupe by _id before arming, in case the same chat/session surfaced from more than one source
      {
        const seenIds = new Set();
        S.chats = S.chats.filter(c => {
          if (seenIds.has(c._id)) return false;
          seenIds.add(c._id);
          return true;
        });
      }

      S.running = false;
      btn.disabled = false;

      if (!S.chats.length) {
        log(`No eligible chats found to delete. (Skipped ${starredCount} starred chats).`);
        setBtn('Delete Unstarred Chats', 0);
        return;
      }

      showLog(false);
      S.armed = true;
      btn.classList.add('bd-armed');
      setBtn(`Click again to delete ${S.chats.length} chats`, 0);
      log(`Armed with ${S.chats.length} chats for deletion (Skipped ${starredCount} starred chats)`);
      return;
    }

    if (S.armed) {
      S.armed = false;
      btn.classList.remove('bd-armed');
      S.running = true;
      showLog(true);
      btn.disabled = true;

      const chats = Array.isArray(S.chats) ? S.chats : [];
      if (!chats.length) {
        log('no chats in memory, aborting');
        btn.disabled = false;
        setBtn('Delete Unstarred Chats', 0);
        S.running = false;
        return;
      }

      if (!confirm(`This will permanently delete ${chats.length} chats.\n\nAre you sure?`)) {
        log('user cancelled');
        btn.disabled = false;
        setBtn('Delete Unstarred Chats', 0);
        S.running = false;
        showLog(false);
        return;
      }

      let ok = 0, fail = 0;
      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        setBtn(`Deleting ${i + 1}/${chats.length}...`, (i / chats.length) * 100);
        const good = await deleteChat(chat);
        if (good) ok++; else fail++;
        setBtn(`Deleting ${i + 1}/${chats.length}...`, ((i + 1) / chats.length) * 100);
        await sleep(500);
      }

      log(`done ok ${ok} fail ${fail}`);
      setBtn('Delete Unstarred Chats', 0);
      btn.disabled = false;
      S.running = false;
      if (fail === 0) {
        showLog(false);
        if (ok > 0) setTimeout(() => location.reload(), 2500);
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
