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

Tampermonkey userscripts (vanilla JS, `@grant GM_addStyle` etc). No build/package manager.

## Commands

No build step. Install via Tampermonkey (paste/import the `.user.js` file).

## Architecture

- `Claude Bulk Deleter.user.js` — bulk-deletes claude.ai chats and Claude Code sessions (`/v1/code/sessions`) via org-scoped API calls; collapsible pull-tab UI.
- `Gemini Bulk Deleter.user.js` — bulk-deletes gemini.google.com conversations via DOM automation (`gem-nav-list-item` menu clicks); selectors track Gemini's UI markup and break on redesigns.
- `ChatGPT Bulk Deleter.user.js` — same pattern for chatgpt.com.

## Conventions

Two-click arm/confirm mechanism before destructive bulk delete. Log panel kept visible on error for diagnosis.
