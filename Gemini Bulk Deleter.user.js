// ==UserScript==
// @name         Gemini Bulk Deleter
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Delete all Gemini chats with two-click arm mechanism
// @author       akeslo
// @match        https://gemini.google.com/*
// @grant        GM_addStyle
// @license      MIT
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // module-scoped state, not on window so other page scripts can't read/write the delete queue
  const S = {
    mounted: false,
    running: false,
    armed: false,
    collapsed: true,
    logStore: [],
    ensureTimer: null,
    lastUrl: location.href,
    convos: []
  };

  GM_addStyle(`
    #gbd-wrap{position:fixed;bottom:16px;right:0;z-index:2147483647;display:flex;align-items:stretch;transition:transform .25s ease}
    #gbd-wrap.gbd-collapsed{transform:translateX(calc(100% - 18px))}
    #gbd-tab{width:18px;background:#1a73e8;border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;font-size:13px;user-select:none;flex-shrink:0;box-shadow:-4px 0 12px rgba(0,0,0,.3)}
    #gbd-btn{position:relative;overflow:hidden;padding:10px 14px;border:none;border-radius:0 10px 10px 0;background:#1a73e8;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:nowrap;transition:background .2s}
    #gbd-btn:hover{background:#1765cc}
    #gbd-btn[disabled]{opacity:.6;cursor:not-allowed;background:#5f6368}
    #gbd-btn.gbd-armed{background:#c5221f}
    #gbd-btn.gbd-armed:hover{background:#a3160f}
    #gbd-btn-fill{position:absolute;left:0;top:0;bottom:0;width:100%;background:#1a73e8;transform:scaleX(0);transform-origin:left;transition:transform .2s linear;z-index:0}
    #gbd-btn-text{position:relative;z-index:1}
    #gbd-log{position:fixed;bottom:70px;right:12px;width:520px;max-width:calc(100vw - 24px);max-height:60vh;overflow:auto;border:1px solid #dadce0;background:#fff;color:#202124;border-radius:10px;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.35);font:11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;display:none}
    #gbd-log header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #dadce0;background:#f8f9fa;border-top-left-radius:10px;border-top-right-radius:10px}
    #gbd-log header b{font-size:12px;font-weight:600}
    #gbd-log header button{background:#fff;border:1px solid #dadce0;color:#202124;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;margin-left:4px}
    #gbd-log header button:hover{background:#f8f9fa}
    #gbd-log pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:10px;line-height:1.5;font-size:11px}
    @media (prefers-color-scheme: dark) {
      #gbd-tab{background:#5f6368}
      #gbd-btn-fill{background:#5f6368}
      #gbd-log{background:#202124;color:#e8eaed;border-color:#5f6368}
      #gbd-log header{background:#292a2d;border-color:#5f6368}
      #gbd-log header button{background:#292a2d;border-color:#5f6368;color:#e8eaed}
      #gbd-log header button:hover{background:#3c4043}
    }
  `);

  // DUPLICATED HELPERS (sleep/get/showLog/log): near-identical copies also live in
  // "Claude Bulk Deleter.user.js" (~L48-64) and "ChatGPT Bulk Deleter.user.js" (~L42-58).
  // This repo has no build system (see CLAUDE.md: "No build/package manager"), so these
  // three copies are kept in sync by hand. If you edit this block, mirror the change in
  // both other files. In particular, the XSS-safety invariant on log() below (textContent
  // only, never innerHTML) MUST hold in all three copies.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = sel => document.querySelector(sel);
  const getAll = sel => document.querySelectorAll(sel);

  function showLog(show) {
    const el = get('#gbd-log');
    if (el) el.style.display = show ? 'block' : 'none';
  }

  // NOTE: log must stay textContent, never innerHTML, to avoid stored XSS from API response bodies
  // (this invariant must also hold in the Claude and ChatGPT copies of this function)
  function log(...a) {
    const timestamp = new Date().toLocaleTimeString();
    const line = `[${timestamp}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    S.logStore.push(line);
    const pre = get('#gbd-pre');
    if (pre) {
      pre.textContent = S.logStore.join('\n');
      // The scroller is the panel (#gbd-log has overflow:auto), not the <pre> inside it —
      // setting pre.scrollTop is a no-op and leaves the newest lines off-screen.
      const panel = get('#gbd-log');
      if (panel) panel.scrollTop = panel.scrollHeight;
    }
    console.log('[GeminiBulkDeleter]', ...a);
  }

  function setBtn(text, pct){
    const t = get('#gbd-btn-text');
    const f = get('#gbd-btn-fill');
    if (t) t.textContent = text;
    if (f) f.style.transform = `scaleX(${(pct == null ? 0 : pct) / 100})`;
  }

  function applyCollapsed(){
    const wrap = get('#gbd-wrap');
    if (wrap) wrap.classList.toggle('gbd-collapsed', S.collapsed);
  }

  function getConversationDivs() {
    const divs = Array.from(getAll('gem-nav-list-item[data-test-id="conversation"]'));
    // If no conversations found, check if the selector itself is broken (UI changed)
    if (divs.length === 0) {
      const sampleNav = get('gem-nav-list-item');
      if (!sampleNav) {
        log('⚠ WARNING: Gemini UI selector "gem-nav-list-item" not found. UI may have changed.');
      }
    }
    return divs;
  }

  function extractTitle(convoDiv) {
    return convoDiv.querySelector('.title-text')?.textContent.trim().substring(0, 40) || 'Untitled';
  }

  // Gemini's sidebar list is virtualized: DOM nodes get recycled to represent a
  // different conversation as the user scrolls, so a node cached at scan time can
  // silently point at the wrong (or a stale) row by the time we act on it later in
  // the loop. Best effort fix: tag each row with a unique key at scan time and
  // re-query the live list for that key right before acting on it, falling back to
  // matching by title text. If neither is found, skip and log clearly rather than
  // acting on a possibly-recycled node.
  function findLiveConversation(key, title, usedKeys) {
    const live = getConversationDivs();
    let el = live.find(d => d.dataset.gbdKey === key && !usedKeys.has(d));
    if (!el) {
      el = live.find(d => extractTitle(d) === title && !usedKeys.has(d));
    }
    return el || null;
  }

  function findMenuButtonForConversation(convoDiv) {
    // The actual clickable <button> lives nested inside the gem-icon-button wrapper.
    return convoDiv.querySelector('[data-test-id="actions-menu-button"] button');
  }

  async function deleteConversation(convoDiv) {
    try {
      const title = convoDiv.querySelector('.title-text')?.textContent.trim().substring(0, 40) || 'Untitled';

      // Hover to make menu button visible
      convoDiv.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await sleep(200);

      // Find the actions menu button
      const menuBtn = findMenuButtonForConversation(convoDiv);
      if (!menuBtn) {
        throw new Error(`Selector not found for menu button on "${title}" — Gemini's UI may have changed, this tool may need updating`);
      }

      // Click menu button
      menuBtn.click();
      await sleep(400);

      // Wait for menu to appear
      const menu = await waitForMenu();
      if (!menu) {
        throw new Error(`Selector not found — menu did not appear for "${title}", Gemini's UI may have changed, this tool may need updating`);
      }

      // Find delete button in menu
      const deleteBtn = await findDeleteButton(menu);
      if (!deleteBtn) {
        throw new Error(`Selector not found — delete button not found in menu for "${title}", Gemini's UI may have changed, this tool may need updating`);
      }

      // Click delete
      deleteBtn.click();
      await sleep(400);

      // Find and click confirm button
      const confirmBtn = await findConfirmButton();
      if (!confirmBtn) {
        throw new Error(`Selector not found — confirm button not found for "${title}", Gemini's UI may have changed, this tool may need updating`);
      }

      confirmBtn.click();
      await sleep(600);

      // Wait for the conversation div to disappear
      let attempts = 0;
      while (document.contains(convoDiv) && convoDiv.offsetParent !== null && attempts < 30) {
        await sleep(100);
        attempts++;
      }

      const success = !document.contains(convoDiv) || convoDiv.offsetParent === null;
      return { success, title };
    } catch (e) {
      // Close any open menus
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        keyCode: 27,
        bubbles: true
      }));
      await sleep(100);

      return { success: false, title: convoDiv.querySelector('.title-text')?.textContent.trim().substring(0, 40) || 'Unknown', error: e.message };
    }
  }

  async function waitForMenu(timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const overlays = getAll('.cdk-overlay-pane');
      for (const overlay of overlays) {
        if (overlay.offsetParent !== null && overlay.querySelector('button')) {
          return overlay;
        }
      }
      await sleep(100);
    }
    return null;
  }

  async function findDeleteButton(menu) {
    const buttons = menu.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || '';
      const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
      if (text.includes('delete') || ariaLabel.includes('delete')) {
        return btn;
      }
    }
    return null;
  }

  async function findConfirmButton() {
    await sleep(300);
    const dialogs = getAll('.cdk-overlay-pane, [role="dialog"]');
    for (const dialog of dialogs) {
      if (dialog.offsetParent === null) continue;

      const buttons = dialog.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || '';
        const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
        if (text.includes('delete') || text.includes('confirm') ||
            ariaLabel.includes('delete') || ariaLabel.includes('confirm')) {
          return btn;
        }
      }
    }
    return null;
  }

  function mountUI() {
    let wrap = get('#gbd-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'gbd-wrap';

      const tab = document.createElement('div');
      tab.id = 'gbd-tab';
      tab.title = 'Show/hide bulk deleter';
      tab.addEventListener('click', () => {
        S.collapsed = !S.collapsed;
        applyCollapsed();
      }, { passive: true });

      const btn = document.createElement('button');
      btn.id = 'gbd-btn';
      btn.innerHTML = `<span id="gbd-btn-fill"></span><span id="gbd-btn-text" role="status" aria-live="polite">Delete All Chats</span>`;
      btn.addEventListener('click', onButtonClick, { passive: true });

      wrap.appendChild(tab);
      wrap.appendChild(btn);
      document.body.appendChild(wrap);
      applyCollapsed();
    }

    let box = get('#gbd-log');
    if (!box) {
      box = document.createElement('div');
      box.id = 'gbd-log';

      const header = document.createElement('header');
      const title = document.createElement('b');
      title.textContent = 'Gemini Bulk Deleter';

      const btnContainer = document.createElement('div');
      const copyBtn = document.createElement('button');
      copyBtn.id = 'gbd-copy';
      copyBtn.textContent = 'Copy';
      const clearBtn = document.createElement('button');
      clearBtn.id = 'gbd-clear';
      clearBtn.textContent = 'Clear';
      const showBtn = document.createElement('button');
      showBtn.id = 'gbd-show';
      showBtn.textContent = 'Show/Hide';

      btnContainer.appendChild(showBtn);
      btnContainer.appendChild(copyBtn);
      btnContainer.appendChild(clearBtn);
      header.appendChild(title);
      header.appendChild(btnContainer);

      const pre = document.createElement('pre');
      pre.id = 'gbd-pre';
      pre.setAttribute('role', 'log');
      pre.setAttribute('aria-live', 'polite');

      box.appendChild(header);
      box.appendChild(pre);
      document.body.appendChild(box);
    }

    const clearBtn = get('#gbd-clear');
    const copyBtn = get('#gbd-copy');
    const showBtn = get('#gbd-show');

    if (clearBtn && !clearBtn.__gbdHooked) {
      clearBtn.__gbdHooked = true;
      clearBtn.onclick = () => {
        S.logStore.length = 0;
        const pre = get('#gbd-pre');
        if (pre) pre.textContent = '';
      };
    }

    if (copyBtn && !copyBtn.__gbdHooked) {
      copyBtn.__gbdHooked = true;
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(S.logStore.join('\n'));
        log('✓ Copied to clipboard');
      };
    }

    if (showBtn && !showBtn.__gbdHooked) {
      showBtn.__gbdHooked = true;
      showBtn.onclick = () => {
        const el = get('#gbd-log');
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
      };
    }

    S.mounted = true;
  }

  function ensureUI() {
    if (!document.body) return;
    if (!get('#gbd-btn') || !get('#gbd-log')) mountUI();
  }

  function hookSPARouteChanges() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;

    function onChange() {
      if (S.lastUrl !== location.href) {
        S.lastUrl = location.href;
        setTimeout(ensureUI, 50);
        setTimeout(ensureUI, 300);
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
    let debounceTimer = null;
    new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(ensureUI, 200);
    }).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // The bare Shift+<letter> log toggle must not fire while the user is typing —
  // this page's primary interaction is a composer, so an unguarded handler toggles
  // the overlay every time a capital letter is typed.
  function isTypingTarget(e) {
    const t = e.target;
    if (!t || !t.tagName) return false;
    return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
  }

  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd') {
      ensureUI();
      log('UI remounted');
    }
    if (!isTypingTarget(e) && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'l') {
      const el = get('#gbd-log');
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
  });

  async function onButtonClick() {
    if (S.running) return;
    const btn = get('#gbd-btn');

    if (!S.armed) {
      S.running = true;
      showLog(true);
      btn.disabled = true;
      setBtn('Scanning...', 0);
      log('='.repeat(50));
      log('Scanning for conversations...');

      await sleep(500);
      const convoDivs = getConversationDivs();
      // Tag each row with a stable key so we can re-find it in the live (virtualized)
      // list later instead of acting on a possibly-recycled cached node.
      S.convos = convoDivs.map((el, i) => {
        const key = `gbd-${Date.now()}-${i}`;
        el.dataset.gbdKey = key;
        return { key, title: extractTitle(el) };
      });

      btn.disabled = false;
      S.running = false;

      if (!S.convos.length) {
        setBtn('Delete All Chats', 0);
        log('✗ No conversations found');
        log('Make sure chat history is visible in the sidebar');
        setTimeout(() => showLog(false), 3000);
        return;
      }

      S.armed = true;
      btn.classList.add('gbd-armed');
      setBtn(`Click again to delete ${S.convos.length} chats`, 0);
      log(`✓ Found ${S.convos.length} conversations`);
      log('ARMED - Click button again to start deletion');
      return;
    }

    if (S.armed) {
      const targets = Array.isArray(S.convos) ? S.convos : [];

      if (!confirm(`This will permanently delete ${targets.length} chats.\n\nAre you sure?`)) {
        log('user cancelled');
        return;
      }

      S.armed = false;
      btn.classList.remove('gbd-armed');
      S.running = true;
      showLog(true);

      btn.disabled = true;
      log('='.repeat(50));
      log(`Starting deletion of ${targets.length} conversations...`);
      log('='.repeat(50));

      let ok = 0, fail = 0;
      const usedNodes = new Set();

      for (let i = 0; i < targets.length; i++) {
        const { key, title } = targets[i];
        setBtn(`Deleting ${i + 1}/${targets.length}...`, (i / targets.length) * 100);

        const convo = findLiveConversation(key, title, usedNodes);
        if (!convo || !document.contains(convo)) {
          fail++;
          log(`[${i + 1}/${targets.length}] ✗ "${title}" - skipped: no matching live node found (already deleted, or the virtualized list recycled this row)`);
          continue;
        }
        usedNodes.add(convo);

        const result = await deleteConversation(convo);
        if (result.success) {
          ok++;
          log(`[${i + 1}/${targets.length}] ✓ "${result.title}"`);
        } else {
          fail++;
          log(`[${i + 1}/${targets.length}] ✗ "${result.title}" - ${result.error || 'Unknown error'}`);
        }

        await sleep(400);

        if ((i + 1) % 5 === 0) {
          log(`Progress: ${ok} deleted, ${fail} failed`);
        }
      }

      log('='.repeat(50));
      log(`COMPLETE: ${ok} deleted, ${fail} failed (${targets.length} total)`);
      log('='.repeat(50));

      setBtn('Delete All Chats', 0);
      btn.disabled = false;
      S.running = false;

      if (fail > 0) {
        alert(`Bulk delete finished with ${fail} failure(s) out of ${targets.length}. Check the log panel for details.`);
      }

      if (ok > 0) {
        log('Reloading page in 2 seconds...');
        setTimeout(() => location.reload(), 2000);
      }
    }
  }

  function boot() {
    if (!document.body) {
      requestAnimationFrame(boot);
      return;
    }

    log('Gemini Bulk Deleter v2.3 loaded');
    log('Two-click mechanism: First click scans, second click deletes');
    ensureUI();
    hookSPARouteChanges();

    if (!S.ensureTimer) {
      S.ensureTimer = setInterval(ensureUI, 1500);
    }
  }

  boot();
})();