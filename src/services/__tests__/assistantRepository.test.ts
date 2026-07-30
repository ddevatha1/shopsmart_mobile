import { resolveAssistantIntent } from '../assistantRepository';
import { apiClient, ApiError } from '../apiClient';
import type { Intent } from '../../models/intent';

/** Node's global `fetch` (this project's jest testEnvironment is 'node')
 * — mocked directly rather than adding a fetch-mocking dependency, same
 * "no new dependencies" constraint every other sprint has followed. */
function mockFetchOnce(response: { ok: boolean; status?: number; body: unknown }): jest.Mock {
  const mockFetch = jest.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body,
  });
  global.fetch = mockFetch as unknown as typeof fetch;
  return mockFetch;
}

describe('resolveAssistantIntent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('sends a POST request to /api/assistant/intent with the right body', async () => {
    const intent: Intent = { type: 'search', confidence: 0.8, parameters: { query: 'apples' } };
    const mockFetch = mockFetchOnce({ ok: true, body: { intent } });

    await resolveAssistantIntent('find apples', { currentScreen: 'Search' });

    expect(mockFetch).toHaveBeenCalledWith(
      `${apiClient.baseUrl}/api/assistant/intent`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'find apples', context: { currentScreen: 'Search' } }),
      }),
    );
  });

  test('omits `context` entirely from the request body when none is given', async () => {
    const intent: Intent = { type: 'search', confidence: 0.8, parameters: {} };
    const mockFetch = mockFetchOnce({ ok: true, body: { intent } });

    await resolveAssistantIntent('find apples');

    const call = mockFetch.mock.calls[0][1] as { body: string };
    expect(JSON.parse(call.body)).toEqual({ text: 'find apples' });
  });

  test('parses and returns the real Intent from the response body', async () => {
    const intent: Intent = { type: 'add_to_cart', confidence: 0.8, parameters: { item: 'milk' } };
    mockFetchOnce({ ok: true, body: { intent } });

    const result = await resolveAssistantIntent('add milk');

    expect(result).toEqual(intent);
  });

  test('a non-ok HTTP response throws ApiError with the server-provided message', async () => {
    mockFetchOnce({ ok: false, status: 500, body: { error: 'intent router unavailable' } });

    await expect(resolveAssistantIntent('find apples')).rejects.toThrow(ApiError);
    await expect(resolveAssistantIntent('find apples')).rejects.toThrow('intent router unavailable');
  });

  test('a network-level failure (fetch itself rejects) propagates as a real error, not a silent success', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    await expect(resolveAssistantIntent('find apples')).rejects.toThrow('network down');
  });
});
