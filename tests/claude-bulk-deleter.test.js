import { describe, it, expect, vi } from 'vitest';
import { loadClaudeApi } from './helpers/loadClaudeApi.js';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('Claude Bulk Deleter — /v1/code/sessions (GET)', () => {
  it('requests the sessions list with the exact URL, method, and headers the API expects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { id: 's1', title: 'Web chat', tags: ['cowork-remote'] },
          { id: 's2', title: 'Code session', tags: ['remote-control-x'] },
        ],
      })
    );
    const api = loadClaudeApi({ fetch: fetchMock });

    const sessions = await api.fetchAllSessions();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://claude.ai/v1/code/sessions?limit=200&exclude_tags=-');
    expect(opts.method).toBeUndefined(); // fetch defaults to GET
    expect(opts.credentials).toBe('include');
    expect(opts.cache).toBe('no-store');
    expect(opts.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-client-platform': 'web_claude_ai',
      'anthropic-version': '2023-06-01',
    });

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ _kind: 'code', _id: 's1', _webChat: true });
    expect(sessions[1]).toMatchObject({ _kind: 'code', _id: 's2', _webChat: false });
  });

  it('fails gracefully (returns []) when the API responds with a non-OK status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    const api = loadClaudeApi({ fetch: fetchMock });

    const sessions = await api.fetchAllSessions();
    expect(sessions).toEqual([]);
  });

  it('fails gracefully (returns []) when the response body is missing the expected `data` field', async () => {
    // Malformed/unexpected shape: API returns 200 but no `data` array.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ unexpected: 'shape' }));
    const api = loadClaudeApi({ fetch: fetchMock });

    const sessions = await api.fetchAllSessions();
    expect(sessions).toEqual([]);
  });
});

describe('Claude Bulk Deleter — /v1/code/sessions/<id> (DELETE)', () => {
  it('sends a DELETE with the exact URL and headers, and no body, for a Claude Code session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, true, 200));
    const api = loadClaudeApi({ fetch: fetchMock });

    const ok = await api.deleteChat({ _kind: 'code', _id: 's1', _title: 'Code session' });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://claude.ai/v1/code/sessions/s1');
    expect(opts.method).toBe('DELETE');
    expect(opts.credentials).toBe('include');
    expect(opts.body).toBeUndefined();
    expect(opts.headers).toMatchObject({
      'anthropic-client-platform': 'web_claude_ai',
      'anthropic-version': '2023-06-01',
    });
  });

  it('returns false when the delete request fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 404));
    const api = loadClaudeApi({ fetch: fetchMock });

    const ok = await api.deleteChat({ _kind: 'code', _id: 'missing', _title: 'gone' });
    expect(ok).toBe(false);
  });

  it('uses the frame-specific headers and URL shape for artifact frames', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, true, 200));
    const api = loadClaudeApi({ fetch: fetchMock });

    await api.deleteChat({ _kind: 'frame', _id: 'artifact-slug', _title: 'An artifact' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://claude.ai/api/frame/artifact-slug?org=org-test-123');
    expect(opts.headers).toMatchObject({ 'x-frame-cp': 'go' });
  });
});
