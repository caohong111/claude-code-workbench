import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

const SOURCE_DIRECTORIES = new Set(['src', 'electron', 'shared', 'docs', 'tests', 'tools', 'assets', 'build', '.github']);
const ROOT_FILES = new Set(['package.json', 'package-lock.json', 'themes.json', 'index.html', 'vite.config.js', '.npmrc', '.gitignore', '.gitattributes', '.gitleaks.toml', 'README.md', 'LICENSE', 'LICENSE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'AGENTS.md', 'install.ps1', 'launch.vbs']);
const DEFAULT_ASSETS = new Set(['app-icon.png', 'app-icon.ico', 'assistant-avatar.png', 'user-avatar.png']);
const DEVELOPMENT_OUTPUT = new Set(['.git', 'node_modules', 'dist', 'release', '.cache']);
const FORBIDDEN_DIRECTORIES = new Set(['config', 'data', 'local-data', 'cache', 'output', 'qa', 'temp', 'runtime', 'node_modules', 'test-results', 'playwright-report', '.tmp', '.claude', '.codex', '.cc-switch']);
const TEXT_EXTENSION = /\.(?:[cm]?js|jsx|tsx?|json|md|txt|html|css|svg|ya?ml|ps1|vbs|cmd|bat|toml|nsh)$/i;
const SECRET_FORMATS = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
];
const CREDENTIAL_ASSIGNMENT = /(?<![\w-])["']?(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|api[_-]?key|auth[_-]?token|access[_-]?token|password|secret|credential|token)["']?\s*[:=]\s*(["'`])([^"'`\r\n]{8,})\1/gi;
const PLACEHOLDER = /(?:fixture|dummy|example|placeholder|your[_ -]?(?:api|key|token|secret)|replace[_ -]?me|已隐藏|REDACTED|^test[-_])/i;
const RESERVED_HOST = /(?:^localhost$|^127\.0\.0\.1$|(?:^|\.)example\.(?:com|org|net)$|\.(?:invalid|example)$)/i;
const normalize = value => String(value).replaceAll('\\', '/').replace(/^\/+/, '');
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const dynamicReference = value => /^\$\{[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\}$/.test(value);
const UPDATE_CONFIGURATION = { owner: 'caohong111', repo: 'claude-code-workbench', provider: 'github', updaterCacheDirName: 'claude-code-workbench-updater' };
// Re-review this official Electron 45.3.3 default application hash when upgrading Electron.
const ELECTRON_DEFAULT_APP_SHA256 = 'eac55d6cfcf4eab7e31a45356567f549ef7eb669e3699226b48a8492ad34f510';

export function pathProblem(file, { artifact = false } = {}) {
  const parts = normalize(file).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return 'unsafe-path';
  if (!artifact && normalize(file).startsWith('build/third-party-licenses/')) return 'generated-license-output';
  if (artifact && parts[0] === 'node_modules') return null;
  if (parts.some(part => FORBIDDEN_DIRECTORIES.has(part.toLowerCase()))) return 'private-directory';
  const name = parts.at(-1).toLowerCase();
  if (/^(?:\.env(?:\..+)?|\.credentials\.json|\.claude\.json|auth\.json|settings\.json|cc-switch\.db|workspaces?\.json|workspace-state\.json|history\.json|sessions?\.json)$/.test(name) && !/\.example$/.test(name)) return 'private-configuration';
  if (/\.(?:pem|key|pfx|p12|sqlite3?|db|log|bak|backup|jsonl)$/i.test(name)) return 'private-file-type';
  if (/^live-.*\.(?:mjs|cjs|js)$/.test(name) && parts[0] === 'tests') return 'live-credential-test';
  if (artifact) {
    if (!['electron', 'shared', 'dist', 'assets'].includes(parts[0]) && !['package.json', 'themes.json', 'LICENSE', 'LICENSE.md', 'THIRD_PARTY_NOTICES.md'].includes(parts.join('/'))) return 'unexpected-package-file';
  } else {
    if (parts.length === 1 && !ROOT_FILES.has(parts[0])) return 'not-in-source-allowlist';
    if (parts.length > 1 && !SOURCE_DIRECTORIES.has(parts[0])) return 'not-in-source-allowlist';
    if (parts[0] === 'assets' && (parts.length !== 2 || !DEFAULT_ASSETS.has(parts[1]))) return 'unreviewed-default-asset';
  }
  return null;
}

export function scanText(file, text, { secretValues = [], privateMarkers = [] } = {}) {
  const problems = [];
  const seen = new Set();
  const add = (rule, index) => {
    const line = lineAt(text, index);
    const id = `${rule}:${line}`;
    if (!seen.has(id)) { seen.add(id); problems.push({ file, line, rule }); }
  };
  for (const pattern of SECRET_FORMATS) for (const match of text.matchAll(pattern)) if (!PLACEHOLDER.test(match[0])) add('secret-format', match.index);
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
    const value = match[2];
    if (!PLACEHOLDER.test(value) && !/^\[[^\]]+\]$/.test(value) && !dynamicReference(value)) add('literal-credential-assignment', match.index);
  }
  for (const match of text.matchAll(/[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/gi)) {
    if (!/[<>{}\[\]]|(?:example|fixture|username|your[-_]?user)/i.test(match[0])) add('personal-home-path', match.index);
  }
  for (const marker of [...secretValues, ...privateMarkers, homedir()].filter(value => typeof value === 'string' && value.length >= 6)) {
    const index = text.toLowerCase().indexOf(marker.toLowerCase());
    if (index !== -1) add(secretValues.includes(marker) ? 'known-private-secret' : 'known-private-marker', index);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`]+/gi)) {
    let url;
    try { url = new URL(match[0].replace(/[),.;]+$/, '')); } catch { continue; }
    if (RESERVED_HOST.test(url.hostname)) continue;
    const userInfo = decodeURIComponent(url.password || url.username);
    if (userInfo && !dynamicReference(userInfo) && !PLACEHOLDER.test(userInfo)) add('url-credentials', match.index);
    for (const [key, value] of url.searchParams) if (/token|secret|password|api.?key|authorization|credential|signature/i.test(key) && value && !PLACEHOLDER.test(value) && !dynamicReference(value)) add('url-credentials', match.index);
  }
  return problems;
}

async function walk(root, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = normalize(path.join(prefix, entry.name));
    if (!prefix && DEVELOPMENT_OUTPUT.has(entry.name)) continue;
    if (relative === 'build/third-party-licenses') continue;
    if (entry.isDirectory()) {
      const directoryProblem = relative.split('/').some(part => FORBIDDEN_DIRECTORIES.has(part.toLowerCase()));
      if (directoryProblem) result.push(`${relative}/__directory__`);
      else if (!prefix && !SOURCE_DIRECTORIES.has(entry.name)) result.push(`${relative}/__directory__`);
      else result.push(...await walk(root, relative));
    } else result.push(relative);
  }
  return result;
}

async function sourceCandidates(root) {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (path.resolve(gitRoot).toLowerCase() === root.toLowerCase()) {
      return { source: 'git-candidates', files: [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean))] };
    }
  } catch { /* A source archive has no Git metadata; inspect the explicit source allowlist. */ }
  return { source: 'source-allowlist', files: await walk(root) };
}

const isText = file => TEXT_EXTENSION.test(file) || ['LICENSE', '.npmrc', '.gitignore', '.gitattributes'].includes(path.basename(file));

function isWindowsIcon(bytes) {
  if (bytes.length < 22 || bytes.length > 4 * 1024 * 1024 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return false;
  const count = bytes.readUInt16LE(4);
  if (!count || count > 64 || 6 + count * 16 > bytes.length) return false;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (size < 24 || offset < 6 + count * 16 || offset + size > bytes.length) return false;
    const frame = bytes.subarray(offset, offset + size);
    const width = bytes[entry] || 256;
    const height = bytes[entry + 1] || 256;
    const png = frame.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (png) {
      if (frame.toString('ascii', 12, 16) !== 'IHDR' || frame.readUInt32BE(16) !== width || frame.readUInt32BE(20) !== height) return false;
    } else if (frame.length < 40 || ![40, 108, 124].includes(frame.readUInt32LE(0)) || frame.readInt32LE(4) !== width || Math.abs(frame.readInt32LE(8)) !== height * 2) return false;
  }
  return true;
}

function isUpdateConfiguration(text) {
  try {
    const document = YAML.parseDocument(text, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) return false;
    const configuration = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
    return configuration instanceof Map && configuration.size === Object.keys(UPDATE_CONFIGURATION).length
      && [...configuration].every(([key, value]) => Object.hasOwn(UPDATE_CONFIGURATION, key) && UPDATE_CONFIGURATION[key] === value);
  } catch { return false; }
}

export async function auditRelease({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), candidates, secretValues = [], privateMarkers = [] } = {}) {
  root = path.resolve(root);
  const selection = candidates ? { source: 'explicit-candidates', files: candidates } : await sourceCandidates(root);
  const problems = [];
  let filesAudited = 0;
  for (const candidate of selection.files.sort()) {
    const file = normalize(candidate);
    const rule = pathProblem(file);
    if (rule) { problems.push({ file, rule }); continue; }
    const absolute = path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { problems.push({ file, rule: 'unsafe-path' }); continue; }
    let stat;
    try { stat = await fs.lstat(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) { problems.push({ file, rule: 'non-regular-source-file' }); continue; }
    filesAudited++;
    if (!isText(file)) continue;
    if (stat.size > 5 * 1024 * 1024) { problems.push({ file, rule: 'oversized-source-text' }); continue; }
    problems.push(...scanText(file, await fs.readFile(absolute, 'utf8'), { secretValues, privateMarkers }));
  }
  return { ok: problems.length === 0, source: selection.source, filesAudited, problems };
}

export async function auditArtifact(artifact, { secretValues = [], privateMarkers = [], asarApi } = {}) {
  artifact = path.resolve(artifact);
  if (!artifact.endsWith('.asar')) {
    const archive = path.join(artifact, 'resources', 'app.asar');
    try { await fs.access(archive); }
    catch { throw new Error('Pass an app.asar file or an Electron unpacked application directory containing resources/app.asar.'); }
    const result = await auditArtifact(archive, { secretValues, privateMarkers, asarApi });
    for (const name of await fs.readdir(path.dirname(archive))) {
      if (name === 'app-update.yml') {
        const configuration = path.join(path.dirname(archive), name);
        const stat = await fs.lstat(configuration);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size >= 16 * 1024 || !isUpdateConfiguration(await fs.readFile(configuration, 'utf8'))) result.problems.push({ file: 'resources/app-update.yml', rule: 'unexpected-update-configuration' });
        else result.updateConfigurationChecked = true;
      } else if (name === 'default_app.asar') {
        const defaultApp = path.join(path.dirname(archive), name);
        const stat = await fs.lstat(defaultApp);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 || createHash('sha256').update(await fs.readFile(defaultApp)).digest('hex') !== ELECTRON_DEFAULT_APP_SHA256) result.problems.push({ file: 'resources/default_app.asar', rule: 'unreviewed-electron-default-app' });
        else result.officialElectronDefaultAppChecked = true;
      } else if (name === 'app-icon.ico') {
        const icon = path.join(path.dirname(archive), name);
        const stat = await fs.lstat(icon);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || !isWindowsIcon(await fs.readFile(icon))) result.problems.push({ file: 'resources/app-icon.ico', rule: 'invalid-native-icon-resource' });
        else result.nativeIconResourceChecked = true;
      } else if (name === 'licenses') {
        const directory = path.join(path.dirname(archive), name);
        result.resourceLicenseFilesChecked = 0;
        const inspectLicenseEntry = async (relative, depth) => {
          const absolute = path.join(directory, relative);
          const stat = await fs.lstat(absolute);
          const file = `resources/licenses/${normalize(relative)}`;
          if (stat.isSymbolicLink()) { result.problems.push({ file, rule: 'non-regular-license-resource' }); return; }
          if (depth === 0 && stat.isDirectory() && /^[A-Za-z0-9_.-]+-\d[A-Za-z0-9_.+-]*$/.test(relative)) {
            for (const child of await fs.readdir(absolute)) await inspectLicenseEntry(path.join(relative, child), 1);
          } else if (stat.isFile() && (depth === 0 && relative === 'manifest.json' || depth === 1 && /^(?:(?:licen[cs]e|notice|copying)(?:[.-][A-Za-z0-9_.-]+)?|README\.md)$/i.test(path.basename(relative)))) result.resourceLicenseFilesChecked++;
          else result.problems.push({ file, rule: 'unexpected-license-resource' });
        };
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) result.problems.push({ file: 'resources/licenses', rule: 'non-regular-license-resource' });
        else for (const child of await fs.readdir(directory)) await inspectLicenseEntry(child, 0);
      } else if (!['app.asar', 'app.asar.unpacked', 'elevate.exe'].includes(name)) result.problems.push({ file: `resources/${name}`, rule: 'unexpected-package-resource' });
    }
    result.ok = result.problems.length === 0;
    return result;
  }
  const api = asarApi || await import('@electron/asar');
  const problems = [];
  let filesAudited = 0;
  let dependencyEntriesExcluded = 0;
  for (const entry of await api.listPackage(artifact)) {
    const file = normalize(entry);
    if (!file) continue;
    const nativeFile = path.normalize(file);
    const stat = await api.statFile(artifact, nativeFile, false);
    if (stat.files) continue;
    if (file.startsWith('node_modules/')) { dependencyEntriesExcluded++; continue; }
    const rule = pathProblem(file, { artifact: true });
    if (rule) { problems.push({ file, rule }); continue; }
    if (stat.link) { problems.push({ file, rule: 'non-regular-package-file' }); continue; }
    filesAudited++;
    if (!isText(file)) continue;
    if (stat.size > 5 * 1024 * 1024) { problems.push({ file, rule: 'oversized-package-text' }); continue; }
    problems.push(...scanText(file, (await api.extractFile(artifact, nativeFile, false)).toString('utf8'), { secretValues, privateMarkers }));
  }
  return { ok: problems.length === 0, source: 'application-artifact', filesAudited, dependencyEntriesExcluded, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const artifactIndex = args.indexOf('--artifact');
  const environmentIndex = args.indexOf('--private-markers-env');
  let privateMarkers = [];
  if (environmentIndex !== -1) {
    try { privateMarkers = JSON.parse(process.env[args[environmentIndex + 1]] || '[]'); }
    catch { throw new Error('Private markers environment variable must contain a JSON array.'); }
    if (!Array.isArray(privateMarkers)) throw new Error('Private markers must be a JSON array.');
  }
  const result = artifactIndex === -1 ? await auditRelease({ privateMarkers }) : await auditArtifact(args[artifactIndex + 1], { privateMarkers });
  console.log(JSON.stringify({ ...result, limitation: 'Checks application-owned candidate files for known patterns. Dependency contents and image privacy require separate review; this is not a guarantee that every secret format can be detected.' }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
