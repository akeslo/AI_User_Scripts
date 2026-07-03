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

  window.__GBD_SUP__ = window.__GBD_SUP__ || {
    mounted: false,
    running: false,
    armed: false,
    logStore: [],
    ensureTimer: null,
    lastUrl: location.href
  };
  const S = window.__GBD_SUP__;

  GM_addStyle(`
    #gbd-btn{position:fixed;top:12px;left:12px;z-index:2147483647;padding:10px 14px;border:none;border-radius:10px;background:#1a73e8;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);transition:background .2s}
    #gbd-btn:hover{background:#1765cc}
    #gbd-btn[disabled]{opacity:.6;cursor:not-allowed;background:#5f6368}
    #gbd-log{position:fixed;bottom:12px;left:12px;width:500px;max-height:60vh;overflow:auto;border:1px solid #dadce0;background:#fff;color:#202124;border-radius:10px;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.35);font:11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;display:none}
    #gbd-log header{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #dadce0;background:#f8f9fa;border-top-left-radius:10px;border-top-right-radius:10px}
    #gbd-log header b{font-size:12px;font-weight:600}
    #gbd-log header button{background:#fff;border:1px solid #dadce0;color:#202124;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;margin-left:4px}
    #gbd-log header button:hover{background:#f8f9fa}
    #gbd-log pre{white-space:pre-wrap;margin:0;padding:10px;line-height:1.5;font-size:11px}
    @media (prefers-color-scheme: dark) {
      #gbd-log{background:#202124;color:#e8eaed;border-color:#5f6368}
      #gbd-log header{background:#292a2d;border-color:#5f6368}
      #gbd-log header button{background:#292a2d;border-color:#5f6368;color:#e8eaed}
      #gbd-log header button:hover{background:#3c4043}
    }
  `);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = sel => document.querySelector(sel);
  const getAll = sel => document.querySelectorAll(sel);

  function showLog(show) {
    const el = get('#gbd-log');
    if (el) el.style.display = show ? 'block' : 'none';
  }

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
        throw new Error(`No menu button found for "${title}"`);
      }

      // Click menu button
      menuBtn.click();
      await sleep(400);

      // Wait for menu to appear
      const menu = await waitForMenu();
      if (!menu) {
        throw new Error('Menu did not appear');
      }

      // Find delete button in menu
      const deleteBtn = await findDeleteButton(menu);
      if (!deleteBtn) {
        throw new Error('Delete button not found in menu');
      }

      // Click delete
      deleteBtn.click();
      await sleep(400);

      // Find and click confirm button
      const confirmBtn = await findConfirmButton();
      if (!confirmBtn) {
        throw new Error('Confirm button not found');
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
    new MutationObserver(() => ensureUI()).observe(document.documentElement, {
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
      const convos = getConversationDivs();
      window.__GBD_CONVOS__ = convos;

      btn.disabled = false;
      S.running = false;

      if (!convos.length) {
        btn.textContent = 'Delete All Chats';
        log('✗ No conversations found');
        log('Make sure chat history is visible in the sidebar');
        setTimeout(() => showLog(false), 3000);
        return;
      }

      S.armed = true;
      btn.textContent = `Click again to delete ${convos.length} chats`;
      log(`✓ Found ${convos.length} conversations`);
      log('ARMED - Click button again to start deletion');
      return;
    }

    if (S.armed) {
      S.armed = false;
      S.running = true;
      showLog(true);

      const convos = Array.isArray(window.__GBD_CONVOS__) ? window.__GBD_CONVOS__ : [];
      btn.disabled = true;
      log('='.repeat(50));
      log(`Starting deletion of ${convos.length} conversations...`);
      log('='.repeat(50));

      let ok = 0, fail = 0;

      for (let i = 0; i < convos.length; i++) {
        const convo = convos[i];
        btn.textContent = `Deleting ${i + 1}/${convos.length}...`;

        if (!document.contains(convo)) {
          log(`[${i + 1}/${convos.length}] Already removed`);
          ok++;
          continue;
        }

        const result = await deleteConversation(convo);
        if (result.success) {
          ok++;
          log(`[${i + 1}/${convos.length}] ✓ "${result.title}"`);
        } else {
          fail++;
          log(`[${i + 1}/${convos.length}] ✗ "${result.title}" - ${result.error || 'Unknown error'}`);
        }

        await sleep(400);

        if ((i + 1) % 5 === 0) {
          log(`Progress: ${ok} deleted, ${fail} failed`);
        }
      }

      log('='.repeat(50));
      log(`COMPLETE: ${ok} deleted, ${fail} failed (${convos.length} total)`);
      log('='.repeat(50));

      btn.textContent = 'Delete All Chats';
      btn.disabled = false;
      S.running = false;

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