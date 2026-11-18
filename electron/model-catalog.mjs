const MAX_PAGES = 20;
const MAX_MODELS = 10000;
const TIMEOUT_MS = 10000;

class ModelCatalogError extends Error {}

function endpointFor(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new ModelCatalogError('渠道接口地址无效，请在 CC Switch 中检查配置。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelCatalogError('渠道接口地址无效，请在 CC Switch 中检查配置。');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/v1$/i.test(pathname) ? `${pathname}/models` : `${pathname}/v1/models`;
  url.searchParams.set('limit', '100');
  return url;
}

function credential(value) {
  if (typeof value !== 'string') return '';
  if (/[\r\n\0]/.test(value)) throw new ModelCatalogError('渠道凭据格式无效，请在 CC Switch 中检查配置。');
  return value.trim();
}

function nextPage(payload, data) {
  if (payload.has_more === false) return null;
  if (payload.has_more === true) {
    const cursor = payload.last_id || data.at(-1)?.id;
    if (typeof cursor !== 'string' || !cursor) throw new ModelCatalogError('渠道模型列表缺少分页信息，无法确认完整列表。');
    return ['after_id', cursor];
  }
  if (typeof payload.next_page_token === 'string' && payload.next_page_token) return ['page_token', payload.next_page_token];
  if (typeof payload.next_cursor === 'string' && payload.next_cursor) return ['cursor', payload.next_cursor];
  return null;
}

function httpError(status) {
  if (status === 404 || status === 405) return new ModelCatalogError(`该渠道未提供模型列表接口（HTTP ${status}），可填写自定义模型 ID。`);
  if (status === 401 || status === 403) return new ModelCatalogError(`获取模型列表失败（HTTP ${status}），请检查该渠道的凭据与权限。`);
  return new ModelCatalogError(`获取模型列表失败（HTTP ${status}），请稍后重试。`);
}

function appendModels(models, entries, manifest = false) {
  for (const model of entries) {
    const rawId = manifest ? (model?.slug || model?.id) : model?.id;
    if (typeof rawId !== 'string' || !rawId.trim() || /[\r\n\0]/.test(rawId)) continue;
    const id = rawId.trim();
    const name = model.display_name || model.name;
    const displayName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 500) : id;
    if (!models.has(id)) models.set(id, { id, displayName });
  }
}

export async function fetchModelCatalog({ baseUrl, authToken, apiKey, signal, fetchImpl = globalThis.fetch }) {
  const endpoint = endpointFor(baseUrl);
  const token = credential(authToken).replace(/^Bearer\s+/i, '');
  const key = credential(apiKey);
  const headers = { Accept: 'application/json', 'anthropic-version': '2023-06-01' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (key) headers['x-api-key'] = key;

  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  timer.unref?.();
  const models = new Map();
  const cursors = new Set();
  let count = 0;
  let current = endpoint;
  try {
    const request = async url => {
      if (controller.signal.aborted) throw new Error('aborted');
      let response = await fetchImpl(url.href, { method: 'GET', headers: { ...headers }, signal: controller.signal, redirect: 'error' });
      // Some Anthropic-compatible gateways expose an OpenAI-style catalog.
      if ([401, 403].includes(response.status) && !token && key && !headers.Authorization) {
        await response.body?.cancel?.();
        delete headers['x-api-key'];
        headers.Authorization = `Bearer ${key}`;
        response = await fetchImpl(url.href, { method: 'GET', headers: { ...headers }, signal: controller.signal, redirect: 'error' });
      }
      if (response.redirected || (response.url && new URL(response.url).origin !== endpoint.origin)) {
        await response.body?.cancel?.();
        throw new ModelCatalogError('模型列表接口发生重定向，请在 CC Switch 中填写最终接口地址。');
      }
      if (!response.ok) {
        await response.body?.cancel?.();
        throw httpError(response.status);
      }
      return response;
    };
    const codexFallback = async () => {
      const url = new URL(endpoint);
      url.searchParams.delete('limit');
      url.searchParams.set('client_version', '1.0.0');
      try {
        const response = await request(url);
        const payload = await response.json();
        if (!Array.isArray(payload?.models) || payload.models.length > MAX_MODELS) return [];
        const manifestModels = new Map();
        appendModels(manifestModels, payload.models, true);
        return [...manifestModels.values()];
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return [];
      }
    };
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await request(current);
      let payload;
      try { payload = await response.json(); } catch { throw new ModelCatalogError('渠道返回的模型列表不是有效的 JSON。'); }
      if (!payload || !Array.isArray(payload.data)) throw new ModelCatalogError('渠道返回的模型列表格式不受支持，可填写自定义模型 ID。');
      count += payload.data.length;
      if (count > MAX_MODELS) throw new ModelCatalogError('渠道模型列表超过 10000 项，无法确认完整列表，可填写自定义模型 ID。');
      appendModels(models, payload.data);
      const next = nextPage(payload, payload.data);
      if (!next) return models.size ? [...models.values()] : await codexFallback();
      const marker = JSON.stringify(next);
      if (cursors.has(marker)) throw new ModelCatalogError('渠道模型列表分页重复，无法确认完整列表。');
      cursors.add(marker);
      current = new URL(endpoint);
      current.searchParams.set(...next);
    }
    throw new ModelCatalogError('渠道模型列表超过 20 页，无法确认完整列表，可填写自定义模型 ID。');
  } catch (error) {
    if (signal?.aborted) throw new ModelCatalogError('模型列表刷新已取消。');
    if (timedOut) throw new ModelCatalogError('获取模型列表超时，请重试。');
    if (error instanceof ModelCatalogError) throw error;
    throw new ModelCatalogError('无法获取该渠道的模型列表，请检查网络与接口地址。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
