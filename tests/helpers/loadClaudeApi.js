import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBlock, extractStatement } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(__dirname, '..', '..', 'Claude Bulk Deleter.user.js');

export const claudeSrc = readFileSync(SRC_PATH, 'utf8');

// Pull out just the API-calling functions (commonHeaders through deleteChat),
// deliberately skipping the earlier `log()`/DOM-helper block (~L48-71) so
// the extracted code never touches `document` and always uses the `log`
// stub this harness injects.
const apiBaseLine = extractStatement(claudeSrc, 'const apiBase = () =>');
const mainBlock = extractBlock(
  claudeSrc,
  'function commonHeaders(extra) {',
  '\n  function applyCollapsed()'
);

const BODY = `
  let orgId = ${JSON.stringify('org-test-123')};
  ${apiBaseLine}
  ${mainBlock}
  return {
    commonHeaders,
    apiBase,
    detectOrgId,
    fetchAllChats,
    fetchAllSessions,
    isWebChatSession,
    fetchFrames,
    fetchPublishedArtifacts,
    deleteChat,
  };
`;

/**
 * Loads the Claude Bulk Deleter's API-calling functions in isolation.
 * @param {{fetch: Function, origin?: string, log?: Function}} opts
 */
export function loadClaudeApi({ fetch, origin = 'https://claude.ai', log = () => {} }) {
  const factory = new Function('fetch', 'location', 'log', BODY);
  return factory(fetch, { origin }, log);
}
