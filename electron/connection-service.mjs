import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fetchModelCatalog } from './model-catalog.mjs';
import { readCodexCatalog } from './codex-catalog.mjs';
import { claudeModelAliases, endpointIdentity, hasAutoCompactEnvironmentOverride, matchingCodexProvider, providerRequestKey } from './provider-config.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function providerMetadata(directory, configDirectory, request) {
  let db;
  try {
    const settings = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
    if (settings.claudeConfigDir && path.resolve(settings.claudeConfigDir).toLowerCase() !== path.resolve(configDirectory).toLowerCase()) return null;
    const live = JSON.parse(await fs.readFile(path.join(directory, 'live-state.json'), 'utf8'));
    if (live.apps?.claude?.mode && live.apps.claude.mode !== 'direct') return null;
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path.join(directory, 'cc-switch.db'), { readOnly: true });
    const row = settings.currentProviderClaude
      ? db.prepare("SELECT id, name, settings_config FROM providers WHERE app_type = 'claude' AND id = ?").get(settings.currentProviderClaude)
      : db.prepare("SELECT id, name, settings_config FROM providers WHERE app_type = 'claude' AND is_current = 1 LIMIT 1").get();
    if (!row) return null;
    const selected = JSON.parse(row.settings_config);
    if (endpointIdentity(selected.env?.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') !== endpointIdentity(request.baseUrl)) return null;
    let codexCatalog = null;
    if (!live.apps?.codex?.mode || live.apps.codex.mode === 'direct') {
      const codexRow = settings.currentProviderCodex
        ? db.prepare("SELECT id, settings_config FROM providers WHERE app_type = 'codex' AND id = ?").get(settings.currentProviderCodex)
        : db.prepare("SELECT id, settings_config FROM providers WHERE app_type = 'codex' AND is_current = 1 LIMIT 1").get();
      if (codexRow) {
        try {
          const match = matchingCodexProvider(JSON.parse(codexRow.settings_config), request);
          if (match) codexCatalog = { ...match, id: codexRow.id };
        } catch { /* A malformed Codex profile must not hide the Claude channel name. */ }
      }
    }
    return { id: row.id, name: row.name, codexCatalog };
  } catch { return null; }
  finally { db?.close(); }
}

export class ConnectionService {
  constructor({ configDirectory, packageFile, metadataDirectory = path.join(homedir(), '.cc-switch'), codexDirectory, environment = process.env, onChange = () => {}, onError = () => {}, fetchCatalog = fetchModelCatalog, fetchCodexCatalog = readCodexCatalog }) {
    Object.assign(this, { configDirectory, packageFile, metadataDirectory, codexDirectory, environment, onChange, onError, fetchCatalog, fetchCodexCatalog });
    this.connection = { baseUrl: '', hasCredential: false, configDirectory, claudeVersion: '', providerName: '', configuredModel: null, sourceId: '', claudeOptions: { fastMode: false, autoCompactWindow: null, autoCompactEnvironmentOverride: false, modelAutoCompactWindows: {}, modelAliases: {} }, catalog: { status: 'loading', models: [], error: null, sourceId: '' } };
    this.generation = 0;
    this.disposed = false;
  }

  async refresh(options = {}) {
    const task = (this.refreshTask || Promise.resolve()).catch(() => {}).then(() => this._refresh(options));
    this.refreshTask = task;
    let latest = task;
    let result = await latest;
    while (this.refreshTask !== latest) { latest = this.refreshTask; result = await latest; }
    return result;
  }

  async _refresh({ forceModels = false } = {}) {
    if (this.disposed) return this.connection;
    let settings = {};
    try { settings = JSON.parse(await fs.readFile(path.join(this.configDirectory, 'settings.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Claude settings.json 不是有效的 JSON，请在 CC Switch 中检查配置。'); }
    const env = { ...this.environment, ...Object.fromEntries(Object.entries(settings.env || {}).filter(([, value]) => typeof value === 'string')) };
    const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const request = { baseUrl, authToken: env.ANTHROPIC_AUTH_TOKEN, apiKey: env.ANTHROPIC_API_KEY };
    const metadata = await providerMetadata(this.metadataDirectory, this.configDirectory, request);
    let version = this.connection.claudeVersion;
    if (!version && this.packageFile) {
      try { version = JSON.parse(await fs.readFile(this.packageFile, 'utf8')).version; } catch {}
    }
    const credentialFile = await fs.access(path.join(this.configDirectory, '.credentials.json')).then(() => true, () => false);
    if (this.disposed) return this.connection;
    const sourceId = digest(`${endpointIdentity(baseUrl)}\0${metadata?.id || ''}`).slice(0, 24);
    const requestKey = providerRequestKey(env);
    const changed = sourceId !== this.connection.sourceId || requestKey !== this.requestKey;
    const codexChanged = metadata?.codexCatalog?.id !== this.codexCatalog?.id;
    let providerName;
    try { providerName = new URL(baseUrl).hostname; } catch { providerName = '当前渠道'; }
    const autoCompactWindow = settings.autoCompactWindow;
    const modelAutoCompactWindows = Object.fromEntries(Object.entries(settings.modelSettings || {}).filter(([key, value]) => /^claude-[\w.-]{1,100}$/.test(key) && (value?.autoCompactWindow === 'auto' || Number.isInteger(value?.autoCompactWindow) && value.autoCompactWindow >= 100000 && value.autoCompactWindow <= 1000000)).slice(0, 100).map(([key, value]) => [key, value.autoCompactWindow]));
    const next = {
      ...this.connection, baseUrl, sourceId, providerName: metadata?.name || providerName,
      hasCredential: Boolean(request.authToken || request.apiKey || credentialFile),
      configuredModel: [env.ANTHROPIC_MODEL, settings.model, env.ANTHROPIC_DEFAULT_MODEL].find(value => typeof value === 'string' && value.trim()) || null,
      claudeOptions: { fastMode: settings.fastMode === true, autoCompactWindow: Number.isInteger(autoCompactWindow) && autoCompactWindow >= 100000 && autoCompactWindow <= 1000000 ? autoCompactWindow : null,
        autoCompactEnvironmentOverride: hasAutoCompactEnvironmentOverride(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW), modelAutoCompactWindows, modelAliases: claudeModelAliases(env) },
      configDirectory: this.configDirectory, claudeVersion: version,
    };
    this.request = request;
    this.requestKey = requestKey;
    this.codexCatalog = metadata?.codexCatalog;
    const nextSignature = JSON.stringify({ ...next, catalog: undefined });
    const metadataChanged = nextSignature !== this.metadataSignature;
    this.metadataSignature = nextSignature;
    this.connection = next;
    if (changed || codexChanged || forceModels) this._loadModels({ providerChanged: changed });
    else if (metadataChanged) this.onChange(this.connection, { providerChanged: false });
    return this.connection;
  }

  _loadModels({ providerChanged }) {
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const generation = ++this.generation;
    const sourceId = this.connection.sourceId;
    const codexCatalog = this.codexCatalog;
    const oldModels = providerChanged ? [] : this.connection.catalog.models;
    this.connection = { ...this.connection, catalog: { status: 'loading', models: oldModels, error: null, sourceId, source: providerChanged ? 'channel' : this.connection.catalog.source } };
    this.onChange(this.connection, { providerChanged });
    this.catalogTask = this.fetchCatalog({ ...this.request, signal: controller.signal }).then(async models => {
      let source = 'channel';
      if (!models.length && codexCatalog && this.codexDirectory && !controller.signal.aborted) {
        try {
          const recommended = await this.fetchCodexCatalog({ baseUrl: codexCatalog.baseUrl, directory: this.codexDirectory, signal: controller.signal });
          if (recommended.length) { models = recommended; source = 'codex'; }
        } catch { /* Keep the channel's empty result if optional local discovery is unavailable. */ }
      }
      if (this.disposed || generation !== this.generation) return;
      this.connection = { ...this.connection, catalog: { status: 'ready', models, error: null, sourceId, source } };
      this.onChange(this.connection, { providerChanged: false });
    }).catch(error => {
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
      this.connection = { ...this.connection, catalog: { status: 'error', models: [], error: error.message, sourceId } };
      this.onChange(this.connection, { providerChanged: false });
    });
  }

  start() {
    const refresh = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.refresh().catch(this.onError), 180);
    };
    try { this.watcher = watch(this.configDirectory, (_event, name) => { if (!name || String(name) === 'settings.json') refresh(); }); }
    catch { /* Polling also covers atomic file replacements and unavailable watchers. */ }
    this.interval = setInterval(() => this.refresh().catch(this.onError), 2500);
    this.interval.unref?.();
  }

  stop() {
    this.disposed = true;
    clearTimeout(this.debounce);
    clearInterval(this.interval);
    this.watcher?.close();
    this.controller?.abort();
  }
}
