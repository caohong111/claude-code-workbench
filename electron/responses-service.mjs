import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createParser } from 'eventsource-parser';
import { providerRequestKey } from './provider-config.mjs';
import { createWorkspaceTools } from './responses-tools.mjs';
import { persistInputImages, hydrateInputImages, saveGeneratedImages, generatedImageMarkdown } from './responses-images.mjs';

const MODES = new Set(['manual', 'acceptEdits', 'auto', 'plan']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const SESSION_ID = /^direct-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_TEXT = 200000;
const MAX_RESPONSE = 16 * 1024 * 1024;
const MAX_IMAGE_RESPONSE = 128 * 1024 * 1024;
const MAX_HISTORY = 8 * 1024 * 1024;
const MAX_ROUNDS = 50;

function responseEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('当前渠道的接口地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('当前渠道的接口地址无效。');
  const base = url.href.replace(/\/+$/, '');
  return /\/responses$/i.test(base) ? base : /\/v1$/i.test(base) ? `${base}/responses` : `${base}/v1/responses`;
}

const sameFolder = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const userInput = (text, images) => ({ role: 'user', content: [{ type: 'input_text', text }, ...images] });

export class ResponsesService {
  constructor({ configDirectory, tempDirectory, cacheDirectory, onEvent = () => {}, fetchImpl = globalThis.fetch, toolsFactory = createWorkspaceTools, environment = process.env, requestTimeoutMs = 180000 }) {
    Object.assign(this, { configDirectory, tempDirectory, cacheDirectory, onEvent, fetchImpl, toolsFactory, environment, requestTimeoutMs });
    this.currentRun = null;
    this.pendingPermissions = new Map();
  }

  async run({ runId = randomUUID(), cwd, prompt, model, effort = 'medium', permissionMode = 'manual', resumeSessionId, expectedProviderKey, inputImages = [], imageGeneration = false, imageModel = 'gpt-image-2', imageSize }) {
    if (this.currentRun) throw new Error('已有任务正在运行，请先停止。');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof prompt !== 'string' || !prompt.trim()) throw new Error('请选择工作文件夹并输入任务。');
    if (!MODES.has(permissionMode) || !EFFORTS.has(effort)) throw new Error('不支持该操作权限或思考强度。');
    const run = { id: runId, cwd, model, mode: permissionMode, imageGeneration: imageGeneration === true, imageTurnId: randomUUID(), controller: new AbortController(), stopped: false, hadError: false, sessionId: null, outputText: '', pendingText: '', lastTextItem: null, secrets: [] };
    this.currentRun = run;
    try {
      if (run.imageGeneration && permissionMode === 'plan') throw new Error('计划模式不能生成图片，请先切换操作权限。');
      if (run.imageGeneration && (typeof imageModel !== 'string' || !imageModel.trim() || imageModel.length > 200 || /[\r\n\0]/.test(imageModel))) throw new Error('生图模型配置无效。');
      if (run.imageGeneration && imageSize !== undefined && !['auto', '1024x1024', '1536x1024', '1024x1536'].includes(imageSize)) throw new Error('生图尺寸配置无效。');
      const settings = await this._settings();
      const settingsEnv = Object.fromEntries(Object.entries(settings.env || {}).filter(([, value]) => typeof value === 'string'));
      const env = { ...this.environment, ...settingsEnv };
      const token = String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '').replace(/^Bearer\s+/i, '').trim();
      run.secrets = [...new Set([...Object.entries(env).filter(([key, value]) => /token|secret|password|api.?key|credential/i.test(key) && typeof value === 'string' && value.length >= 6).map(([, value]) => value), token].filter(Boolean))].sort((a, b) => b.length - a.length);
      if (expectedProviderKey && expectedProviderKey !== providerRequestKey(env)) throw new Error('渠道刚刚发生变化，请确认新渠道后重新发送任务。');
      if (!token || /[\r\n\0]/.test(token)) throw new Error('当前渠道缺少有效 API 密钥。');
      const endpoint = responseEndpoint(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
      run.model = model === 'default' ? [env.ANTHROPIC_MODEL, settings.model, env.ANTHROPIC_DEFAULT_MODEL].find(value => typeof value === 'string' && value.trim()) : model;
      if (typeof run.model !== 'string' || !run.model.trim() || run.model.length > 200 || /[\r\n\0]/.test(run.model)) throw new Error('请先选择代码对话模型。');
      run.cwd = await fs.realpath(cwd);
      const history = await this._history(run, resumeSessionId);
      await this._emit(run, { type: 'session', sessionId: run.sessionId, model: run.model });
      if (run.stopped) return { sessionId: run.sessionId, stopped: true };
      const tools = this.toolsFactory({
        cwd: run.cwd, permissionMode, signal: run.controller.signal,
        requestPermission: request => this._permission(run, request),
        onEvent: event => this._emit(run, event),
        redact: value => this._redact(run, String(value)),
      });
      const images = await persistInputImages(this.cacheDirectory, inputImages, run.controller.signal);
      const input = [...history, userInput(this._redact(run, prompt), images)];
      await this._saveHistory(run, input);
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (run.stopped) break;
        this._assertHistory(input);
        const instructions = `You are the coding assistant inside Claude Workbench. The user works in ${run.cwd}. Reply in the user's language. Use the provided workspace tools when the task requires inspecting or modifying real files. Do not claim to inspect files or execute commands without using a tool. Tool names match the desktop activity and permission controls. Bash runs PowerShell on Windows. ${permissionMode === 'plan' ? 'Planning mode: only inspect and discuss. File modifications and shell commands are unavailable. Return a plan for review.' : 'Respect the permission decisions returned by the desktop. Never work around a declined tool request.'}`;
        const body = { model: run.model, instructions: run.imageGeneration ? 'Generate or edit the requested image using the image_generation tool. Use the supplied reference images when present. Return a real bitmap image, not SVG source or a description. Reply in the user\'s language.' : instructions, input: await hydrateInputImages(this.cacheDirectory, input, run.controller.signal), tools: run.imageGeneration ? [{ type: 'image_generation', model: imageModel }] : tools.definitions, parallel_tool_calls: false, stream: true, store: false, include: ['reasoning.encrypted_content'] };
        if (run.imageGeneration) {
          body.tool_choice = { type: 'image_generation' };
          if (imageSize !== undefined) body.tools[0].size = imageSize;
        }
        if (/^(?:gpt-[5-9]|o\d|codex-)/i.test(run.model)) body.reasoning = { effort: effort === 'max' ? 'xhigh' : effort };
        const output = await this._request(run, endpoint, token, body);
        if (run.stopped) break;
        input.push(...output);
        const calls = output.filter(item => item.type === 'function_call');
        for (const call of calls) {
          let result;
          if (run.stopped) result = { output: 'Task stopped by the user.', isError: true };
          else {
            let argumentsValue;
            try { argumentsValue = JSON.parse(call.arguments || '{}'); }
            catch { result = { output: 'Invalid tool arguments: expected a JSON object.', isError: true }; }
            if (!result && (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue))) result = { output: 'Invalid tool arguments: expected a JSON object.', isError: true };
            if (!result) {
              try { result = await tools.execute(call.name, argumentsValue, { toolUseId: call.call_id }); }
              catch (error) { result = { output: error?.message || 'Tool execution failed.', isError: true }; }
            }
          }
          const text = typeof result?.output === 'string' ? result.output : JSON.stringify(result?.output ?? '');
          input.push({ type: 'function_call_output', call_id: call.call_id, output: this._redact(run, text).slice(0, MAX_TEXT) });
        }
        await this._saveHistory(run, input);
        if (!calls.length) {
          if (!run.outputText) throw new Error('模型未返回可显示的内容，请重新发送任务。');
          break;
        }
        if (round === MAX_ROUNDS - 1) throw new Error('任务已达到 50 轮操作上限，请检查操作记录后继续。');
      }
      return this._clean(run, { sessionId: run.sessionId, result: run.pendingText ? run.outputText.slice(0, -run.pendingText.length) + '[密钥已隐藏]' : run.outputText, stopped: run.stopped, isError: run.hadError });
    } catch (error) {
      if (!run.stopped) {
        run.hadError = true;
        const message = error?.name === 'TimeoutError' || run.requestTimedOut ? '模型请求超时，请重试。' : error?.message || '模型请求失败。';
        await this._emit(run, { type: 'error', error: message });
      }
      return this._clean(run, { sessionId: run.sessionId, stopped: run.stopped, isError: !run.stopped });
    } finally {
      this._cancelPermissions(run);
      if (run.pendingText) {
        run.outputText = run.outputText.slice(0, -run.pendingText.length) + '[密钥已隐藏]';
        await this._emit(run, { type: 'text', text: '[密钥已隐藏]' });
      }
      if (this.currentRun === run) this.currentRun = null;
      await this._emit(run, { type: 'done', result: run.stopped ? '任务已停止。' : run.outputText, stopped: run.stopped, isError: run.hadError, sessionId: run.sessionId });
    }
  }

  async _settings() {
    try { return JSON.parse(await fs.readFile(path.join(this.configDirectory, 'settings.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Claude settings.json 无法读取，请检查配置。'); }
  }

  async _history(run, resumeSessionId) {
    const directory = path.join(this.cacheDirectory, 'direct-responses');
    await fs.mkdir(directory, { recursive: true });
    run.sessionId = SESSION_ID.test(resumeSessionId || '') ? resumeSessionId : `direct-${randomUUID()}`;
    run.historyPath = path.join(directory, `${run.sessionId}.json`);
    if (!SESSION_ID.test(resumeSessionId || '')) { await this._saveHistory(run, []); return []; }
    let saved;
    try {
      const stat = await fs.stat(run.historyPath);
      if (stat.size > MAX_HISTORY) throw new Error('oversized');
      saved = JSON.parse(await fs.readFile(run.historyPath, 'utf8'));
    } catch { throw new Error('此对话的本地记录无法读取，请新建对话后重试。'); }
    if (saved.version !== 1 || typeof saved.cwd !== 'string' || !sameFolder(saved.cwd, run.cwd) || !Array.isArray(saved.input)) throw new Error('此对话的工作目录或记录不匹配，请新建对话。');
    this._assertHistory(saved.input);
    return this._clean(run, saved.input);
  }

  _assertHistory(input) {
    if (input.length > 2000 || Buffer.byteLength(JSON.stringify(input)) > MAX_HISTORY - 4096) throw new Error('对话上下文过长，请新建对话后继续。');
  }

  async _saveHistory(run, input) {
    const safe = this._clean(run, input);
    this._assertHistory(safe);
    const temporary = `${run.historyPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, cwd: run.cwd, input: safe }), { mode: 0o600 });
      await fs.rename(temporary, run.historyPath);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async _request(run, endpoint, token, body) {
    const controller = new AbortController();
    const stop = () => controller.abort(run.controller.signal.reason);
    run.controller.signal.addEventListener('abort', stop, { once: true });
    if (run.controller.signal.aborted) stop();
    run.requestTimedOut = false;
    const timer = setTimeout(() => { run.requestTimedOut = true; controller.abort(); }, this.requestTimeoutMs);
    let reader;
    try {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', ...(run.imageGeneration ? { 'X-Codex-Image-Turn-Id': run.imageTurnId } : {}) };
      const response = await this.fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        const value = await this._readLimited(response, 32768);
        let message;
        try { const parsed = JSON.parse(value); message = parsed.error?.message || parsed.message; } catch {}
        const hint = run.imageGeneration && response.status === 403 ? ' 请检查中转站当前密钥所属分组是否已开启图片生成权限。' : run.imageGeneration && response.status === 503 ? ' 当前渠道暂时没有可用的生图服务，请检查中转站上游和生图模型配置。' : '';
        throw new Error(`模型接口请求失败（HTTP ${response.status}）${typeof message === 'string' ? `：${this._redact(run, message).slice(0, 1500)}` : '。'}${hint}`);
      }
      if (response.headers.get('content-type')?.includes('application/json')) {
        let value;
        try { value = JSON.parse(await this._readLimited(response, run.imageGeneration ? MAX_IMAGE_RESPONSE : MAX_RESPONSE)); } catch { throw new Error('模型接口返回了无效或过大的 JSON。'); }
        return this._finalOutput(run, value, new Map());
      }
      if (!response.body) throw new Error('模型接口未返回数据流。');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const receivedText = new Map();
      const items = new Map();
      const events = [];
      let parseError;
      let bytes = 0;
      let completed;
      const parser = createParser({ maxBufferSize: run.imageGeneration ? 64 * 1024 * 1024 : 4 * 1024 * 1024, onEvent(event) { if (event.data !== '[DONE]') events.push(event); }, onError(error) { if (error.type === 'max-buffer-size-exceeded') parseError = new Error('模型返回的单条数据过大。'); } });
      while (!completed) {
        const chunk = await reader.read();
        if (chunk.done) { parser.feed(decoder.decode()); break; }
        bytes += chunk.value.byteLength;
        if (bytes > (run.imageGeneration ? MAX_IMAGE_RESPONSE : MAX_RESPONSE)) throw new Error('模型返回的数据过大，请缩小任务后重试。');
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        if (parseError) throw parseError;
        while (events.length) {
          const event = events.shift();
          let data;
          try { data = JSON.parse(event.data); } catch { throw new Error('模型接口返回了无效的流数据。'); }
          const type = data.type || event.event;
          if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
            const key = `${data.item_id ?? data.output_index ?? 'message'}:${data.content_index || 0}`;
            const delta = data.delta || '';
            receivedText.set(key, (receivedText.get(key) || '') + delta);
            await this._appendText(run, key, delta);
          } else if (type === 'response.output_text.done' || type === 'response.refusal.done') {
            const key = `${data.item_id ?? data.output_index ?? 'message'}:${data.content_index || 0}`;
            await this._reconcileText(run, receivedText, key, data.text ?? data.refusal ?? '');
          } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
            if (data.item && Number.isInteger(data.output_index)) items.set(data.output_index, data.item);
          } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
            const item = items.get(data.output_index);
            if (item) item.arguments = type.endsWith('.done') ? data.arguments || '' : (item.arguments || '') + (data.delta || '');
          } else if (type === 'response.completed') {
            completed = { ...(data.response || {}), output: data.response?.output || [...items].sort(([a], [b]) => a - b).map(([, item]) => item) };
          } else if (['response.failed', 'response.incomplete', 'error'].includes(type)) {
            throw new Error(data.response?.error?.message || data.error?.message || data.message || (type === 'response.incomplete' ? '模型回复未完成，请缩小任务或继续发送。' : '模型处理任务失败。'));
          }
        }
      }
      if (!completed) throw new Error('模型连接提前结束，回复未完成，请重试。');
      return await this._finalOutput(run, completed, receivedText);
    } finally {
      clearTimeout(timer);
      run.controller.signal.removeEventListener('abort', stop);
      if (reader) await reader.cancel().catch(() => {});
    }
  }

  async _readLimited(response, limit) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limit) throw new Error('模型接口返回的数据过大。');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  }

  async _finalOutput(run, response, receivedText) {
    if (response.error || response.status && response.status !== 'completed') throw new Error(response.error?.message || '模型回复未完成，请重试。');
    if (!Array.isArray(response.output) || response.output.length > 500) throw new Error('模型接口返回的回复格式不正确。');
    const output = [];
    const imageItems = response.output.filter(item => item?.type === 'image_generation_call');
    if (run.imageGeneration && !imageItems.length) throw new Error('图片接口未返回图片。请确认当前渠道支持 image_generation 和所选生图模型。');
    if (imageItems.length && !run.imageGeneration) throw new Error('当前任务未开启图片生成，请使用生图按钮重新发送。');
    for (let index = 0; index < response.output.length; index++) {
      const item = response.output[index];
      if (item.type === 'message') {
        if (!Array.isArray(item.content)) throw new Error('模型返回的消息格式不正确。');
        for (let part = 0; part < item.content.length; part++) {
          const content = item.content[part];
          if (content.type === 'output_text' || content.type === 'refusal') await this._reconcileText(run, receivedText, `${item.id || index}:${part}`, content.text ?? content.refusal ?? '');
        }
        output.push(item);
      } else if (item.type === 'function_call') {
        if (run.imageGeneration) throw new Error('图片接口返回了不支持的文件操作，请检查渠道的生图支持。');
        if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || typeof item.arguments !== 'string' || item.arguments.length > MAX_TEXT) throw new Error('模型返回的工具调用格式不正确。');
        output.push(item);
      } else if (item.type === 'reasoning') output.push(item);
    }
    if (imageItems.length) {
      const images = await saveGeneratedImages(run.cwd, imageItems, run.controller.signal);
      const text = generatedImageMarkdown(images);
      await this._appendText(run, 'generated-images', text);
      output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const image of images) await this._emit(run, { type: 'image', image });
    }
    if (response.usage) {
      const usage = response.usage;
      await this._emit(run, { type: 'usage', usage: { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, cachedInputTokens: usage.input_tokens_details?.cached_tokens || 0 } });
    }
    return this._clean(run, output);
  }

  async _reconcileText(run, received, key, text) {
    if (typeof text !== 'string') return;
    const prior = received.get(key) || '';
    if (text.startsWith(prior)) await this._appendText(run, key, text.slice(prior.length));
    received.set(key, text);
  }

  async _permission(run, request) {
    if (run.stopped || run.controller.signal.aborted) return { behavior: 'deny', message: 'Task stopped by the user.' };
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = result => { this.pendingPermissions.delete(id); resolve(result); };
      this.pendingPermissions.set(id, { run, request, finish });
      this._emit(run, { type: 'permission', permission: { id, ...request, ...(request.toolName === 'AskUserQuestion' ? { questions: request.input?.questions } : {}) } }).catch(error => { this.pendingPermissions.delete(id); reject(error); });
    });
  }

  respondPermission({ id, decision, answers } = {}) {
    const pending = this.pendingPermissions.get(id);
    if (!pending || pending.run !== this.currentRun) return false;
    if (decision !== 'allow') pending.finish({ behavior: 'deny', message: 'The user declined this action.' });
    else {
      const input = pending.request.input || {};
      const normalized = {};
      for (const question of input.questions || []) {
        const value = answers?.[question.question];
        if (typeof value === 'string' && value.trim()) normalized[question.question] = value.trim();
        else if (Array.isArray(value) && value.length) normalized[question.question] = value.map(String).join(', ');
      }
      if (pending.request.toolName === 'AskUserQuestion' && !Object.keys(normalized).length) pending.finish({ behavior: 'deny', message: 'No answer was supplied.' });
      else pending.finish({ behavior: 'allow', updatedInput: { ...input, ...(pending.request.toolName === 'AskUserQuestion' ? { answers: normalized } : {}) } });
    }
    return true;
  }

  _cancelPermissions(run) {
    for (const pending of this.pendingPermissions.values()) if (pending.run === run) pending.finish({ behavior: 'deny', message: 'Task stopped by the user.' });
  }

  stop() {
    const run = this.currentRun;
    if (!run) return false;
    run.stopped = true;
    run.controller.abort();
    this._cancelPermissions(run);
    return true;
  }

  async _appendText(run, itemId, text) {
    if (!text) return;
    if (run.outputText.length + text.length > MAX_TEXT) throw new Error('模型回复过长，请缩小任务后重试。');
    const separator = run.outputText && run.lastTextItem !== itemId && !run.outputText.endsWith('\n') ? '\n\n' : '';
    const addition = separator + text;
    run.outputText += addition;
    run.lastTextItem = itemId;
    const safe = this._redact(run, run.pendingText + addition);
    let retained = 0;
    for (const secret of run.secrets) for (let size = Math.min(secret.length - 1, safe.length); size > retained; size--) {
      if (secret.startsWith(safe.slice(-size))) { retained = size; break; }
    }
    run.pendingText = retained ? safe.slice(-retained) : '';
    const visible = retained ? safe.slice(0, -retained) : safe;
    if (visible) await this._emit(run, { type: 'text', text: visible });
  }

  _redact(run, value) { let text = String(value); for (const secret of run.secrets) text = text.split(secret).join('[密钥已隐藏]'); return text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[密钥已隐藏]'); }
  _clean(run, value, depth = 0) {
    if (typeof value === 'string') return this._redact(run, value);
    if (depth > 20) return '[内容过深]';
    if (Array.isArray(value)) return value.map(item => this._clean(run, item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:authorization|api_?key|access_?token|password|secret)$/i.test(key) ? '[密钥已隐藏]' : this._clean(run, item, depth + 1)]));
    return value;
  }
  async _emit(run, event) { await this.onEvent(this._clean(run, { ...event, runId: run.id, engine: 'responses' })); }
}
