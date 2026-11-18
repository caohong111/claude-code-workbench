import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalClaudeModel, claudeModelAliases, hasAutoCompactEnvironmentOverride, matchingCodexProvider } from '../electron/provider-config.mjs';

const request = { baseUrl: 'https://channel.invalid', authToken: 'fixture-private-token' };
const profile = (config = '') => ({
  auth: { OPENAI_API_KEY: 'fixture-private-token' },
  config: `model_provider = "company"
${config}
[model_providers.company]
base_url = "https://channel.invalid/"
wire_api = "responses"
`,
});

test('matches the actual TOML provider and credentials without returning secrets', () => {
  const matched = matchingCodexProvider(profile(), request);
  assert.deepEqual(matched, { baseUrl: 'https://channel.invalid/' });
  assert.equal(JSON.stringify(matched).includes('fixture-private-token'), false);
});

test('does not borrow recommendations from a different credential, endpoint or protocol', () => {
  assert.equal(matchingCodexProvider(profile(), { ...request, authToken: 'fixture-other-private-token' }), null);
  assert.equal(matchingCodexProvider(profile(), { ...request, baseUrl: 'https://other.invalid' }), null);
  assert.equal(matchingCodexProvider({ ...profile(), config: profile().config.replace('responses', 'chat') }, request), null);
  assert.equal(matchingCodexProvider(profile(), { baseUrl: request.baseUrl }), null);
});

test('does not substitute the bundled directory for an explicit custom Codex catalog', () => {
  assert.equal(matchingCodexProvider(profile('model_catalog_json = "D:/models.json"'), request), null);
  assert.equal(matchingCodexProvider({ ...profile(), config: 'invalid TOML' }, request), null);
});

test('canonicalizes configured Claude aliases without guessing account defaults', () => {
  const aliases = claudeModelAliases({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1-20250805[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider-deployment', ANTHROPIC_AUTH_TOKEN: 'fixture-private-token' });
  assert.deepEqual(aliases, { opus: 'claude-opus-4-1' });
  assert.equal(canonicalClaudeModel('opus[1m]', aliases), 'claude-opus-4-1');
  assert.equal(canonicalClaudeModel('claude-sonnet-5-5[1m]'), 'claude-sonnet-5-5');
  for (const value of ['default', 'sonnet', 'gpt-fixture', '__proto__', '../claude-opus', 'claude-opus\n', '', null]) assert.equal(canonicalClaudeModel(value, aliases), null);
});

test('only usable auto-compact environment sizes block a saved setting', () => {
  for (const value of ['200000', '500k', '1M', '200', '2000000']) assert.equal(hasAutoCompactEnvironmentOverride(value), true, value);
  for (const value of [undefined, null, '', 'auto', 'not-a-window', '-200', 'Infinity', 500000]) assert.equal(hasAutoCompactEnvironmentOverride(value), false, String(value));
});
