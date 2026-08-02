// ==UserScript==
// @name         ChatGPT Bulk Deleter
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Delete all chats with visible log that shows while running and hides when done. Auto remounts UI on changes.
// @author       akeslo
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_addStyle
// @license      MIT
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // single supervisor object that can remount as needed (module-scoped, not on window
  // so other page scripts can't read/write the delete queue)
  const S = {
    mounted: false,
    running: false,
    armed: false,
    collapsed: true,
    logStore: [],
    ensureTimer: null,
    lastUrl: location.href,
    ids: []
  };

  // ---------- UI ----------
  GM_addStyle(`
    #bd-wrap{position:fixed;bottom:16px;right:0;z-index:2147483647;display:flex;align-items:stretch;transition:transform .25s ease}
    #bd-wrap.bd-collapsed{transform:translateX(calc(100% - 18px))}
    #bd-tab{width:18px;background:#9333EA;border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;font-size:13px;user-select:none;flex-shrink:0;box-shadow:-4px 0 12px rgba(0,0,0,.3)}
    #bd-btn{position:relative;overflow:hidden;padding:10px 14px;border:none;border-radius:0 10px 10px 0;background:#6740A6;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:nowrap;transition:background .2s}
    #bd-btn[disabled]{opacity:.6;cursor:not-allowed}
    #bd-btn.bd-armed{background:#b3261e}
    #bd-btn-fill{position:absolute;left:0;top:0;bottom:0;width:100%;background:#9333EA;transform:scaleX(0);transform-origin:left;transition:transform .2s linear;z-index:0}
    #bd-btn-text{position:relative;z-index:1}
    #bd-log{position:fixed;bottom:70px;right:12px;width:520px;max-width:calc(100vw - 24px);max-height:55vh;overflow:auto;border:1px solid #2e2e2e;background:#111;color:#ddd;border-radius:10px;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.35);font:12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;display:none}
    #bd-log header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #2e2e2e;background:#181818;border-top-left-radius:10px;border-top-right-radius:10px}
    #bd-log header b{font-size:12px}
    #bd-log header button{background:#333;border:1px solid #444;color:#eee;border-radius:6px;padding:4px 8px;cursor:pointer;margin-left:4px}
    #bd-log pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:10px;line-height:1.35}
  `);

  // DUPLICATED HELPERS (sleep/get/showLog/log): near-identical copies also live in
  // "Claude Bulk Deleter.user.js" (~L48-64) and "Gemini Bulk Deleter.user.js" (~L48-64).
  // This repo has no build system (see CLAUDE.md: "No build/package manager"), so these
  // three copies are kept in sync by hand. If you edit this block, mirror the change in
  // both other files. In particular, the XSS-safety invariant on log() below (textContent
  // only, never innerHTML) MUST hold in all three copies.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const base = () => window.location.origin;
  const get = sel => document.querySelector(sel);

  function getCookie(name){
    return document.cookie.split('; ').find(r => r.startsWith(name + '='))?.split('=')[1];
  }

  function showLog(show){
    const el = get('#bd-log');
    if (el) el.style.display = show ? 'block' : 'none';
  }

  // NOTE: log must stay textContent, never innerHTML, to avoid stored XSS from API response bodies
  // (this invariant must also hold in the Claude and Gemini copies of this function)
  function log(...a){
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    S.logStore.push(line);
    const pre = get('#bd-pre');
    if (pre) {
      pre.textContent = S.logStore.join('\n');
      // The scroller is the panel (#bd-log has overflow:auto), not the <pre> inside it.
      const panel = get('#bd-log');
      if (panel) panel.scrollTop = panel.scrollHeight;
    }
    console.log('[BulkDeleter]', ...a);
  }

  function setBtn(text, pct){
    const t = get('#bd-btn-text');
    const f = get('#bd-btn-fill');
    if (t) t.textContent = text;
    if (f) f.style.transform = `scaleX(${(pct == null ? 0 : pct) / 100})`;
  }

  function applyCollapsed(){
    const wrap = get('#bd-wrap');
    if (wrap) wrap.classList.toggle('bd-collapsed', S.collapsed);
  }

  async function getBearer(){
    try{
      const res = await fetch(`${base()}/api/auth/session`, { credentials:'include', cache:'no-store' });
      if (!res.ok){
        log('no bearer (auth failed)');
        return null;
      }
      const j = await res.json();
      if (j && j.accessToken){
        log('token ok');
        return j.accessToken;
      }
    }catch(e){}
    log('no bearer');
    return null;
  }

  async function http(method, url, body, bearer, allow404){
    const csrfCookie = getCookie('csrfToken');
    const csrf = csrfCookie ? decodeURIComponent(csrfCookie) : '';
    const did  = getCookie('oai-did') || '';

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      'OAI-Device-Id': did
    };
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

    const opts = { method, headers, credentials: 'include', mode: 'same-origin' };
    if (body !== undefined) opts.body = JSON.stringify(body);

    try{
      const res = await fetch(url, opts);
      const text = await res.text().catch(()=> '');
      const ok = res.ok || res.status === 204 || (allow404 && res.status === 404);
      return { ok, status: res.status, text, url };
    }catch(e){
      return { ok:false, status:0, text:String(e), url };
    }
  }

  async function listPage(offset, limit, bearer){
    const tries = [
      `${base()}/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`,
      `${base()}/api/conversations?offset=${offset}&limit=${limit}&order=updated`,
      `${base()}/backend-api/conversations?cursor=${offset}&limit=${limit}&order=updated`
    ];
    for (const u of tries){
      try{
        const res = await fetch(u, { credentials:'include', cache:'no-store', headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined });
        if (!res.ok) continue;
        const j = await res.json();
        const items = j.items || j.conversations || j.data || [];
        const ids = [];
        for (const it of items){
          const id = it.id || it.conversation_id || it.conversationId;
          if (id) ids.push(id);
        }
        const total = Number(j.total ?? j.total_conversations ?? j.count ?? ids.length);
        const hasMore = Boolean(j.has_more ?? (offset + ids.length < total));
        return { ids, total, hasMore };
      }catch(e){}
    }
    return { ids: [], total: 0, hasMore: false };
  }

  async function listAllIds(bearer){
    const page = 100;
    let offset = 0;
    const all = new Set();

    const first = await listPage(0, page, bearer);
    first.ids.forEach(id => all.add(id));
    log(`found ${all.size} on first page total ${first.total || all.size}`);

    let pageCount = 0;
    while (first.hasMore && all.size < (first.total || 999999)){
      offset += page;
      const next = await listPage(offset, page, bearer);
      next.ids.forEach(id => all.add(id));
      log(`page offset ${offset} added ${next.ids.length}`);
      if (!next.hasMore || next.ids.length === 0) break;
      pageCount++;
      if (pageCount > 200){ log('safety stop at 200 pages'); break; }
      await sleep(120);
    }
    return Array.from(all);
  }

  async function delSoftHard(id, bearer){
    const urls = [
      `${base()}/backend-api/conversation/${id}`,
      `${base()}/backend-api/conversations/${id}`,
      `${base()}/api/conversations/${id}`,
      `${base()}/api/conversation/${id}`
    ];
    for (const u of urls){
      const r = await http('PATCH', u, { is_visible:false }, bearer);
      log(r.ok ? `soft ok ${id} ${r.status}` : `soft fail ${id} ${r.status} ${u}`);
      if (r.ok) return true;
    }
    {
      const r = await http('POST', `${base()}/backend-api/conversations/delete`, { conversation_ids:[id] }, bearer);
      log(r.ok ? `bulk soft ok ${id} ${r.status}` : `bulk soft fail ${id} ${r.status}`);
      if (r.ok) return true;
    }
    // Do NOT pass allow404 here. Three of the four URLs above are guesses at routes that
    // may not exist, so a 404 is overwhelmingly "wrong route", not "already deleted".
    // Accepting it made the first guessed route that 404'd short-circuit the whole loop
    // and report a successful delete for a chat that is still there — the run printed
    // `ok N fail 0` having deleted nothing.
    for (const u of urls){
      const r = await http('DELETE', u, undefined, bearer);
      log(r.ok ? `hard ok ${id} ${r.status}` : `hard fail ${id} ${r.status} ${u}`);
      if (r.ok) return true;
    }
    return false;
  }

  async function delGraphQL(id, bearer){
    try{
      const payloads = [
        {
          operationName: 'deleteConversation',
          variables: { conversationId: id },
          query: 'mutation deleteConversation($conversationId:ID!){deleteConversation(conversationId:$conversationId){id}}'
        },
        {
          operationName: 'DeleteConversationMutation',
          variables: { id },
          query: 'mutation DeleteConversationMutation($id:ID!){conversationDelete(id:$id){success}}'
        }
      ];
      for (const p of payloads){
        const r = await http('POST', `${base()}/backend-api/graphql`, p, bearer);
        log(r.ok ? `gql ok ${id} ${r.status}` : `gql fail ${id} ${r.status}`);
        if (r.ok) return true;
      }
    }catch(e){
      log('gql error ' + e);
    }
    return false;
  }

  async function deleteOne(id, bearer){
    if (await delSoftHard(id, bearer)) return true;
    if (await delGraphQL(id, bearer)) return true;
    return false;
  }

  // ---------- Mount and resilience ----------
  function mountUI(){
    // create or refresh wrapper and button
    let wrap = get('#bd-wrap');
    if (!wrap){
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
      btn.innerHTML = `<span id="bd-btn-fill"></span><span id="bd-btn-text" role="status" aria-live="polite">Delete All Chats</span>`;
      btn.addEventListener('click', onButtonClick, { passive: true });

      wrap.appendChild(tab);
      wrap.appendChild(btn);
      document.body.appendChild(wrap);
      applyCollapsed();
    }

    let box = get('#bd-log');
    if (!box){
      box = document.createElement('div');
      box.id = 'bd-log';
      box.innerHTML = `
        <header>
          <b>Bulk Deleter Log</b>
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
    if (clearBtn && !clearBtn.__bdHooked){
      clearBtn.__bdHooked = true;
      clearBtn.onclick = () => { S.logStore.length = 0; const pre = get('#bd-pre'); if (pre) pre.textContent = ''; };
    }
    if (copyBtn && !copyBtn.__bdHooked){
      copyBtn.__bdHooked = true;
      copyBtn.onclick = () => navigator.clipboard.writeText(S.logStore.join('\n')).catch(()=>{});
    }

    S.mounted = true;
  }

  function ensureUI(){
    if (!document.body) return;
    if (!get('#bd-btn') || !get('#bd-log')) mountUI();
  }

  function hookSPARouteChanges(){
    // detect URL changes and try remount
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    function onChange(){
      if (S.lastUrl !== location.href){
        S.lastUrl = location.href;
        setTimeout(ensureUI, 50);
        setTimeout(ensureUI, 300);
        setTimeout(ensureUI, 1200);
      }
    }
    history.pushState = function(...args){ const r = origPush.apply(this, args); onChange(); return r; };
    history.replaceState = function(...args){ const r = origReplace.apply(this, args); onChange(); return r; };
    window.addEventListener('popstate', onChange);
    let debounceTimer = null;
    new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(ensureUI, 200);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // rescue hotkey: Ctrl Alt D remounts, Shift L D toggles log
  // The bare Shift+<letter> log toggle must not fire while the user is typing —
  // this page's primary interaction is a composer, so an unguarded handler toggles
  // the overlay every time a capital letter is typed.
  function isTypingTarget(e) {
    const t = e.target;
    if (!t || !t.tagName) return false;
    return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
  }

  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd'){ ensureUI(); }
    if (!isTypingTarget(e) && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'd'){
      const el = get('#bd-log');
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
  });

  // button logic with two click arm
  async function onButtonClick(){
    if (S.running) return;
    const btn = get('#bd-btn');

    // first click scans and arms
    if (!S.armed){
      S.running = true;
      showLog(true);
      btn.disabled = true;
      log('starting');
      const bearer = await getBearer();
      setBtn('Scanning...', 0);
      const ids = await listAllIds(bearer);
      S.ids = ids;
      btn.disabled = false;
      S.running = false;
      showLog(false);

      if (!ids.length){
        setBtn('Delete All Chats', 0);
        btn.classList.remove('bd-armed');
        log('no ids found');
        return;
      }
      S.armed = true;
      setBtn(`Click again to delete ${ids.length} chats`, 0);
      btn.classList.add('bd-armed');
      log(`armed with ${ids.length} ids`);
      return;
    }

    // second click executes
    if (S.armed){
      const ids = Array.isArray(S.ids) ? S.ids : [];

      if (!confirm(`This will permanently delete ${ids.length} chats.\n\nAre you sure?`)){
        log('user cancelled');
        return;
      }

      S.armed = false;
      btn.classList.remove('bd-armed');
      S.running = true;
      showLog(true);
      const bearer = await getBearer();
      btn.disabled = true;

      let ok = 0, fail = 0;
      for (let i = 0; i < ids.length; i++){
        const id = ids[i];
        setBtn(`Deleting ${i + 1}/${ids.length}...`, (i / ids.length) * 100);
        const good = await deleteOne(id, bearer);
        if (good) ok++; else fail++;
        await sleep(120);
      }

      log(`done ok ${ok} fail ${fail}`);
      setBtn('Delete All Chats', 0);
      btn.disabled = false;
      S.running = false;
      if (fail > 0){
        alert(`Bulk delete finished with ${fail} failure(s) out of ${ids.length}. Check the log panel for details.`);
      } else {
        showLog(false);
      }
      if (ok > 0) setTimeout(() => location.replace('https://chatgpt.com/?new'), 2500);
    }
  }

  // wait for body then mount and keep it alive
  function boot(){
    if (!document.body){ requestAnimationFrame(boot); return; }
    ensureUI();
    hookSPARouteChanges();
    if (!S.ensureTimer){
      S.ensureTimer = setInterval(ensureUI, 1500);
    }
  }

  boot();
})();
