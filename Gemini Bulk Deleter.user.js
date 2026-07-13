// ==UserScript==
// @name         Gemini Bulk Deleter
// @namespace    http://tampermonkey.net/
// @version      1.1
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
    logStore: [],
    ensureTimer: null,
    lastUrl: location.href,
    convos: []
  };

  GM_addStyle(`
    #gbd-btn{position:fixed;top:12px;left:12px;z-index:2147483647;padding:10px 14px;border:none;border-radius:10px;background:#1a73e8;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);transition:background .2s}
    #gbd-btn:hover{background:#1765cc}
    #gbd-btn[disabled]{opacity:.6;cursor:not-allowed;background:#5f6368}
    #gbd-btn.gbd-armed{background:#c5221f}
    #gbd-btn.gbd-armed:hover{background:#a3160f}
    #gbd-log{position:fixed;bottom:12px;left:12px;width:500px;max-width:calc(100vw - 24px);max-height:60vh;overflow:auto;border:1px solid #dadce0;background:#fff;color:#202124;border-radius:10px;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.35);font:11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;display:none}
    #gbd-log header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #dadce0;background:#f8f9fa;border-top-left-radius:10px;border-top-right-radius:10px}
    #gbd-log header b{font-size:12px;font-weight:600}
    #gbd-log header button{background:#fff;border:1px solid #dadce0;color:#202124;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;margin-left:4px}
    #gbd-log header button:hover{background:#f8f9fa}
    #gbd-log pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:10px;line-height:1.5;font-size:11px}
    @media (prefers-color-scheme: dark) {
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
      pre.scrollTop = pre.scrollHeight;
    }
    console.log('[GeminiBulkDeleter]', ...a);
  }

  function getConversationDivs() {
    return Array.from(getAll('gem-nav-list-item[data-test-id="conversation"]'));
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
    let btn = get('#gbd-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'gbd-btn';
      btn.textContent = 'Delete All Chats';
      btn.setAttribute('role', 'status');
      btn.setAttribute('aria-live', 'polite');
      btn.addEventListener('click', onButtonClick, { passive: true });
      document.body.appendChild(btn);
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
      const closeBtn = document.createElement('button');
      closeBtn.id = 'gbd-close';
      closeBtn.textContent = 'Close';

      btnContainer.appendChild(copyBtn);
      btnContainer.appendChild(clearBtn);
      btnContainer.appendChild(closeBtn);
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
    const closeBtn = get('#gbd-close');

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

    if (closeBtn && !closeBtn.__gbdHooked) {
      closeBtn.__gbdHooked = true;
      closeBtn.onclick = () => showLog(false);
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

  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'd') {
      ensureUI();
      log('UI remounted');
    }
    if (e.shiftKey && e.key.toLowerCase() === 'l') {
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
      btn.textContent = 'Scanning...';
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
        btn.textContent = 'Delete All Chats';
        log('✗ No conversations found');
        log('Make sure chat history is visible in the sidebar');
        setTimeout(() => showLog(false), 3000);
        return;
      }

      S.armed = true;
      btn.classList.add('gbd-armed');
      btn.textContent = `Click again to delete ${S.convos.length} chats`;
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
        btn.textContent = `Deleting ${i + 1}/${targets.length}...`;

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

      btn.textContent = 'Delete All Chats';
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

    log('Gemini Bulk Deleter v2.1 loaded');
    log('Two-click mechanism: First click scans, second click deletes');
    ensureUI();
    hookSPARouteChanges();

    if (!S.ensureTimer) {
      S.ensureTimer = setInterval(ensureUI, 1500);
    }
  }

  boot();
})();