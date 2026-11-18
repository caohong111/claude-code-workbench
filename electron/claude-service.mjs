import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerRequestKey } from './provider-config.mjs';

const MODES = new Set(['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const CANCELLED = 'Stopped by the user.';

function toolText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => part?.text ?? (typeof part === 'string' ? part : '')).filter(Boolean).join('\n');
  }
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export class ClaudeService {
  constructor({ executablePath, configDirectory, tempDirectory, cacheDirectory, onEvent, queryFactory }) {
    this.executablePath = executablePath;
    this.configDirectory = configDirectory;
    this.tempDirectory = tempDirectory;
    this.cacheDirectory = cacheDirectory;
    this.onEvent = onEvent ?? (() => {});
    this.queryFactory = queryFactory;
    this.currentRun = null;
    this.pendingPermissions = new Map();
  }

  async run({ runId = randomUUID(), cwd, prompt, model, effort = 'medium', permissionMode = 'manual', resumeSessionId, expectedProviderKey, historyContext, inputImages = [] }) {
    if (this.currentRun) throw new Error('A task is already running. Stop it before starting another task.');
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Choose a workspace folder first.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Enter a task first.');
    const mode = permissionMode === 'default' ? 'manual' : permissionMode;
    if (!MODES.has(mode)) throw new Error('Unsupported permission mode.');
    if (!EFFORTS.has(effort)) throw new Error('Unsupported effort level.');
    if (!Array.isArray(inputImages) || inputImages.length > 4 || inputImages.some(image => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image?.mimeType) || typeof image.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64))) throw new Error('无效的图片附件。');

    const run = {
      id: runId,
      controller: new AbortController(),
      query: null,
      stopped: false,
      sessionId: resumeSessionId ?? null,
      tools: new Map(),
      streams: new Map(),
      fullMessages: new Set(),
      interactiveDecisions: new Map(),
      currentMessageId: null,
      lastTextKey: null,
      outputText: '',
      pendingText: '',
      result: '',
      hadError: false,
      secrets: [],
    };
    this.currentRun = run;

    try {
      const env = await this._environment(run);
      if (expectedProviderKey && expectedProviderKey !== providerRequestKey(env)) throw new Error('渠道刚刚发生变化，请从新渠道的模型列表确认后重新发送任务。');
      if (run.stopped) return { stopped: true, sessionId: run.sessionId };
      const queryFactory = this.queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      const beforeTool = async (input, toolUseId, context = {}) => {
        const id = toolUseId ?? input.tool_use_id ?? randomUUID();
        await this._emit(run, {
          type: 'beforeTool', toolName: input.tool_name, input: input.tool_input ?? {}, toolUseId: id,
        });
        await this._tool(run, id, { name: input.tool_name, input: input.tool_input ?? {}, status: 'running' });
        if (INTERACTIVE_TOOLS.has(input.tool_name)) {
          const decision = await this._decidePermission(run, input.tool_name, input.tool_input ?? {}, {
            signal: context.signal,
            toolUseID: id,
            decisionReason: input.tool_name === 'AskUserQuestion'
              ? 'Claude needs your answer before continuing.'
              : 'Review the plan before allowing Claude to begin implementation.',
          });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: decision.behavior,
              permissionDecisionReason: decision.behavior === 'allow' ? 'Approved by the user in the desktop panel.' : decision.message,
              ...(decision.behavior === 'allow' ? { updatedInput: decision.updatedInput } : {}),
            },
          };
        }
        return {};
      };
      const afterTool = (isError) => async (input, toolUseId) => {
        const id = toolUseId ?? input.tool_use_id ?? randomUUID();
        const output = input.tool_response ?? input.error ?? '';
        await this._emit(run, {
          type: 'afterTool', toolName: input.tool_name, input: input.tool_input ?? {}, toolUseId: id, output, isError,
        });
        await this._tool(run, id, {
          name: input.tool_name, input: input.tool_input ?? {}, status: isError ? 'error' : 'done', output: toolText(output),
        });
        return {};
      };
      const options = {
        pathToClaudeCodeExecutable: this.executablePath,
        cwd,
        env,
        model: model === 'default' ? (run.configuredModel || 'default') : (model || undefined),
        effort,
        permissionMode: mode,
        permissionPrompts: 'host',
        settingSources: ['user', 'project', 'local'],
        settings: { fastMode: run.fastMode },
        systemPrompt: {
          type: 'preset', preset: 'claude_code',
          ...(typeof historyContext === 'string' && historyContext.trim() ? { append: historyContext } : {}),
        },
        includePartialMessages: true,
        abortController: run.controller,
        resume: resumeSessionId || undefined,
        maxTurns: 50,
        ...(run.chromeEnabled ? { extraArgs: { chrome: null } } : {}),
        canUseTool: (toolName, input, context) => this._decidePermission(run, toolName, input, context),
        hooks: {
          PreToolUse: [{ hooks: [beforeTool], onFailure: 'block' }],
          PostToolUse: [{ hooks: [afterTool(false)] }],
          PostToolUseFailure: [{ hooks: [afterTool(true)] }],
        },
        stderr: (text) => {
          const clean = this._redact(run, String(text)).trim();
          if (clean) run.lastStderr = clean.slice(-5000);
        },
      };
      const sdkPrompt = inputImages.length ? (async function* () {
        yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
          { type: 'text', text: prompt },
          ...inputImages.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 } })),
        ] } };
      })() : prompt;
      run.query = await queryFactory({ prompt: sdkPrompt, options });
      if (run.stopped) {
        run.query.close?.();
        return { stopped: true, sessionId: run.sessionId };
      }
      for await (const message of run.query) {
        if (run.stopped) break;
        await this._message(run, message);
      }
      if (!run.hadError && !run.stopped && !run.result && !run.outputText) {
        throw new Error(run.lastStderr || 'Claude exited without returning a response. Check the selected model and API configuration.');
      }
      return this._clean(run, { sessionId: run.sessionId, result: run.result || run.outputText, stopped: run.stopped, isError: run.hadError });
    } catch (error) {
      if (!run.stopped && !run.controller.signal.aborted) {
        run.hadError = true;
        await this._emit(run, { type: 'error', error: this._errorMessage(run, error) });
      }
      return { sessionId: run.sessionId, stopped: run.stopped, isError: !run.stopped };
    } finally {
      this._cancelPermissions(run);
      try { run.query?.close?.(); } catch { /* The SDK may already have closed its transport. */ }
      if (this.currentRun === run) this.currentRun = null;
      if (run.pendingText) await this._emit(run, { type: 'text', text: run.pendingText });
      await this._emit(run, {
        type: 'done', result: run.stopped ? CANCELLED : (run.result || run.outputText),
        stopped: run.stopped, isError: run.hadError, sessionId: run.sessionId,
      });
    }
  }

  stop() {
    const run = this.currentRun;
    if (!run) return false;
    run.stopped = true;
    this._cancelPermissions(run);
    run.controller.abort();
    try { run.query?.close?.(); } catch { /* Closing an exited process is harmless. */ }
    return true;
  }

  respondPermission({ id, decision, answers } = {}) {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return false;
    if (decision !== 'allow') {
      pending.finish({ behavior: 'deny', message: 'The user declined this action.' });
      return true;
    }
    let updatedInput = pending.input;
    if (pending.toolName === 'AskUserQuestion') {
      const normalizedAnswers = {};
      const source = answers && typeof answers === 'object' ? answers : {};
      for (const question of pending.input.questions ?? []) {
        const answer = source[question.question];
        if (typeof answer === 'string' && answer.trim()) normalizedAnswers[question.question] = answer;
        else if (Array.isArray(answer) && answer.length) normalizedAnswers[question.question] = answer.map(String).join(', ');
      }
      if (!Object.keys(normalizedAnswers).length) {
        pending.finish({ behavior: 'deny', message: 'The user did not provide an answer.' });
        return true;
      }
      updatedInput = { ...pending.input, answers: normalizedAnswers };
    }
    pending.finish({ behavior: 'allow', updatedInput });
    return true;
  }

  async _environment(run) {
    let settings = {};
    try {
      settings = JSON.parse(await readFile(join(this.configDirectory, 'settings.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Claude settings.json could not be read. Fix its JSON format in CC Switch and try again.');
    }
    run.fastMode = settings.fastMode === true;
    try { run.chromeEnabled = JSON.parse(await readFile(join(this.configDirectory, '.claude.json'), 'utf8')).claudeInChromeDefaultEnabled === true; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Claude .claude.json could not be read. Fix its JSON format and try again.'); }
    const settingsEnv = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([, value]) => typeof value === 'string'));
    const env = {
      ...process.env,
      ...settingsEnv,
      CLAUDE_CONFIG_DIR: this.configDirectory,
      CLAUDE_CODE_TMPDIR: this.tempDirectory,
      TEMP: this.tempDirectory,
      TMP: this.tempDirectory,
      XDG_CACHE_HOME: this.cacheDirectory,
      DISABLE_UPDATES: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'claude-workspace-panel',
    };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    run.configuredModel = [env.ANTHROPIC_MODEL, settings.model, env.ANTHROPIC_DEFAULT_MODEL].find(value => typeof value === 'string' && value.trim()) || null;
    run.secrets = Object.entries(env)
      .filter(([key, value]) => /token|secret|password|api.?key|credential/i.test(key) && typeof value === 'string' && value.length >= 6)
      .map(([, value]) => value)
      .sort((a, b) => b.length - a.length);
    return env;
  }

  async _emit(run, event) {
    await this.onEvent(this._clean(run, { ...event, runId: run.id }));
  }

  _redact(run, text) {
    let result = text;
    for (const secret of run.secrets) result = result.split(secret).join('[REDACTED]');
    return result.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  }

  _clean(run, value, depth = 0) {
    if (typeof value === 'string') return this._redact(run, value).slice(0, 200000);
    if (depth > 12) return '[Truncated]';
    if (Array.isArray(value)) return value.slice(0, 500).map((item) => this._clean(run, item, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        /^(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|authorization|api_?key|access_?token|password|secret)$/i.test(key)
          ? '[REDACTED]' : this._clean(run, item, depth + 1),
      ]));
    }
    return value;
  }

  async _tool(run, id, patch) {
    const previous = run.tools.get(id) ?? { id, name: patch.name || 'Tool', input: {}, status: 'running', createdAt: Date.now() };
    const tool = { ...previous, ...patch, id };
    run.tools.set(id, tool);
    await this._emit(run, { type: 'tool', tool });
  }

  async _requestPermission(run, toolName, input, context = {}) {
    if (run.stopped || context.signal?.aborted) return { behavior: 'deny', message: CANCELLED, interrupt: true };
    const id = context.requestId ?? randomUUID();
    return new Promise((resolve) => {
      const finish = (result) => {
        if (!this.pendingPermissions.has(id)) return;
        this.pendingPermissions.delete(id);
        context.signal?.removeEventListener('abort', cancel);
        resolve(result);
      };
      const cancel = () => finish({ behavior: 'deny', message: CANCELLED, interrupt: true });
      this.pendingPermissions.set(id, { run, toolName, input, finish });
      context.signal?.addEventListener('abort', cancel, { once: true });
      this._emit(run, {
        type: 'permission', permission: {
          id, toolName, input,
          reason: context.decisionReason,
          questions: toolName === 'AskUserQuestion' ? input.questions ?? [] : undefined,
          defaultToNo: context.defaultToNo ?? true,
          toolUseId: context.toolUseID,
        },
      }).catch(() => finish({ behavior: 'deny', message: 'The permission dialog could not be displayed.', interrupt: true }));
    });
  }

  async _decidePermission(run, toolName, input, context = {}) {
    if (!INTERACTIVE_TOOLS.has(toolName) || !context.toolUseID) {
      return this._requestPermission(run, toolName, input, context);
    }
    // Hooks run before mode/rule approvals; reuse their human decision if the SDK prompts again.
    const cached = run.interactiveDecisions.get(context.toolUseID);
    if (cached?.toolName === toolName) return cached.decision;
    const decision = this._requestPermission(run, toolName, input, context);
    run.interactiveDecisions.set(context.toolUseID, { toolName, decision });
    return decision;
  }

  _cancelPermissions(run) {
    for (const permission of this.pendingPermissions.values()) {
      if (permission.run === run) permission.finish({ behavior: 'deny', message: CANCELLED, interrupt: true });
    }
  }

  async _appendText(run, key, text) {
    if (!text) return;
    const separator = run.outputText && run.lastTextKey !== key && !run.outputText.endsWith('\n') ? '\n\n' : '';
    const addition = separator + text;
    run.outputText += addition;
    run.lastTextKey = key;
    const safeText = this._redact(run, run.pendingText + addition);
    // Retain secret prefixes across token boundaries so streamed chunks cannot reconstruct a credential.
    let retained = 0;
    for (const secret of run.secrets) {
      for (let size = Math.min(secret.length - 1, safeText.length); size > retained; size -= 1) {
        if (secret.startsWith(safeText.slice(-size))) { retained = size; break; }
      }
    }
    run.pendingText = retained ? safeText.slice(-retained) : '';
    const visibleText = safeText.slice(0, safeText.length - retained);
    if (visibleText) await this._emit(run, { type: 'text', text: visibleText });
  }

  async _message(run, message) {
    if (message.session_id && message.session_id !== run.sessionId) {
      run.sessionId = message.session_id;
      await this._emit(run, { type: 'session', sessionId: run.sessionId, model: message.model });
    }
    if (message.type === 'stream_event') {
      const event = message.event ?? {};
      if (event.type === 'message_start') run.currentMessageId = event.message?.id ?? randomUUID();
      const id = run.currentMessageId ?? 'stream';
      const key = `${id}:${event.index ?? 0}`;
      if (event.type === 'content_block_start') {
        const block = event.content_block ?? {};
        const record = { key, messageId: id, type: block.type, text: '', fullSeen: false };
        run.streams.set(key, record);
        if (block.type === 'text' && block.text) {
          record.text += block.text;
          await this._appendText(run, key, block.text);
        }
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        let record = run.streams.get(key);
        if (!record) {
          record = { key, messageId: id, type: 'text', text: '', fullSeen: false };
          run.streams.set(key, record);
        }
        record.text += event.delta.text ?? '';
        await this._appendText(run, key, event.delta.text ?? '');
      }
      return;
    }
    if (message.type === 'assistant') {
      if (message.uuid && run.fullMessages.has(message.uuid)) return;
      if (message.uuid) run.fullMessages.add(message.uuid);
      let index = 0;
      for (const block of message.message?.content ?? []) {
        if (block.type === 'tool_use') {
          await this._tool(run, block.id, { name: block.name, input: block.input ?? {} });
        } else if (block.type === 'text' && !message.parent_tool_use_id) {
          // Full blocks follow their streamed deltas; append only any missing suffix.
          const record = [...run.streams.values()].find((entry) =>
            entry.messageId === message.message.id && entry.type === 'text' && !entry.fullSeen);
          if (record) {
            record.fullSeen = true;
            if (block.text.startsWith(record.text)) await this._appendText(run, record.key, block.text.slice(record.text.length));
          } else {
            await this._appendText(run, `${message.message.id ?? message.uuid}:${index}`, block.text ?? '');
          }
        }
        index += 1;
      }
      if (message.error) run.lastAssistantError = message.error;
      return;
    }
    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          await this._tool(run, block.tool_use_id, {
            status: block.is_error ? 'error' : 'done', output: toolText(block.content),
          });
        }
      }
      return;
    }
    if (message.type === 'tool_progress') {
      const current = run.tools.get(message.tool_use_id);
      if (!current || current.status === 'running') {
        await this._tool(run, message.tool_use_id, { name: message.tool_name, elapsedSeconds: message.elapsed_time_seconds });
      }
      return;
    }
    if (message.type === 'result') {
      const usage = message.usage ?? {};
      await this._emit(run, {
        type: 'usage', usage: {
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          costUsd: message.total_cost_usd ?? 0,
          durationMs: message.duration_ms ?? 0,
        },
      });
      run.result = message.result ?? '';
      if (message.is_error || message.subtype !== 'success') {
        run.hadError = true;
        const detail = message.errors?.join('\n') || message.result || run.lastAssistantError || message.subtype;
        await this._emit(run, { type: 'error', error: this._errorMessage(run, new Error(detail)) });
      } else if (!run.outputText && message.result) {
        await this._appendText(run, 'result', message.result);
      }
    }
  }

  _errorMessage(run, error) {
    const detail = this._redact(run, error?.message || String(error));
    const context = run.lastStderr && !detail.includes(run.lastStderr) ? `\n${run.lastStderr}` : '';
    return (detail + context).slice(0, 10000);
  }
}
