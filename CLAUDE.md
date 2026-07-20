<!--
  claude-md-updater: This file is automatically maintained after each git commit.
  To prevent a section from being auto-edited, wrap it:
    <!-- protected -->
    ## Your Section
    content here...
    <!-- /protected -->
-->

# CLAUDE.md — AI_User_Scripts

## Tech Stack

Tampermonkey userscripts (vanilla JS, `@grant GM_addStyle` etc). No build step for the userscripts themselves. `package.json` carries two devDependencies: `playwright` (for `check-selectors.js`) and `vitest` (for `tests/`).

## Commands

No build step for the userscripts. Install via Tampermonkey (paste/import the `.user.js` file).

API request tests (fast, no browser/login needed, safe for CI):
```sh
npm install
npm test
```

Selector-drift smoke check (manual, not run in CI — needs a logged-in browser session per site):
```sh
npm install
npx playwright install chromium   # one-time
node check-selectors.js
```

## Architecture

- `Claude Bulk Deleter.user.js` — bulk-deletes claude.ai chats and Claude Code sessions via `/v1/code/sessions?exclude_tags=-`; distinguishes web chats (`cowork-remote` tag, bulk-queued) from real Claude Code sessions (confirmed one by one) since `status` is `active` for nearly everything now.
- `Gemini Bulk Deleter.user.js` — bulk-deletes gemini.google.com conversations via DOM automation (`gem-nav-list-item` menu clicks); selectors track Gemini's UI markup and break on redesigns.
- `ChatGPT Bulk Deleter.user.js` — same API-driven pattern as Claude's script, for chatgpt.com.
- `check-selectors.js` — manual Playwright smoke check: opens each site in a real logged-in browser and asserts the Gemini script's CSS selectors still resolve. Informational-only for the ChatGPT/Claude scripts (no selector surface — they hit REST APIs directly).
- `tests/` — vitest integration tests for the Claude and ChatGPT scripts' API request-building logic (`tests/helpers/loadClaudeApi.js` and `loadChatGptApi.js` extract those functions from the `.user.js` source via text markers and run them against a mocked `fetch`). No test coverage for Gemini (DOM-driven, covered by `check-selectors.js` instead).

## Conventions

Two-click arm/confirm mechanism before destructive bulk delete. Log panel kept visible on error for diagnosis.
