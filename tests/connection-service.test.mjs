import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { DatabaseSync } from 'node:sqlite';
import { ConnectionService } from '../electron/connection-service.mjs';

async function fixture(t, fetchCatalog) {
  const parent = TEST_ROOT;
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'connection-tests-'));
  const changes = [];
  const errors = [];
  const service = new ConnectionService({ configDirectory: directory, metadataDirectory: path.join(directory, 'no-ccswitch'), environment: {}, fetchCatalog, onChange: (value, event) => changes.push({ value, event }), onError: error => errors.push(error) });
  const write = (url, token = 'fixture-private-token', model) => fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token, ...(model ? { ANTHROPIC_MODEL: model } : {}) } }));
  t.after(async () => { service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, changes, errors, write };
}

test('publishes only safe connection metadata and caches the current channel catalog', async t => {
  let calls = 0;
  const f = await fixture(t, async request => { calls++; assert.equal(request.authToken, 'fixture-private-token'); return [{ id: 'gpt-fixture', displayName: 'GPT Fixture' }]; });
  await f.write('https://first.invalid', undefined, 'configured-fixture');
  await f.service.refresh(); await f.service.catalogTask;
  assert.equal(f.service.connection.providerName, 'first.invalid');
  assert.equal(f.service.connection.configuredModel, 'configured-fixture');
  assert.equal(f.service.connection.catalog.models[0].id, 'gpt-fixture');
  assert.equal(JSON.stringify(f.service.connection).includes('fixture-private-token'), false);
  await f.service.refresh();
  assert.equal(calls, 1);
});

test('refreshes real Claude command options without publishing settings or credentials', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return []; });
  assert.deepEqual(f.service.connection.claudeOptions, { fastMode: false, autoCompactWindow: null, autoCompactEnvironmentOverride: false, modelAutoCompactWindows: {}, modelAliases: {} });
  const settings = { fastMode: true, autoCompactWindow: 500000, privateSetting: 'fixture-unrelated-secret', modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 'auto' } }, env: {
    ANTHROPIC_BASE_URL: 'https://first.invalid', ANTHROPIC_AUTH_TOKEN: 'fixture-private-token', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '65', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
  } };
  await fs.writeFile(path.join(f.directory, 'settings.json'), JSON.stringify(settings));
  await f.service.refresh(); await f.service.catalogTask;
  assert.deepEqual(f.service.connection.claudeOptions, { fastMode: true, autoCompactWindow: 500000, autoCompactEnvironmentOverride: false, modelAutoCompactWindows: { 'claude-opus-5-5': 'auto' }, modelAliases: { opus: 'claude-opus-5-5' } });
  const beforeRefresh = f.changes.length;
  settings.fastMode = false;
  settings.autoCompactWindow = 300000;
  await fs.writeFile(path.join(f.directory, 'settings.json'), JSON.stringify(settings));
  await f.service.refresh();
  assert.deepEqual(f.service.connection.claudeOptions, { fastMode: false, autoCompactWindow: 300000, autoCompactEnvironmentOverride: false, modelAutoCompactWindows: { 'claude-opus-5-5': 'auto' }, modelAliases: { opus: 'claude-opus-5-5' } });
  assert.equal(f.changes.length, beforeRefresh + 1);
  assert.equal(calls, 1, 'Command settings changes must not reload the model catalog');
  for (const window of [99999, 1000001, 'invalid', 'Infinity', '']) {
    settings.autoCompactWindow = window;
    await fs.writeFile(path.join(f.directory, 'settings.json'), JSON.stringify(settings));
    await f.service.refresh();
    assert.equal(f.service.connection.claudeOptions.autoCompactWindow, null);
  }
  settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '500k';
  await fs.writeFile(path.join(f.directory, 'settings.json'), JSON.stringify(settings));
  await f.service.refresh();
  assert.equal(f.service.connection.claudeOptions.autoCompactEnvironmentOverride, true);
  settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = 'not-a-window';
  await fs.writeFile(path.join(f.directory, 'settings.json'), JSON.stringify(settings));
  await f.service.refresh();
  assert.equal(f.service.connection.claudeOptions.autoCompactEnvironmentOverride, false);
  assert.equal(JSON.stringify(f.changes).includes('fixture-private-token'), false);
  assert.equal(JSON.stringify(f.changes).includes('fixture-unrelated-secret'), false);
});

test('a channel switch clears old models and ignores a late response from the old channel', async t => {
  const pending = [];
  const f = await fixture(t, request => new Promise(resolve => pending.push({ request, resolve })));
  await f.write('https://first.invalid'); await f.service.refresh();
  const firstSource = f.service.connection.sourceId;
  await f.write('https://second.invalid'); await f.service.refresh();
  const secondTask = f.service.catalogTask;
  assert.notEqual(f.service.connection.sourceId, firstSource);
  assert.equal(pending[0].request.signal.aborted, true);
  assert.deepEqual(f.service.connection.catalog.models, []);
  pending[1].resolve([{ id: 'new-model', displayName: 'New model' }]); await secondTask;
  pending[0].resolve([{ id: 'old-model', displayName: 'Old model' }]); await Promise.resolve();
  assert.deepEqual(f.service.connection.catalog.models.map(model => model.id), ['new-model']);
  assert.equal(f.service.connection.catalog.sourceId, f.service.connection.sourceId);
});

test('credentials changing on the same endpoint reloads the catalog without exposing credentials', async t => {
  const requests = [];
  const f = await fixture(t, async request => { requests.push(request); return []; });
  await f.write('https://first.invalid', 'first-private-token'); await f.service.refresh(); await f.service.catalogTask;
  const source = f.service.connection.sourceId;
  await f.write('https://first.invalid', 'second-private-token'); await f.service.refresh(); await f.service.catalogTask;
  assert.equal(f.service.connection.sourceId, source);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].authToken, 'second-private-token');
  assert.equal(JSON.stringify(f.changes).includes('private-token'), false);
});

test('the config watcher follows atomic CC Switch file replacements', async t => {
  const f = await fixture(t, async request => [{ id: new URL(request.baseUrl).hostname, displayName: 'Fixture' }]);
  await f.write('https://first.invalid'); await f.service.refresh(); await f.service.catalogTask;
  f.service.start();
  const replacement = path.join(f.directory, 'settings.next');
  await fs.writeFile(replacement, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://second.invalid', ANTHROPIC_AUTH_TOKEN: 'new-fixture-token' } }));
  await fs.rename(replacement, path.join(f.directory, 'settings.json'));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && f.service.connection.catalog.models[0]?.id !== 'second.invalid') await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.service.connection.catalog.models[0]?.id, 'second.invalid');
  assert.equal(f.errors.length, 0);
});

test('overlapping refresh callers wait for the newest queued configuration', async t => {
  const f = await fixture(t, async () => []);
  const pending = [];
  f.service._refresh = () => new Promise(resolve => pending.push(resolve));
  const first = f.service.refresh();
  const second = f.service.refresh();
  while (!pending.length) await Promise.resolve();
  pending.shift()({ sourceId: 'old-source' });
  while (!pending.length) await Promise.resolve();
  pending.shift()({ sourceId: 'latest-source' });
  assert.equal((await first).sourceId, 'latest-source');
  assert.equal((await second).sourceId, 'latest-source');
});

async function matchingMetadata(f) {
  const directory = f.service.metadataDirectory;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ claudeConfigDir: f.directory, currentProviderClaude: 'claude-fixture', currentProviderCodex: 'codex-fixture' }));
  await fs.writeFile(path.join(directory, 'live-state.json'), JSON.stringify({ apps: { claude: { mode: 'direct' }, codex: { mode: 'direct' } } }));
  const db = new DatabaseSync(path.join(directory, 'cc-switch.db'));
  db.exec('CREATE TABLE providers (id TEXT, name TEXT, app_type TEXT, settings_config TEXT, is_current INTEGER)');
  const insert = db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, 1)');
  insert.run('claude-fixture', 'Company Claude', 'claude', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://first.invalid' } }));
  const codexSettings = token => JSON.stringify({ auth: { OPENAI_API_KEY: token }, config: 'model_provider = "company"\n[model_providers.company]\nbase_url = "https://first.invalid"\nwire_api = "responses"\n' });
  insert.run('codex-fixture', 'Company Codex', 'codex', codexSettings('fixture-private-token'));
  db.close();
  f.service.codexDirectory = path.join(f.directory, 'catalog-home');
  return token => {
    const database = new DatabaseSync(path.join(directory, 'cc-switch.db'));
    try { database.prepare('UPDATE providers SET settings_config = ? WHERE id = ?').run(codexSettings(token), 'codex-fixture'); }
    finally { database.close(); }
  };
}

test('uses labeled Codex recommendations only for an empty, matching active channel', async t => {
  const f = await fixture(t, async () => []);
  await f.write('https://first.invalid');
  const changeCodexCredential = await matchingMetadata(f);
  let calls = 0;
  f.service.fetchCodexCatalog = async options => {
    calls++;
    assert.equal(options.baseUrl, 'https://first.invalid');
    assert.equal('authToken' in options, false);
    assert.equal('apiKey' in options, false);
    return [{ id: 'gpt-recommended', displayName: 'GPT Recommended' }];
  };
  await f.service.refresh(); await f.service.catalogTask;
  assert.equal(f.service.connection.catalog.source, 'codex');
  assert.equal(f.service.connection.catalog.models[0].id, 'gpt-recommended');
  assert.equal(JSON.stringify(f.service.connection).includes('fixture-private-token'), false);
  changeCodexCredential('different-private-token');
  await f.service.refresh(); await f.service.catalogTask;
  assert.equal(f.service.connection.catalog.source, 'channel');
  assert.deepEqual(f.service.connection.catalog.models, []);
  assert.equal(calls, 1);
});

test('a nonempty channel catalog takes precedence over Codex recommendations', async t => {
  const f = await fixture(t, async () => [{ id: 'channel-model', displayName: 'Channel Model' }]);
  await f.write('https://first.invalid');
  await matchingMetadata(f);
  f.service.fetchCodexCatalog = async () => { assert.fail('The channel already provides its inventory'); };
  await f.service.refresh(); await f.service.catalogTask;
  assert.equal(f.service.connection.catalog.source, 'channel');
  assert.equal(f.service.connection.catalog.models[0].id, 'channel-model');
});
