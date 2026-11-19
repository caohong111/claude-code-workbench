import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { glob } from 'glob';
import { resolveWorkspacePath, readTextFile } from './workspace.mjs';

const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 160000;
const MAX_MATCHES = 500;
const IGNORE = ['**/.git/**', '**/node_modules/**', '**/.venv/**', '**/__pycache__/**'];
const MUTATIONS = new Set(['Write', 'Edit', 'Bash']);
const string = description => ({ type: 'string', description });
const integer = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const definition = (name, description, properties, required = []) => ({ type: 'function', name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false }, strict: false });

const DEFINITIONS = [
  definition('Read', 'Read a UTF-8 text file in the opened workspace. Output contains line numbers. Large and binary files are bounded or rejected.', {
    file_path: string('Absolute path or path relative to the workspace.'), offset: integer('First line, starting at 1.', 1, 10000000), limit: integer('Maximum lines to return.', 1, 4000),
  }, ['file_path']),
  definition('Glob', 'Find files and directories by glob within the workspace. Returns workspace-relative paths, including directories with a trailing slash. Dependencies and Git internals are excluded.', {
    pattern: string('Relative glob, for example **/*.js. Defaults to **/*.'), path: string('Optional directory relative to the workspace.'),
  }),
  definition('Grep', 'Search literal text, case-insensitively, in text files within the workspace. Returns matching paths, line numbers and text. Dependencies and Git internals are excluded.', {
    pattern: string('Literal text to search for; this is not a regular expression.'), path: string('Optional file or directory within the workspace.'), max_results: integer('Maximum matching lines.', 1, MAX_MATCHES),
  }, ['pattern']),
  definition('Write', 'Create or replace a UTF-8 text file within the workspace. Requires user confirmation in manual mode. Read existing files before overwriting them.', {
    file_path: string('File path within the workspace.'), content: string('Complete replacement contents, up to 1 MiB.'),
  }, ['file_path', 'content']),
  definition('Edit', 'Replace exact text in an existing UTF-8 workspace file. A unique match is required unless replace_all is true. Requires user confirmation in manual mode.', {
    file_path: string('File path within the workspace.'), old_string: string('Exact nonempty text to replace.'), new_string: string('Replacement text.'), replace_all: { type: 'boolean', description: 'Replace every exact match.' },
  }, ['file_path', 'old_string', 'new_string']),
  definition('Bash', 'Execute a PowerShell command with the workspace as its working directory. Always requires user confirmation. This is Windows PowerShell, not a Unix shell. Output and execution time are bounded.', {
    command: string('PowerShell command.'), timeout_ms: integer('Maximum duration in milliseconds; defaults to 60000.', 1000, 120000),
  }, ['command']),
  definition('AskUserQuestion', 'Ask the user to choose or provide information using the workbench question dialog.', {
    questions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: {
      question: string('Complete question.'), header: string('Short heading.'), multiSelect: { type: 'boolean' },
      options: { type: 'array', maxItems: 8, items: { type: 'object', properties: { label: string('Option label.'), description: string('Option details.') }, required: ['label'], additionalProperties: false } },
    }, required: ['question'], additionalProperties: false } },
  }, ['questions']),
];

function abortCheck(signal) { if (signal?.aborted) throw new Error('任务已停止。'); }
function text(value, label, { empty = false, max = MAX_FILE } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || Buffer.byteLength(value) > max) throw new Error(`${label}无效或过长。`);
  return value;
}
function number(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('数值超出允许范围。');
  return value;
}
function cleanValue(value, redact) {
  if (typeof value === 'string') return boundedText(redact(value));
  if (Array.isArray(value)) return value.map(item => cleanValue(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanValue(item, redact)]));
  return value;
}

function boundedText(value) {
  const marker = '\n[输出已截断]';
  return value.length > MAX_OUTPUT ? value.slice(0, MAX_OUTPUT - marker.length) + marker : value;
}
async function fileStamp(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('目标不是普通文件。');
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function assertUnchanged(file, originalStamp) {
  if (await fileStamp(file) !== originalStamp) throw new Error('文件在确认期间发生变化，请重新读取后再修改。');
}

async function atomicWrite(file, content, signal, originalStamp) {
  abortCheck(signal);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const mode = await fs.stat(file).then(stat => {
    if (!stat.isFile()) throw new Error('目标不是普通文件。');
    return stat.mode;
  }, error => { if (error.code !== 'ENOENT') throw error; return 0o666; });
  const temporary = path.join(path.dirname(file), `.claude-write-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode, signal });
    abortCheck(signal);
    await assertUnchanged(file, originalStamp);
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function matchingPaths(cwd, directory, pattern, signal) {
  text(pattern, '匹配模式', { max: 1000 });
  if (path.isAbsolute(pattern) || pattern.includes('..') || pattern.includes(':') || pattern.startsWith('!')) throw new Error('匹配模式必须位于当前工作文件夹中。');
  abortCheck(signal);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 4000);
  try {
    const matches = await glob(pattern.replaceAll('\\', '/'), { cwd: directory, dot: true, nodir: false,
      follow: false, maxDepth: 12, ignore: IGNORE, signal: controller.signal });
    const results = [];
    for (const candidate of matches.sort().slice(0, 3000)) {
      abortCheck(signal);
      try {
        const target = await resolveWorkspacePath(cwd, path.join(directory, candidate));
        const stat = await fs.stat(target);
        if (stat.isFile() || stat.isDirectory()) results.push({ path: target, isDirectory: stat.isDirectory() });
      } catch { /* Links that resolve outside the workspace are excluded. */ }
    }
    return { entries: results, truncated: matches.length > 3000 };
  } catch (error) {
    abortCheck(signal);
    if (controller.signal.aborted) throw new Error('文件搜索超时，请缩小目录或匹配模式。');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

async function runPowerShell(command, cwd, timeout, signal) {
  abortCheck(signal);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api.?key|credential|^CODEX_|^CLAUDE|^ANTHROPIC_|^OPENAI_/i.test(key)));
  return new Promise((resolve, reject) => {
    const script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding; ' + command;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let termination;
    let closed = false;
    function collect(chunk) {
      const addition = chunk.toString('utf8');
      if (output.length + addition.length > MAX_OUTPUT) outputTruncated = true;
      output = (output + addition).slice(0, MAX_OUTPUT);
    }
    function terminate() {
      if (termination || closed) return;
      if (process.platform === 'win32' && child.pid) {
        termination = new Promise(done => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          const finished = code => { if (code !== 0 && !closed) child.kill(); done(); };
          killer.once('close', finished); killer.once('error', () => finished(-1));
        });
      } else { child.kill('SIGKILL'); termination = Promise.resolve(); }
    }
    const onAbort = () => { cancelled = true; terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new Error(`无法执行 PowerShell：${error.code || '启动失败'}`)); });
    child.once('close', async code => {
      closed = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (termination) await termination;
      const suffix = cancelled ? '\n任务已停止。' : timedOut ? '\n命令超时，已终止。' : `\n退出代码：${code}`;
      resolve({ output: output + (outputTruncated ? '\n[输出已截断]' : '') + suffix, isError: cancelled || timedOut || code !== 0 });
    });
    if (signal?.aborted) onAbort();
  });
}

export function createWorkspaceTools({ cwd, permissionMode = 'manual', signal, requestPermission = async () => ({ behavior: 'deny' }), onEvent = async () => {}, redact = value => value }) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('请选择有效工作文件夹。');
  if (!['manual', 'acceptEdits', 'auto', 'plan'].includes(permissionMode)) throw new Error('无效的权限模式。');
  const emit = value => onEvent(cleanValue(value, redact));
  const definitions = DEFINITIONS.filter(tool => permissionMode !== 'plan' || !MUTATIONS.has(tool.name));

  async function perform(name, args, toolUseId) {
    abortCheck(signal);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象。');
    const root = await fs.realpath(cwd);
    if (permissionMode === 'plan' && MUTATIONS.has(name)) throw new Error('计划模式只允许读取和分析，不能修改文件或执行命令。');
    if (name === 'Read') {
      const file = await resolveWorkspacePath(root, text(args.file_path, '文件路径', { max: 32768 }));
      const offset = number(args.offset, 1, 1, 10000000);
      const limit = number(args.limit, 2000, 1, 4000);
      const data = await readTextFile(root, file, MAX_FILE);
      if (data.binary) throw new Error('该文件是二进制文件，不能作为文本读取。');
      const lines = data.content.split('\n');
      const content = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`).join('\n');
      return { output: content + (data.truncated || offset - 1 + limit < lines.length ? '\n[文件内容已截断，可调整 offset/limit 继续读取]' : ''), isError: false };
    }
    if (name === 'Glob' || name === 'Grep') {
      const directory = await resolveWorkspacePath(root, args.path === undefined ? '' : text(args.path, '搜索路径', { empty: true, max: 32768 }));
      const stat = await fs.stat(directory);
      if (name === 'Glob' && !stat.isDirectory()) throw new Error('Glob 搜索路径必须是文件夹。');
      const matches = stat.isFile() ? { entries: [{ path: directory, isDirectory: false }], truncated: false }
        : await matchingPaths(root, directory, name === 'Glob' ? args.pattern || '**/*' : '**/*', signal);
      if (name === 'Glob') return { output: matches.entries.slice(0, MAX_MATCHES).map(entry => path.relative(root, entry.path).split(path.sep).join('/') + (entry.isDirectory ? '/' : '')).join('\n')
        + (matches.truncated || matches.entries.length > MAX_MATCHES ? '\n[匹配结果已截断，请缩小范围]' : '') || '没有匹配的文件。', isError: false };
      const needle = text(args.pattern, '搜索文本', { max: 1000 }).toLocaleLowerCase();
      const limit = number(args.max_results, 100, 1, MAX_MATCHES);
      const results = [];
      let visited = 0;
      let truncated = matches.truncated;
      for (const entry of matches.entries) {
        abortCheck(signal);
        if (entry.isDirectory) continue;
        if (++visited > 1000) { truncated = true; break; }
        let data;
        try { data = await readTextFile(root, entry.path, 256 * 1024); } catch { continue; }
        if (data.binary) continue;
        if (data.truncated) truncated = true;
        const lines = data.content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].toLocaleLowerCase().includes(needle)) continue;
          results.push(`${path.relative(root, entry.path).split(path.sep).join('/')}:${index + 1}: ${lines[index].slice(0, 1500)}`);
          if (results.length >= limit) break;
        }
        if (results.length >= limit) { truncated = true; break; }
      }
      return { output: (results.join('\n') || '没有匹配的文本。') + (truncated ? '\n[搜索结果或文件内容已截断，请缩小范围]' : ''), isError: false };
    }
    if (name === 'Write' || name === 'Edit') {
      const file = await resolveWorkspacePath(root, text(args.file_path, '文件路径', { max: 32768 }), { allowMissing: name === 'Write' });
      const originalStamp = await fileStamp(file);
      let content;
      if (name === 'Write') content = text(args.content, '文件内容', { empty: true });
      else {
        const data = await readTextFile(root, file, MAX_FILE);
        if (data.binary || data.truncated) throw new Error('仅可编辑不超过 1 MiB 的文本文件。');
        const previous = text(args.old_string, '原文本');
        const replacement = text(args.new_string, '替换文本', { empty: true });
        const parts = data.content.split(previous);
        if (parts.length === 1) throw new Error('未找到原文本，文件未修改。');
        if (parts.length > 2 && args.replace_all !== true) throw new Error('原文本出现多次，请提供更完整的唯一文本或启用 replace_all。');
        content = args.replace_all === true ? parts.join(replacement) : data.content.replace(previous, () => replacement);
        text(content, '更新后的文件内容', { empty: true });
      }
      if (permissionMode === 'manual') {
        const decision = await requestPermission({ toolName: name, input: { ...args, file_path: file }, reason: '确认后修改当前工作文件夹中的文件。' });
        if (decision?.behavior !== 'allow') throw new Error('用户拒绝了文件修改。');
      }
      abortCheck(signal);
      await resolveWorkspacePath(root, file, { allowMissing: name === 'Write' });
      await assertUnchanged(file, originalStamp);
      await emit({ type: 'beforeTool', toolName: name, input: { ...args, file_path: file }, toolUseId });
      await atomicWrite(file, content, signal, originalStamp);
      return { output: `已${name === 'Write' ? '写入' : '编辑'} ${path.relative(root, file).split(path.sep).join('/')} (${Buffer.byteLength(content)} bytes)。`, isError: false };
    }
    if (name === 'Bash') {
      const command = text(args.command, '命令', { max: 50000 });
      const timeout = number(args.timeout_ms, 60000, 1000, 120000);
      const decision = await requestPermission({ toolName: 'Bash', input: { command, cwd: root }, reason: permissionMode === 'acceptEdits'
        ? '自动接受编辑已允许当前工作文件夹的文件修改；此操作是 PowerShell 命令，仍需确认。读取和编辑工作区文件可直接使用 Read、Glob、Grep、Write、Edit。'
        : '此命令将使用 PowerShell 执行，请确认命令及其影响。读取工作区文件可直接使用 Read、Glob、Grep。' });
      if (decision?.behavior !== 'allow') throw new Error('用户拒绝了命令执行。');
      return runPowerShell(command, root, timeout, signal);
    }
    if (name === 'AskUserQuestion') {
      if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 4) throw new Error('问题数量必须为 1 到 4 个。');
      for (const question of args.questions) {
        text(question?.question, '问题', { max: 4000 });
        if (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > 8)) throw new Error('问题选项无效。');
        for (const option of question.options || []) text(option?.label, '选项', { max: 200 });
      }
      const decision = await requestPermission({ toolName: 'AskUserQuestion', input: { questions: args.questions }, reason: '请回答后继续。' });
      if (decision?.behavior !== 'allow') throw new Error('用户取消了问题。');
      const answers = decision.updatedInput?.answers;
      if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) throw new Error('没有收到用户回答。');
      return { output: JSON.stringify(answers), isError: false };
    }
    throw new Error('工作台不支持这个工具。');
  }

  async function execute(name, args, { toolUseId = randomUUID() } = {}) {
    const safeArgs = args && typeof args === 'object' ? cleanValue(args, redact) : {};
    const tool = { id: toolUseId, name, input: safeArgs, status: 'running', output: '', createdAt: Date.now() };
    await emit({ type: 'tool', tool });
    let result;
    try { result = await perform(name, args, toolUseId); }
    catch (error) { result = { output: error?.message || '工具执行失败。', isError: true }; }
    result = { output: boundedText(redact(String(result.output))), isError: Boolean(result.isError) };
    await emit({ type: 'tool', tool: { ...tool, status: result.isError ? 'error' : 'done', output: result.output } });
    await emit({ type: 'afterTool', toolName: name, input: safeArgs, toolUseId, output: result.output, isError: result.isError });
    return result;
  }

  return { definitions, execute };
}
