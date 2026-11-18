import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModelCatalog } from '../electron/model-catalog.mjs';

const token = 'fixture-private-catalog-token';
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

test('normalizes all model families, display names and duplicates at the configured endpoint', async () => {
  for (const [baseUrl, expected] of [
    ['https://fixture.invalid', '/v1/models'],
    ['https://fixture.invalid/v1/', '/v1/models'],
    ['https://fixture.invalid/api/anthropic', '/api/anthropic/v1/models'],
    ['https://fixture.invalid/api/anthropic/v1', '/api/anthropic/v1/models'],
  ]) {
    const models = await fetchModelCatalog({ baseUrl, authToken: token, fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, expected);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      return response({ data: [{ id: 'claude-sonnet', display_name: 'Claude Sonnet' }, { id: 'gpt-custom', name: 'GPT Custom' }, { id: 'gpt-custom' }, { id: 'provider-model' }, null] });
    } });
    assert.deepEqual(models, [{ id: 'claude-sonnet', displayName: 'Claude Sonnet' }, { id: 'gpt-custom', displayName: 'GPT Custom' }, { id: 'provider-model', displayName: 'provider-model' }]);
  }
});

test('supports API-key headers and same-origin bearer compatibility retry', async () => {
  const calls = [];
  await fetchModelCatalog({ baseUrl: 'https://fixture.invalid', apiKey: token, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return calls.length === 1 ? response({ error: token }, 401) : response({ data: [{ id: 'provider-model' }] });
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-api-key'], token);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[1].headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[1].headers['x-api-key'], undefined);
  assert.equal(calls[0].url, calls[1].url);
});

test('paginates Anthropic catalogs without losing non-Claude models', async () => {
  const urls = [];
  const models = await fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async url => {
    urls.push(new URL(url));
    return urls.length === 1
      ? response({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' })
      : response({ data: [{ id: 'gpt-b' }], has_more: false, last_id: 'gpt-b' });
  } });
  assert.equal(urls[0].searchParams.get('after_id'), null);
  assert.equal(urls[1].searchParams.get('after_id'), 'claude-a');
  assert.deepEqual(models.map(model => model.id), ['claude-a', 'gpt-b']);
});

test('supports token and cursor pagination without following server-supplied URLs', async () => {
  for (const [field, query] of [['next_page_token', 'page_token'], ['next_cursor', 'cursor']]) {
    let calls = 0;
    await fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async url => {
      calls += 1;
      if (calls === 1) return response({ data: [{ id: 'first' }], [field]: 'second-page' });
      assert.equal(new URL(url).searchParams.get(query), 'second-page');
      assert.equal(new URL(url).origin, 'https://fixture.invalid');
      return response({ data: [{ id: 'second' }] });
    } });
    assert.equal(calls, 2);
  }
});

test('uses a same-origin Codex manifest only when the standard catalog is empty', async () => {
  const calls = [];
  const models = await fetchModelCatalog({ baseUrl: 'https://fixture.invalid/api/v1/', authToken: token, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(new URL(url).origin, 'https://fixture.invalid');
    assert.equal(new URL(url).pathname, '/api/v1/models');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    if (calls.length === 1) return response({ data: [], object: 'list' });
    assert.equal(new URL(url).searchParams.get('client_version'), '1.0.0');
    assert.equal(new URL(url).searchParams.has('limit'), false);
    return response({ models: [{ slug: 'gpt-provider', display_name: 'GPT Provider' }, { slug: 'claude-provider' }, { slug: 'gpt-provider' }] });
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(models, [{ id: 'gpt-provider', displayName: 'GPT Provider' }, { id: 'claude-provider', displayName: 'claude-provider' }]);
});

test('keeps an empty standard catalog empty when optional discovery is empty or unsupported', async () => {
  for (const fallback of [() => response({ models: [] }), () => response({ data: [] }), () => response({ error: token }, 404), () => new Response(token)]) {
    let calls = 0;
    const models = await fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response({ data: [] }) : fallback();
    } });
    assert.deepEqual(models, []);
    assert.equal(calls, 2);
  }
});

test('does not suppress cancellation during optional Codex discovery', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = fetchModelCatalog({ baseUrl: 'https://fixture.invalid', signal: controller.signal, fetchImpl: async (_url, { signal }) => {
    calls += 1;
    if (calls === 1) return response({ data: [] });
    controller.abort();
    assert.equal(signal.aborted, true);
    throw new Error(token);
  } });
  await assert.rejects(pending, /已取消/);
  assert.equal(calls, 2);
});

test('does not return a silently truncated catalog for loops or excessive pages', async () => {
  await assert.rejects(fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => response({ data: [{ id: 'same' }], has_more: true, last_id: 'same' }) }), /分页重复/);
  let pages = 0;
  await assert.rejects(fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => {
    pages += 1;
    return response({ data: [{ id: `model-${pages}` }], has_more: true, last_id: `model-${pages}` });
  } }), /20 页/);
  assert.equal(pages, 20);
  await assert.rejects(fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => response({ data: Array.from({ length: 10001 }, (_, index) => ({ id: `model-${index}` })) }) }), /10000 项/);
});

test('reports safe HTTP and payload errors without echoing response secrets', async () => {
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(fetchModelCatalog({ baseUrl: 'https://fixture.invalid', authToken: token, fetchImpl: async () => response({ error: token }, status) }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
  await assert.rejects(fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => { throw new Error(token); } }), error => !error.message.includes(token));
  await assert.rejects(fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => response({ error: token }) }), /格式不受支持/);
  await assert.rejects(fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async () => new Response(token) }), /有效的 JSON/);
});

test('rejects credential-bearing URLs and redirects before exposing a catalog', async () => {
  let calls = 0;
  await assert.rejects(fetchModelCatalog({ baseUrl: `https://user:${token}@fixture.invalid`, fetchImpl: async () => { calls += 1; } }), /接口地址无效/);
  assert.equal(calls, 0);
  await assert.rejects(fetchModelCatalog({ baseUrl: 'https://fixture.invalid', authToken: token, fetchImpl: async () => ({ ok: true, status: 200, url: 'https://other.invalid/v1/models', json: async () => ({ data: [] }) }) }), /重定向/);
});

test('supports cancellation and a ten-second timeout without leaking fetch errors', async t => {
  const controller = new AbortController();
  const pending = fetchModelCatalog({ baseUrl: 'https://fixture.invalid', signal: controller.signal, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(token)), { once: true })) });
  controller.abort();
  await assert.rejects(pending, /已取消/);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = fetchModelCatalog({ baseUrl: 'https://fixture.invalid', fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(token)), { once: true })) });
  t.mock.timers.tick(10000);
  await assert.rejects(timeout, /超时/);
});
