# AI User Scripts

This repository contains a collection of user scripts for bulk deleting conversations in Gemini, Claude, and ChatGPT.

## Scripts

*   **Gemini Bulk Deleter.user.js**: A script to bulk delete conversations in Gemini.
*   **Claude Bulk Deleter.user.js**: A script to bulk delete conversations in Claude. It distinguishes real Claude Code sessions from web chats by tag (not status) — only web chats are bulk-queued for deletion, while sessions require individual confirmation.
*   **ChatGPT Bulk Deleter.user.js**: A script to bulk delete conversations in ChatGPT.

## Installation

To use these scripts, you need to have a user script manager like [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/) installed in your browser.

1.  Install a user script manager.
2.  Click on the raw version of the script you want to install.
3.  The user script manager will open and ask for confirmation to install the script.

## Usage

Once installed, the scripts will add a "Bulk Delete" button to the respective web interface. Click the button to start deleting conversations.

## Selector-drift smoke check

`check-selectors.js` is a manual, on-demand tool that opens each site in a
real (logged-in) browser and verifies the CSS selectors "Gemini Bulk
Deleter.user.js" depends on still exist in the live DOM. It exists because
Gemini's UI has changed underneath this userscript before, silently breaking
it — see `CLAUDE.md`. ("ChatGPT Bulk Deleter.user.js" and "Claude Bulk
Deleter.user.js" drive their sites via REST API calls rather than DOM
selectors, so the check is informational-only for those two — see the file
header comment for details.)

It requires a logged-in browser session for each site and is **not** run in
CI. Run it by hand, either periodically or right after the bulk deleter seems
to have broken:

```sh
npm install
npx playwright install chromium   # one-time browser binary install
node check-selectors.js
```

The first run opens a visible Chromium window; log in to each site by hand.
The session is cached in `.playwright-profile/` (gitignored) for next time.
Full details are in the comment header of `check-selectors.js`.
