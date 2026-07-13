#!/usr/bin/env node
'use strict';

/**
 * check-selectors.js — manual selector-drift smoke check
 * =========================================================
 * Companion tooling for "Gemini Bulk Deleter.user.js", "ChatGPT Bulk Deleter.user.js",
 * and "Claude Bulk Deleter.user.js".
 *
 * WHAT THIS IS
 * ------------
 * The Gemini userscript automates chat deletion by querying hardcoded CSS
 * selectors against Gemini's DOM (gem-nav-list-item, .title-text, etc). Those
 * selectors have no contract with Google and silently break whenever Gemini's
 * UI is redesigned — this repo's CLAUDE.md and commit history both document
 * exactly that failure mode. This script is a smoke check: it loads the live
 * site and asserts every selector the userscript depends on still resolves to
 * at least one element. If a selector comes back empty, the userscript is
 * broken (or about to be) and needs updating BEFORE the operator relies on it
 * for a real bulk delete.
 *
 * ChatGPT Bulk Deleter.user.js and Claude Bulk Deleter.user.js do NOT drive
 * the DOM at all — they call each site's internal REST/GraphQL API directly
 * (session/bootstrap endpoints, /backend-api/conversations, /api/organizations/
 * <org>/chat_conversations, /v1/code/sessions, etc). They have no CSS selector
 * surface to smoke-test the same way. This script still opens each of those
 * sites and does a minimal reachability check (page loads, is not stuck on an
 * auth wall) as a sanity signal, but the real "did the API contract change"
 * risk for those two scripts is not something a selector check can catch —
 * see the NOTE block below.
 *
 * HOW TO RUN IT
 * -------------
 *   npm install          # one-time, installs the Playwright devDependency
 *   npx playwright install chromium   # one-time, installs the browser binary
 *   node check-selectors.js
 *
 * or:
 *   npm run check-selectors
 *
 * This is a MANUAL, ON-DEMAND tool. It is NOT wired into CI and should not
 * be, because:
 *   - It requires a real, logged-in browser session for gemini.google.com,
 *     chatgpt.com, and claude.ai. There is no headless/service-account way to
 *     authenticate to any of these three products.
 *   - It is meant to be run by the operator, by hand, either (a) periodically
 *     as a "did anything change" spot check, or (b) reactively right after the
 *     bulk deleter appears to have stopped working, to confirm/diagnose a UI
 *     redesign before patching selectors.
 *
 * AUTHENTICATION
 * ---------------
 * The script launches a *persistent* Chromium profile stored in
 * `.playwright-profile/` (already excluded from git — see .gitignore) so you
 * only need to log in once:
 *
 *   1. Run `node check-selectors.js`. A visible Chromium window opens.
 *   2. The first time, each site will show its normal login page. Log in by
 *      hand (Google account for Gemini, OpenAI account for ChatGPT, Anthropic
 *      account for Claude) in the window that opens.
 *   3. Re-run the script. Subsequent runs reuse the saved cookies/session in
 *      `.playwright-profile/` and should land you on the already-authenticated
 *      chat list for each site.
 *
 * If a site still shows a login page on a re-run, the session expired — log
 * in again by hand; the script cannot and should not do this for you.
 *
 * OUTPUT
 * ------
 * For each site: PASS/FAIL per selector, plus a final summary. Exit code is
 * non-zero if any selector failed to resolve on any site, so it's usable as
 * a manual gate even though it's not CI-gated.
 */

const path = require('path');
const { chromium } = require('playwright');

const PROFILE_DIR = path.join(__dirname, '.playwright-profile');

// ---------------------------------------------------------------------------
// Selectors extracted verbatim from the userscripts. Keep these in lockstep
// with the source files — if you change a selector in the .user.js, update it
// here too, in the same commit.
// ---------------------------------------------------------------------------

const SITES = [
  {
    name: 'Gemini',
    userscript: 'Gemini Bulk Deleter.user.js',
    url: 'https://gemini.google.com/app',
    // DOM selectors the userscript queries against the live page.
    // Source line refs are from "Gemini Bulk Deleter.user.js" as of this check's authoring.
    domSelectors: [
      {
        selector: 'gem-nav-list-item[data-test-id="conversation"]',
        note: 'getConversationDivs() — sidebar conversation rows',
      },
      {
        selector: '.title-text',
        note: 'extractTitle() — chat title text inside a conversation row',
      },
      {
        selector: '[data-test-id="actions-menu-button"] button',
        note: 'findMenuButtonForConversation() — per-row overflow/actions menu button',
      },
      {
        selector: '.cdk-overlay-pane',
        note: 'waitForMenu() / findConfirmButton() — Angular CDK overlay used for the actions menu and the delete-confirm dialog',
      },
      {
        selector: '[role="dialog"]',
        note: 'findConfirmButton() — delete confirmation dialog (checked together with .cdk-overlay-pane)',
      },
    ],
  },
  {
    name: 'ChatGPT',
    userscript: 'ChatGPT Bulk Deleter.user.js',
    url: 'https://chatgpt.com/',
    // NOTE: This script deletes chats via REST/GraphQL API calls
    // (/api/auth/session, /backend-api/conversations, /backend-api/graphql),
    // not DOM selectors. There is no chat-list CSS selector surface to smoke
    // test the way Gemini's is. Left empty intentionally — see file header.
    domSelectors: [],
    apiNote:
      'Uses /api/auth/session (bearer token), /backend-api/conversations (list+patch+delete), ' +
      '/api/conversations, and /backend-api/graphql fallback mutations. A selector check cannot ' +
      'catch drift here; only an authenticated end-to-end run of the userscript itself can.',
  },
  {
    name: 'Claude',
    userscript: 'Claude Bulk Deleter.user.js',
    url: 'https://claude.ai/',
    // Same story as ChatGPT: org-scoped REST calls
    // (/api/bootstrap, /api/organizations/<org>/chat_conversations, /v1/code/sessions),
    // no DOM selectors involved in the delete path.
    domSelectors: [],
    apiNote:
      'Uses /api/bootstrap (org id detection), /api/organizations/<org>/chat_conversations ' +
      '(list+delete), and /v1/code/sessions (list+delete for Claude Code sessions). A selector ' +
      'check cannot catch drift here; only an authenticated end-to-end run of the userscript itself can.',
  },
];

async function checkSite(browserContext, site) {
  console.log(`\n=== ${site.name} (${site.userscript}) ===`);
  const page = await browserContext.newPage();
  const results = [];

  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give SPA client-side rendering a moment to hydrate the sidebar/chat list.
    await page.waitForTimeout(3000);
  } catch (err) {
    console.log(`  [FAIL] could not load ${site.url}: ${err.message}`);
    await page.close();
    return [{ selector: '(page load)', ok: false, count: 0, error: err.message }];
  }

  if (site.domSelectors.length === 0) {
    console.log('  (no DOM selectors to check — this script drives the site via REST API, not the DOM)');
    if (site.apiNote) console.log(`  API surface: ${site.apiNote}`);
    // Minimal reachability signal only: did we land somewhere other than an
    // obvious logged-out page? We don't assert anything strongly here since
    // we have no selector contract to check — this is informational only.
    const finalUrl = page.url();
    console.log(`  Landed on: ${finalUrl}`);
    await page.close();
    return results;
  }

  for (const { selector, note } of site.domSelectors) {
    try {
      const count = await page.locator(selector).count();
      const ok = count > 0;
      results.push({ selector, ok, count });
      const status = ok ? 'PASS' : 'FAIL';
      console.log(`  [${status}] ${selector}  (matched ${count})  — ${note}`);
    } catch (err) {
      results.push({ selector, ok: false, count: 0, error: err.message });
      console.log(`  [FAIL] ${selector}  — error: ${err.message}  — ${note}`);
    }
  }

  await page.close();
  return results;
}

async function main() {
  console.log('Selector-drift smoke check for AI_User_Scripts bulk deleters.');
  console.log(`Persistent browser profile: ${PROFILE_DIR}`);
  console.log('If any site below is not already logged in, a window will open — log in by hand, then re-run.\n');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
  });

  const allResults = [];
  let hadFailure = false;

  try {
    for (const site of SITES) {
      const results = await checkSite(context, site);
      allResults.push({ site: site.name, results });
      if (results.some(r => !r.ok)) hadFailure = true;
    }
  } finally {
    await context.close();
  }

  console.log('\n=== Summary ===');
  for (const { site, results } of allResults) {
    if (results.length === 0) {
      console.log(`${site}: no DOM selectors checked (API-driven script)`);
      continue;
    }
    const failed = results.filter(r => !r.ok);
    if (failed.length === 0) {
      console.log(`${site}: ${results.length}/${results.length} selectors OK`);
    } else {
      console.log(`${site}: ${failed.length}/${results.length} selectors FAILED — ${failed.map(f => f.selector).join(', ')}`);
    }
  }

  if (hadFailure) {
    console.log('\nOne or more selectors failed to resolve. The corresponding userscript likely needs updating for a UI redesign.');
    process.exitCode = 1;
  } else {
    console.log('\nAll checked selectors resolved. No drift detected on this pass.');
  }
}

main().catch(err => {
  console.error('check-selectors.js crashed:', err);
  process.exitCode = 1;
});
