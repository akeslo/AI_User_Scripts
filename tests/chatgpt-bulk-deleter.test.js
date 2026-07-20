import { describe, it, expect, vi } from 'vitest';
import { loadChatGptApi } from './helpers/loadChatGptApi.js';

function textResponse(body, ok = true, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok, status, text: async () => text, json: async () => JSON.parse(text) };
}

describe('ChatGPT Bulk Deleter — /backend-api/conversations (GET, paginated list)', () => {
  it('requests the conversations page with the exact URL and bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      textResponse({ items: [{ id: 'c1' }, { id: 'c2' }], total: 2, has_more: false })
    );
    const api = loadChatGptApi({ fetch: fetchMock });

    const page = await api.listPage(0, 100, 'bearer-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated');
    expect(opts.credentials).toBe('include');
    expect(opts.headers).toEqual({ Authorization: 'Bearer bearer-token' });

    expect(page).toEqual({ ids: ['c1', 'c2'], total: 2, hasMore: false });
  });

  it('falls back through the alternate list URLs when the primary one fails', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('/api/conversations?')) {
        return textResponse({ items: [{ id: 'c9' }], total: 1, has_more: false });
      }
      return textResponse({}, false, 500);
    });
    const api = loadChatGptApi({ fetch: fetchMock });

    const page = await api.listPage(0, 100, null);
    expect(page).toEqual({ ids: ['c9'], total: 1, hasMore: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails gracefully (empty ids) when every list URL is malformed/unreachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse({}, false, 500));
    const api = loadChatGptApi({ fetch: fetchMock });

    const page = await api.listPage(0, 100, 'bearer-token');
    expect(page).toEqual({ ids: [], total: 0, hasMore: false });
  });
});

describe('ChatGPT Bulk Deleter — conversation delete payloads', () => {
  it('falls back to the bulk-delete endpoint with the exact body shape the API expects', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      // Reject every per-id PATCH/DELETE attempt so delSoftHard falls through
      // to the bulk POST /backend-api/conversations/delete path.
      if (url === 'https://chatgpt.com/backend-api/conversations/delete') {
        return textResponse({ success: true }, true, 200);
      }
      return textResponse({}, false, 404);
    });
    const api = loadChatGptApi({ fetch: fetchMock });

    const ok = await api.delSoftHard('convo-99', 'tok-abc');
    expect(ok).toBe(true);

    const bulkCall = fetchMock.mock.calls.find(
      ([url]) => url === 'https://chatgpt.com/backend-api/conversations/delete'
    );
    expect(bulkCall).toBeDefined();
    const [, opts] = bulkCall;
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ conversation_ids: ['convo-99'] });
    expect(opts.headers).toMatchObject({
      'X-CSRF-Token': 'test-csrf-token',
      'OAI-Device-Id': 'device-42',
      Authorization: 'Bearer tok-abc',
      'Content-Type': 'application/json',
    });
  });

  it('sends the correct GraphQL mutation payload when REST deletion is unavailable', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === 'https://chatgpt.com/backend-api/graphql') {
        const payload = JSON.parse(opts.body);
        if (payload.operationName === 'deleteConversation') {
          return textResponse({ data: { deleteConversation: { id: payload.variables.conversationId } } });
        }
      }
      return textResponse({}, false, 404);
    });
    const api = loadChatGptApi({ fetch: fetchMock });

    const ok = await api.delGraphQL('convo-42', 'tok-abc');
    expect(ok).toBe(true);

    const gqlCall = fetchMock.mock.calls.find(([url]) => url === 'https://chatgpt.com/backend-api/graphql');
    expect(gqlCall).toBeDefined();
    const [, opts] = gqlCall;
    const payload = JSON.parse(opts.body);
    expect(payload).toMatchObject({
      operationName: 'deleteConversation',
      variables: { conversationId: 'convo-42' },
    });
  });

  it('returns false when neither REST nor GraphQL deletion succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse({}, false, 500));
    const api = loadChatGptApi({ fetch: fetchMock });

    const ok = await api.deleteOne('convo-1', 'tok-abc');
    expect(ok).toBe(false);
  });
});
