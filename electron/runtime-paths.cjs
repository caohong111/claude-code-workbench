const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function existingFile(file, exists = fs.existsSync) {
  return typeof file === 'string' && path.isAbsolute(file) && exists(file);
}

function packageInfo(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function unpackedPath(file) {
  return file.replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2');
}

function isWorkbenchShortcut(shortcut, { appRoot, executablePath, isPackaged } = {}) {
  if (!shortcut || typeof shortcut.target !== 'string' || typeof shortcut.args !== 'string') return false;
  const normalize = value => path.resolve(value).toLowerCase();
  const target = normalize(shortcut.target);
  if (isPackaged) return target === normalize(executablePath);
  const args = (shortcut.args.match(/"[^"]*"|\S+/g) || []).map(value => value.replace(/^"|"$/g, ''));
  const pointsTo = file => args.some(value => path.isAbsolute(value) && normalize(value) === normalize(file));
  return target === normalize(executablePath) && pointsTo(appRoot)
    || path.basename(target) === 'wscript.exe' && pointsTo(path.join(appRoot, 'launch.vbs'));
}

function locateClaude({ environment = process.env, homeDirectory = os.homedir(), platform = process.platform, arch = process.arch, resolveModule = require.resolve, exists = fs.existsSync } = {}) {
  const executableName = platform === 'win32' ? 'claude.exe' : 'claude';
  const explicit = environment.CLAUDE_CODE_EXECUTABLE;
  if (explicit) {
    if (!existingFile(explicit, exists)) throw new Error('CLAUDE_CODE_EXECUTABLE 必须指向存在的 Claude Code 可执行文件。');
    return { executablePath: path.resolve(explicit), source: 'environment', claudeVersion: '' };
  }
  const search = [path.join(homeDirectory, '.local', 'bin', executableName)];
  const searchPath = environment.PATH || environment.Path || '';
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) search.push(path.join(directory.replace(/^"|"$/g, ''), executableName));
  const installed = search.find(file => existingFile(file, exists));
  if (installed) return { executablePath: path.resolve(installed), source: 'installed', claudeVersion: '' };
  try {
    const packageFile = resolveModule(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/package.json`);
    const bundled = path.join(path.dirname(packageFile), executableName);
    const executablePath = [unpackedPath(bundled), bundled].find(file => existingFile(file, exists));
    if (executablePath) {
      let claudeVersion = '';
      try {
        const sdk = packageInfo(path.join(path.dirname(resolveModule('@anthropic-ai/claude-agent-sdk')), 'package.json'));
        claudeVersion = sdk.claudeCodeVersion || '';
      } catch { /* Version metadata is optional; it is never required to run the binary. */ }
      return { executablePath, source: 'sdk', claudeVersion };
    }
  } catch { /* GPT channels can still run without a local Claude installation. */ }
  return { executablePath: null, source: 'missing', claudeVersion: '' };
}

function resolveRuntimePaths({ appRoot, environment = process.env, homeDirectory = os.homedir(), platform = process.platform, arch = process.arch, resolveModule = require.resolve, exists = fs.existsSync } = {}) {
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) throw new Error('Application root must be an absolute path.');
  const testMode = environment.CLAUDE_PANEL_TEST === '1';
  const localData = environment.LOCALAPPDATA || (platform === 'win32' ? path.join(homeDirectory, 'AppData', 'Local') : path.join(homeDirectory, '.local', 'share'));
  const runtimeHome = path.resolve(testMode && environment.CLAUDE_PANEL_DATA_DIR ? path.dirname(environment.CLAUDE_PANEL_DATA_DIR) : environment.CLAUDE_WORKBENCH_HOME || path.join(localData, 'ClaudeCodeWorkbench'));
  const dataRoot = path.resolve(environment.CLAUDE_PANEL_DATA_DIR || path.join(runtimeHome, 'data'));
  const configDirectory = path.resolve(testMode && environment.CLAUDE_PANEL_TEST_CONFIG_DIR ? environment.CLAUDE_PANEL_TEST_CONFIG_DIR : environment.CLAUDE_CONFIG_DIR || path.join(homeDirectory, '.claude'));
  return {
    appRoot: path.resolve(appRoot), homeDirectory: runtimeHome, dataRoot, configDirectory,
    tempDirectory: path.join(runtimeHome, 'temp'), cacheDirectory: path.join(runtimeHome, 'cache'),
    ...locateClaude({ environment, homeDirectory, platform, arch, resolveModule, exists }),
  };
}

module.exports = { isWorkbenchShortcut, locateClaude, resolveRuntimePaths };
