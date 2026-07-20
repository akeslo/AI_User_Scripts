import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBlock } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.resolve(__dirname, '..', '..', 'ChatGPT Bulk Deleter.user.js');

export const chatGptSrc = readFileSync(SRC_PATH, 'utf8');

// Two blocks, deliberately skipping the `log()`/DOM-helper block in between
// (~L61-69) so the extracted code never touches `document` for logging and
// always uses the `log` stub this harness injects.
const block1 = extractBlock(
  chatGptSrc,
  'const sleep = ms =>',
  '\n\n  // NOTE: log must stay textContent'
);
const block2 = extractBlock(
  chatGptSrc,
  'async function getBearer(){',
  '\n\n  // ---------- Mount and resilience'
);

const BODY = `
  ${block1}
  ${block2}
  return { getCookie, getBearer, http, listPage, listAllIds, delSoftHard, delGraphQL, deleteOne };
`;

/**
 * Loads the ChatGPT Bulk Deleter's API-calling functions in isolation.
 * @param {{fetch: Function, cookie?: string, origin?: string, log?: Function}} opts
 */
export function loadChatGptApi({
  fetch,
  cookie = 'csrfToken=test-csrf-token; oai-did=device-42',
  origin = 'https://chatgpt.com',
  log = () => {},
}) {
  const factory = new Function('fetch', 'document', 'window', 'log', BODY);
  return factory(fetch, { cookie }, { location: { origin } }, log);
}
