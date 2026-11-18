import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

export const endpointIdentity = value => {
  try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/+$/, '')}`; }
  catch { return String(value || '').replace(/\/+$/, ''); }
};

export function matchingCodexProvider(settings, request) {
  try {
    const token = String(request.authToken || request.apiKey || '').replace(/^Bearer\s+/i, '').trim();
    if (!token || settings.auth?.OPENAI_API_KEY?.trim() !== token) return null;
    const config = parse(settings.config);
    const provider = config.model_providers?.[config.model_provider];
    if (!provider?.base_url || provider.wire_api !== 'responses' || config.model_catalog_json) return null;
    if (endpointIdentity(provider.base_url) !== endpointIdentity(request.baseUrl)) return null;
    return { baseUrl: provider.base_url };
  } catch { return null; }
}

export function providerRequestKey(env) {
  return createHash('sha256').update(JSON.stringify({
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    authToken: env.ANTHROPIC_AUTH_TOKEN,
    apiKey: env.ANTHROPIC_API_KEY,
  })).digest('hex');
}

export function canonicalClaudeModel(value, aliases = {}) {
  if (typeof value !== 'string') return null;
  const selected = value.replace(/\[1m\]$/i, '');
  const model = String(aliases[selected] || selected).replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');
  return model.length <= 160 && model === model.trim() && /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(model) ? model : null;
}

export function claudeModelAliases(env = {}) {
  return Object.fromEntries(['opus', 'sonnet', 'haiku', 'fable'].flatMap(family => {
    const model = canonicalClaudeModel(env[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`]);
    return model ? [[family, model]] : [];
  }));
}

export function hasAutoCompactEnvironmentOverride(value) {
  if (typeof value !== 'string') return false;
  const size = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(value.trim());
  return Boolean(size && Number.isFinite(Number(size[1])) && Number(size[1]) > 0);
}
