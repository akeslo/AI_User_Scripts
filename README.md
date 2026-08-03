# AI User Scripts

Userscripts for bulk deleting conversations in Gemini, Claude, and ChatGPT, plus an
auth-recovery script for Microsoft 365 behind a Defender for Cloud Apps proxy.

## Scripts

*   **Gemini Bulk Deleter.user.js**: A script to bulk delete conversations in Gemini.
*   **Claude Bulk Deleter.user.js**: A script to bulk delete conversations in Claude. It distinguishes real Claude Code sessions from web chats by tag (not status) — only web chats are bulk-queued for deletion, while sessions require individual confirmation.
*   **ChatGPT Bulk Deleter.user.js**: A script to bulk delete conversations in ChatGPT.
*   **MCAS Auth Recovery.user.js**: Recovers Teams/Outlook when they hang forever on the
    boot spinner behind the `*.mcas.ms` reverse proxy. Detects the specific failure
    (empty MSAL token cache + `interaction_required` + `failed_to_redirect`, so the
    sign-in redirect never fired and the page can never finish booting), clears only the
    stale sign-in markers, and re-navigates to the canonical origin so a real top-level
    sign-in can run. Requires both a dead shell and auth-failure evidence before acting,
    shows a cancellable countdown, and is rate-limited so it can never redirect-loop.

## Installation

To use these scripts, you need to have a user script manager like [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/) installed in your browser.

1.  Install a user script manager.
2.  Click on the raw version of the script you want to install.
3.  The user script manager will open and ask for confirmation to install the script.

## Usage

Once installed, the scripts will add a "Bulk Delete" button to the respective web interface. Click the button to start deleting conversations.

## API request tests

`ChatGPT Bulk Deleter.user.js` and `Claude Bulk Deleter.user.js` drive their
sites via REST APIs (`/backend-api/conversations` and `/v1/code/sessions`
respectively). `tests/` contains vitest integration tests that extract each
script's request-building functions, run them against a mocked `fetch`, and
assert the resulting requests (URL, method, headers, body) match what each
API expects — including graceful failure when the API responds with an
error status or an unexpected/malformed body. These run fast, need no
browser or login, and are safe to run in CI:

```sh
npm install
npm test
```

## Helpers synchronization check

The `sleep`/`get`/`showLog`/`log` helper functions are intentionally duplicated
across the Claude, ChatGPT, and Gemini bulk deleter scripts rather than shared,
and kept in sync by hand. `validate-helpers-sync.js` checks that all three
copies still carry the `DUPLICATED HELPERS` marker, that their signatures
match, and that the XSS-safety invariant (`log()` using `textContent`, never
`innerHTML`) holds in every copy. Fast, no browser needed, safe for CI:

```sh
npm run check-sync
```

`npm test` also runs this validator (via `tests/helpers-sync.test.js`), so a
change that breaks either invariant fails the normal test run — you do not have
to remember the command above. Run it directly when you want just this check, or
its full per-file output.

## Selector-drift smoke check

`check-selectors.js` is a manual, on-demand tool that opens each site in a
real (logged-in) browser and verifies the CSS selectors "Gemini Bulk
Deleter.user.js" depends on still exist in the live DOM. It exists because
Gemini's UI has changed underneath this userscript before, silently breaking
it — see `CLAUDE.md`. ("ChatGPT Bulk Deleter.user.js" and "Claude Bulk
Deleter.user.js" drive their sites via REST API calls rather than DOM
selectors, so the check is informational-only for those two — see the file
header comment for details.)

**Why this matters**: If Gemini's UI changes and the selectors no longer match,
the bulk deleter will fail silently when scanning for conversations. If a
selector fails during deletion (e.g., menu button selector breaks), the script
logs a clear error message; but if the conversation list selector breaks, you
may see "No conversations found" with no indication that the selector itself
has changed.

It requires a logged-in browser session for each site and is **not** run in
CI. Run it by hand, either periodically or right after the bulk deleter seems
to have broken:

```sh
npm install
npx playwright install chromium   # one-time browser binary install
npm run check-selectors
```

The first run opens a visible Chromium window; log in to each site by hand.
The session is cached in `.playwright-profile/` (gitignored) for next time.
Full details are in the comment header of `check-selectors.js`.

**Manual validation**: If the script doesn't detect conversations (shows "No
conversations found"), first ensure the chat history is visible in the sidebar.
If it still doesn't work, run `check-selectors.js` to verify the selectors
still match the current Gemini UI — if not, the tool may need updates to match
UI changes.
