import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_MODELS = 10000;
const TIMEOUT_MS = 8000;

function systemEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|pathext|systemroot|windir|comspec)$/i.test(name)));
}

async function executableFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.basename(value).toLowerCase() !== 'codex.exe') return null;
  return await fs.stat(value).then(stat => stat.isFile() ? value : null, () => null);
}

async function locateExecutable(explicit, spawnImpl, signal) {
  if (explicit) return executableFile(explicit);
  const candidates = [process.env.CODEX_CLI_PATH, ...(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(path.isAbsolute).map(directory => path.join(directory, 'codex.exe'))];
  for (const candidate of candidates) {
    if (signal?.aborted) return null;
    const found = await executableFile(candidate);
    if (found) return found;
  }
  if (signal?.aborted) return null;
  let child;
  let closed;
  const located = await new Promise(resolve => {
    let output = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => { child?.kill(); finish(''); };
    const timer = setTimeout(abort, 2000);
    try {
      child = spawnImpl('where.exe', ['codex.exe'], { shell: false, windowsHide: true, env: systemEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
      closed = new Promise(done => { child.once('close', done); child.once('error', done); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        output += data.toString();
        if (output.length > 32768) abort();
      });
      child.once('error', () => finish(''));
      child.once('close', code => finish(code === 0 ? output : ''));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch { finish(''); }
  });
  if (child && closed) await closeChild(child, closed);
  for (const candidate of located.split(/\r?\n/)) {
    const found = await executableFile(candidate.trim());
    if (found) return found;
  }
  return null;
}

function catalogUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid endpoint');
  return url.href.replace(/\/+$/, '');
}

async function closeChild(child, closed) {
  try { child.stdin?.end(); } catch {}
  if (child.exitCode == null) { try { child.kill(); } catch {} }
  let timer;
  const wait = () => Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 500); })]).finally(() => clearTimeout(timer));
  await wait();
  if (child.exitCode == null) {
    try { child.kill('SIGKILL'); } catch {}
    await wait();
  }
  child.stdin?.destroy?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
}

// This reads Codex's picker catalog, which may contain bundled recommendations.
// An isolated home and credential-free environment keep it separate from user sessions.
export async function readCodexCatalog({ baseUrl, directory, signal, executablePath, spawnImpl = spawn }) {
  let home;
  let child;
  let closed;
  let timer;
  let cancel;
  try {
    if (signal?.aborted || !path.isAbsolute(directory)) return [];
    const endpoint = catalogUrl(baseUrl);
    const executable = await locateExecutable(executablePath, spawnImpl, signal);
    if (!executable || signal?.aborted) return [];
    const root = path.resolve(directory);
    await fs.mkdir(root, { recursive: true });
    home = await fs.mkdtemp(path.join(root, 'codex-models-'));
    if (signal?.aborted) return [];
    const args = ['app-server', '--stdio', '-c', 'analytics.enabled=false', '-c', 'cli_auth_credentials_store="file"',
      '-c', 'model_provider="custom"', '-c', 'model_providers.custom.name="custom"',
      '-c', `model_providers.custom.base_url=${JSON.stringify(endpoint)}`,
      '-c', 'model_providers.custom.wire_api="responses"', '-c', 'model_providers.custom.requires_openai_auth=true'];
    const env = { ...systemEnvironment(), CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, NO_COLOR: '1' };
    child = spawnImpl(executable, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let sequence = 0;
    let outputBytes = 0;
    let buffer = '';
    let failure;
    const fail = () => {
      failure ||= new Error('Codex catalog unavailable');
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
    };
    cancel = fail;
    closed = new Promise(resolve => {
      child.once('close', () => { fail(); resolve(); });
      child.once('error', () => { fail(); resolve(); });
    });
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stderr.on('data', data => { outputBytes += Buffer.byteLength(data); if (outputBytes > MAX_OUTPUT) fail(); });
    child.stdout.on('data', data => {
      if (failure) return;
      outputBytes += Buffer.byteLength(data);
      if (outputBytes > MAX_OUTPUT) { fail(); return; }
      buffer += data.toString();
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail(); return; }
        const request = pending.get(message?.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error || !Object.hasOwn(message, 'result')) { request.reject(new Error('Codex catalog unavailable')); continue; }
        request.resolve(message.result);
      }
    });
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    const request = (method, params) => new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      try { send({ id, method, params }); } catch { fail(); }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(cancel, TIMEOUT_MS);
    if (signal?.aborted) fail();
    await request('initialize', { clientInfo: { name: 'claude-workbench-catalog', version: '1.0.0' } });
    send({ method: 'initialized', params: {} });
    const models = new Map();
    const cursors = new Set();
    let cursor;
    let count = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!result || !Array.isArray(result.data)) throw new Error('Invalid catalog');
      count += result.data.length;
      if (count > MAX_MODELS) throw new Error('Catalog too large');
      for (const entry of result.data) {
        const id = entry?.model || entry?.id;
        if (typeof id !== 'string' || !id.trim() || id.length > 500 || /[\x00-\x1f\x7f]/.test(id)) continue;
        const cleanId = id.trim();
        const name = entry.displayName;
        const displayName = typeof name === 'string' && name.trim() && !/[\x00-\x1f\x7f]/.test(name) ? name.trim().slice(0, 500) : cleanId;
        if (!models.has(cleanId)) models.set(cleanId, { id: cleanId, displayName });
      }
      if (result.nextCursor == null || result.nextCursor === '') return [...models.values()];
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2000 || cursors.has(result.nextCursor)) throw new Error('Invalid pagination');
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    return [];
  } catch { return []; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (child && closed) await closeChild(child, closed);
    if (home && path.dirname(home) === path.resolve(directory)) await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
