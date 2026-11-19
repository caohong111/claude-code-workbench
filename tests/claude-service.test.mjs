import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeService } from '../electron/claude-service.mjs';

const testRoot = join(dirname(fileURLToPath(import.meta.url)), '.tmp');
const fakeToken = 'fixture-private-token-123456789';

function success(result = 'Finished.', extra = {}) {
  return {
    type: 'result', subtype: 'success', is_error: false,
    session_id: 'session-fixture', result,
    usage: { input_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 5, output_tokens: 7 },
    total_cost_usd: 0.001, duration_ms: 123, ...extra,
  };
}

function stream(event, extra = {}) {
  return { type: 'stream_event', event, ...extra };
}

async function harness(t, generator, handlePermission) {
  await mkdir(testRoot, { recursive: true });
  const fixtureDirectory = await mkdtemp(join(testRoot, 'claude-service-'));
  await writeFile(join(fixtureDirectory, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: fakeToken, ANTHROPIC_BASE_URL: 'https://fixture.invalid' },
  }));
  const events = [];
  const state = { options: null, prompt: null, closes: 0 };
  let service;
  service = new ClaudeService({
    executablePath: join(fixtureDirectory, 'not-executed.exe'),
    configDirectory: fixtureDirectory,
    tempDirectory: join(fixtureDirectory, 'temp'),
    cacheDirectory: join(fixtureDirectory, 'cache'),
    queryFactory: ({ prompt, options }) => {
      state.options = options;
      state.prompt = prompt;
      return {
        [Symbol.asyncIterator]: () => generator(options),
        close: () => { state.closes += 1; },
      };
    },
    onEvent: async (event) => {
      events.push(event);
      if (event.type === 'permission' && handlePermission) await handlePermission(event.permission, service);
    },
  });
  t.after(async () => {
    service.stop();
    assert.ok(resolve(fixtureDirectory).startsWith(resolve(testRoot) + sep));
    await rm(fixtureDirectory, { recursive: true, force: true });
  });
  return {
    service, events, state, fixtureDirectory,
    run: (extra = {}) => service.run({ runId: 'run-fixture', cwd: fixtureDirectory, prompt: 'Fixture task.', ...extra }),
  };
}

test('streams text once, preserves resumed session, and reports cached usage', async (t) => {
  const fixture = await harness(t, async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'resumed-session', model: 'sonnet' };
    yield stream({ type: 'message_start', message: { id: 'message-1' } });
    yield stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } });
    yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } });
    const full = { type: 'assistant', uuid: 'assistant-1', message: { id: 'message-1', content: [{ type: 'text', text: 'Hello world' }] } };
    yield full;
    yield full;
    yield success('Hello world', { session_id: 'resumed-session' });
  });
  const result = await fixture.run({ resumeSessionId: 'resumed-session', model: 'sonnet', effort: 'high' });
  assert.equal(fixture.events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'Hello world');
  assert.equal(fixture.state.options.resume, 'resumed-session');
  assert.equal(fixture.state.options.model, 'sonnet');
  assert.equal(fixture.state.options.effort, 'high');
  assert.equal(fixture.state.options.permissionMode, 'default');
  assert.equal(result.sessionId, 'resumed-session');
  assert.deepEqual(fixture.events.find((event) => event.type === 'usage').usage, {
    inputTokens: 10, outputTokens: 7, costUsd: 0.001, durationMs: 123,
  });
  assert.equal(fixture.events.at(-1).type, 'done');
  assert.equal(fixture.service.currentRun, null);
  assert.ok(fixture.state.closes >= 1);
});

test('an incomplete native stream preserves partial text and can resume on the same service', async t => {
  let requests = 0;
  const fixture = await harness(t, async function* (options) {
    requests += 1;
    if (requests === 1) {
      yield { type: 'system', subtype: 'init', session_id: 'interrupted-session' };
      yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Saved partial reply.' } });
      return;
    }
    assert.equal(options.resume, 'interrupted-session');
    yield success('Continued reply.', { session_id: 'interrupted-session' });
  });
  const result = await fixture.run();
  assert.equal(result.isError, true);
  assert.equal(result.sessionId, 'interrupted-session');
  assert.equal(result.result, 'Saved partial reply.');
  assert.equal(fixture.service.currentRun, null);
  assert.equal(fixture.events.filter(event => event.type === 'error').length, 1);
  assert.match(fixture.events.find(event => event.type === 'error').error, /连接已中断/);
  assert.deepEqual(fixture.events.at(-1), {
    type: 'done', result: 'Saved partial reply.', stopped: false, isError: true,
    sessionId: 'interrupted-session', runId: 'run-fixture',
  });
  const resumed = await fixture.run({ runId: 'resumed-run', resumeSessionId: result.sessionId });
  assert.equal(resumed.isError, false);
  assert.equal(resumed.result, 'Continued reply.');
  assert.equal(requests, 2, 'Incomplete tasks must wait for an explicit continuation');
  assert.equal(fixture.service.currentRun, null);
});

test('a confirmed empty native result succeeds and an error result emits only one error', async t => {
  let requests = 0;
  const fixture = await harness(t, async function* () {
    requests += 1;
    yield requests === 1 ? success('') : success('', {
      subtype: 'error_max_turns', is_error: true, errors: ['Fixture turn limit reached.'],
    });
  });
  assert.equal((await fixture.run()).isError, false);
  assert.equal(fixture.events.filter(event => event.type === 'error').length, 0);
  assert.equal((await fixture.run()).isError, true);
  assert.equal(fixture.events.filter(event => event.type === 'error').length, 1);
  assert.equal(fixture.events.at(-1).isError, true);
});

test('sends screenshot bytes as SDK image blocks while preserving text and resume', async (t) => {
  const fixture = await harness(t, async function* () { yield success('Image received.'); });
  const image = { mimeType: 'image/png', dataBase64: Buffer.from('fixture-image-bytes').toString('base64') };
  await fixture.run({ prompt: 'Inspect the screenshot.', inputImages: [image], resumeSessionId: 'existing-image-session' });
  assert.equal(typeof fixture.state.prompt[Symbol.asyncIterator], 'function');
  const messages = [];
  for await (const message of fixture.state.prompt) messages.push(message);
  assert.deepEqual(messages, [{ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
    { type: 'text', text: 'Inspect the screenshot.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.dataBase64 } },
  ] } }]);
  assert.equal(fixture.state.options.resume, 'existing-image-session');
  assert.equal(JSON.stringify(fixture.events).includes(image.dataBase64), false, 'Image payload must not appear in UI events');
  await assert.rejects(fixture.run({ inputImages: [{ mimeType: 'image/svg+xml', dataBase64: 'AAAA' }] }), /无效.*图片/);
});

test('workbench permission modes map to the canonical SDK modes without bypassing checks', async t => {
  const fixture = await harness(t, async function* () { yield success(); });
  for (const [permissionMode, sdkMode] of [['manual', 'default'], ['default', 'default'], ['acceptEdits', 'acceptEdits'], ['auto', 'auto'], ['plan', 'plan']]) {
    await fixture.run({ permissionMode });
    assert.equal(fixture.state.options.permissionMode, sdkMode);
    assert.equal(fixture.state.options.permissionPrompts, 'host');
    assert.equal(fixture.state.options.allowDangerouslySkipPermissions, undefined);
    assert.equal(typeof fixture.state.options.canUseTool, 'function');
  }
});

test('follow mode reloads provider settings and clears stale resumed model overrides', async (t) => {
  const fixture = await harness(t, async function* () { yield success(); });
  await fixture.run({ model: 'default' });
  assert.equal(fixture.state.options.model, 'default');
  assert.equal(fixture.state.options.env.ANTHROPIC_BASE_URL, 'https://fixture.invalid');
  assert.ok(fixture.state.options.settingSources.includes('user'));

  await writeFile(join(fixture.fixtureDirectory, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: fakeToken, ANTHROPIC_BASE_URL: 'https://switched.invalid', ANTHROPIC_MODEL: 'provider-model-id' },
  }));
  await fixture.run({ model: 'default', resumeSessionId: 'session-fixture' });
  assert.equal(fixture.state.options.model, 'provider-model-id');
  assert.equal(fixture.state.options.env.ANTHROPIC_BASE_URL, 'https://switched.invalid');
  assert.equal(fixture.state.options.env.ANTHROPIC_MODEL, 'provider-model-id');

  await fixture.run({ model: 'sonnet' });
  assert.equal(fixture.state.options.model, 'sonnet');
});

test('keeps slash commands intact while appending transferred history to the system preset', async (t) => {
  const fixture = await harness(t, async function* () { yield success(); });
  const historyContext = 'Previous conversation:\nUser: Review the project.\nAssistant: Found two issues.';
  for (const prompt of ['/compact preserve the two issues', '/init', '/custom-skill review']) {
    await fixture.run({ prompt, historyContext });
    assert.equal(fixture.state.prompt, prompt);
    assert.deepEqual(fixture.state.options.systemPrompt, { type: 'preset', preset: 'claude_code', append: historyContext });
  }
  for (const emptyHistory of [undefined, '', ' \n\t']) {
    await fixture.run({ prompt: '/init', historyContext: emptyHistory });
    assert.equal(fixture.state.prompt, '/init');
    assert.deepEqual(fixture.state.options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  }
});

test('Chrome opt-in saved by the command manager reaches the native Claude process', async t => {
  const fixture = await harness(t, async function* () { yield success(); });
  await writeFile(join(fixture.fixtureDirectory, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
  await fixture.run();
  assert.deepEqual(fixture.state.options.extraArgs, { chrome: null });
  await writeFile(join(fixture.fixtureDirectory, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: false }));
  await fixture.run();
  assert.equal(fixture.state.options.extraArgs, undefined);
});

test('workbench fast preference explicitly opts each SDK task in or out', async t => {
  const fixture = await harness(t, async function* () { yield success(); });
  await writeFile(join(fixture.fixtureDirectory, 'settings.json'), JSON.stringify({ fastMode: true }));
  await fixture.run();
  assert.deepEqual(fixture.state.options.settings, { fastMode: true });
  await mkdir(join(fixture.fixtureDirectory, '.claude'));
  await writeFile(join(fixture.fixtureDirectory, '.claude', 'settings.json'), JSON.stringify({ fastMode: false }));
  await fixture.run();
  assert.deepEqual(fixture.state.options.settings, { fastMode: true });
  await writeFile(join(fixture.fixtureDirectory, '.claude', 'settings.local.json'), JSON.stringify({ fastMode: true }));
  await fixture.run();
  assert.deepEqual(fixture.state.options.settings, { fastMode: true });
  await writeFile(join(fixture.fixtureDirectory, '.claude', 'settings.local.json'), JSON.stringify({ fastMode: false }));
  await fixture.run();
  assert.deepEqual(fixture.state.options.settings, { fastMode: true });
  await writeFile(join(fixture.fixtureDirectory, 'settings.json'), JSON.stringify({}));
  await writeFile(join(fixture.fixtureDirectory, '.claude', 'settings.local.json'), JSON.stringify({ fastMode: true }));
  await fixture.run();
  assert.deepEqual(fixture.state.options.settings, { fastMode: false });
});

test('a provider switch before SDK initialization never sends an old-channel model', async t => {
  const fixture = await harness(t, async function* () { yield success(); });
  const result = await fixture.run({ model: 'old-channel-model', expectedProviderKey: 'previous-provider-fingerprint' });
  assert.equal(result.isError, true);
  assert.equal(fixture.state.options, null);
  assert.match(fixture.events.find(event => event.type === 'error').error, /渠道刚刚发生变化/);
  assert.equal(JSON.stringify(fixture.events).includes(fakeToken), false);
});

test('routes allow, deny, and user answers through canUseTool', async (t) => {
  const decisions = [];
  const fixture = await harness(t, async function* (options) {
    decisions.push(await options.canUseTool('Write', { file_path: 'example.txt', content: 'example' }, { requestId: 'allow' }));
    decisions.push(await options.canUseTool('Bash', { command: 'example-command' }, { requestId: 'deny' }));
    decisions.push(await options.canUseTool('AskUserQuestion', {
      questions: [{ question: 'Which format?', options: [{ label: 'JSON' }, { label: 'CSV' }] }],
    }, { requestId: 'question', toolUseID: 'question-tool' }));
    decisions.push(await options.canUseTool('AskUserQuestion', {
      questions: [{ question: 'Unanswered question?' }],
    }, { requestId: 'unanswered', toolUseID: 'unanswered-tool' }));
    yield success();
  }, (permission, service) => {
    const answers = permission.id === 'question' ? { 'Which format?': ['JSON', 'CSV'] } : {};
    service.respondPermission({ id: permission.id, decision: permission.id === 'deny' ? 'deny' : 'allow', answers });
  });
  await fixture.run();
  assert.equal(decisions[0].behavior, 'allow');
  assert.deepEqual(decisions[0].updatedInput, { file_path: 'example.txt', content: 'example' });
  assert.equal(decisions[1].behavior, 'deny');
  assert.equal(decisions[2].updatedInput.answers['Which format?'], 'JSON, CSV');
  assert.equal(decisions[3].behavior, 'deny');
  assert.equal(fixture.service.pendingPermissions.size, 0);
  assert.equal(fixture.service.respondPermission({ id: 'expired', decision: 'allow' }), false);
});

for (const permissionMode of ['auto', 'manual', 'acceptEdits']) {
  test(`${permissionMode}: hooks require human answers and plan approval without duplicate prompts`, async (t) => {
    const hookResults = [];
    const callbackResults = [];
    const fixture = await harness(t, async function* (options) {
      const questionInput = {
        hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
        tool_input: { questions: [{ question: 'Choose a language?', options: [{ label: 'Chinese' }] }] },
      };
      hookResults.push(await options.hooks.PreToolUse[0].hooks[0](questionInput, 'ask-1', {}));
      callbackResults.push(await options.canUseTool('AskUserQuestion', questionInput.tool_input, { toolUseID: 'ask-1' }));
      const exitInput = {
        hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'plan-1',
        tool_input: { plan: 'A fixture plan.' },
      };
      hookResults.push(await options.hooks.PreToolUse[0].hooks[0](exitInput, 'plan-1', {}));
      callbackResults.push(await options.canUseTool('ExitPlanMode', exitInput.tool_input, { toolUseID: 'plan-1' }));
      yield success();
    }, (permission, service) => {
      service.respondPermission({
        id: permission.id,
        decision: permission.toolName === 'ExitPlanMode' ? 'deny' : 'allow',
        answers: { 'Choose a language?': 'Chinese' },
      });
    });
    await fixture.run({ permissionMode });
    assert.equal(fixture.events.filter((event) => event.type === 'permission').length, 2);
    assert.deepEqual(hookResults[0].hookSpecificOutput, {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
      permissionDecisionReason: 'Approved by the user in the desktop panel.',
      updatedInput: {
        questions: [{ question: 'Choose a language?', options: [{ label: 'Chinese' }] }],
        answers: { 'Choose a language?': 'Chinese' },
      },
    });
    assert.equal(hookResults[1].hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(callbackResults[0].updatedInput.answers['Choose a language?'], 'Chinese');
    assert.equal(callbackResults[1].behavior, 'deny');
    assert.equal(fixture.events.filter((event) => event.type === 'beforeTool').length, 2);
  });
}

test('tool hooks bracket execution and report failure status', async (t) => {
  const order = [];
  const fixture = await harness(t, async function* (options) {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'example.txt', content: 'example' } };
    assert.deepEqual(await options.hooks.PreToolUse[0].hooks[0](input, 'tool-1'), {});
    order.push('execute');
    await options.hooks.PostToolUseFailure[0].hooks[0]({ ...input, error: 'Fixture failure.' }, 'tool-1');
    yield success();
  });
  const original = fixture.service.onEvent;
  fixture.service.onEvent = async (event) => {
    if (event.type === 'beforeTool' || event.type === 'afterTool') order.push(event.type);
    await original(event);
  };
  await fixture.run();
  assert.deepEqual(order, ['beforeTool', 'execute', 'afterTool']);
  const toolEvents = fixture.events.filter((event) => event.type === 'tool');
  assert.equal(toolEvents[0].tool.status, 'running');
  assert.equal(toolEvents.at(-1).tool.status, 'error');
  assert.equal(toolEvents.at(-1).tool.output, 'Fixture failure.');
});

test('stop denies pending interactive hooks and releases the task', { timeout: 5000 }, async (t) => {
  let notifyPermission;
  const permissionSeen = new Promise((resolveSeen) => { notifyPermission = resolveSeen; });
  let hookResult;
  const fixture = await harness(t, async function* (options) {
    hookResult = await options.hooks.PreToolUse[0].hooks[0]({
      tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Continue?' }] },
    }, 'pending-question', { signal: options.abortController.signal });
    if (options.abortController.signal.aborted) throw new Error('Aborted fixture.');
    yield success();
  }, () => { notifyPermission(); });
  const task = fixture.run({ permissionMode: 'auto' });
  await permissionSeen;
  assert.equal(fixture.service.pendingPermissions.size, 1);
  assert.equal(fixture.service.stop(), true);
  const result = await task;
  assert.equal(hookResult.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.stopped, true);
  assert.equal(fixture.service.pendingPermissions.size, 0);
  assert.equal(fixture.service.currentRun, null);
  assert.equal(fixture.events.filter((event) => event.type === 'error').length, 0);
  assert.equal(fixture.events.at(-1).stopped, true);
  assert.equal(fixture.service.stop(), false);
});

test('keeps credentials on the host even when text streams across secret boundaries', async (t) => {
  const fixture = await harness(t, async function* (options) {
    assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, fakeToken);
    yield stream({ type: 'message_start', message: { id: 'secret-message' } });
    yield stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const text of ['Value: ', fakeToken.slice(0, 5), fakeToken.slice(5, 15), fakeToken.slice(15), '.']) {
      yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
    yield { type: 'assistant', uuid: 'secret-assistant', message: { id: 'secret-message', content: [{ type: 'text', text: `Value: ${fakeToken}.` }] } };
    yield success(`Value: ${fakeToken}.`);
  });
  const result = await fixture.run();
  const visibleText = fixture.events.filter((event) => event.type === 'text').map((event) => event.text).join('');
  assert.equal(visibleText, 'Value: [REDACTED].');
  assert.ok(!JSON.stringify(fixture.events).includes(fakeToken));
  assert.ok(!JSON.stringify(result).includes(fakeToken));
  assert.equal(fixture.state.options.env.CLAUDE_CONFIG_DIR, fixture.fixtureDirectory);
  assert.equal(fixture.state.options.env.TEMP, join(fixture.fixtureDirectory, 'temp'));
  assert.equal(fixture.state.options.env.DISABLE_UPDATES, '1');
});

for (const completed of [false, true]) {
  test(`conceals trailing credential fragments when the native stream ${completed ? 'completes' : 'disconnects'}`, async t => {
    const fragment = fakeToken.slice(0, 18);
    const fixture = await harness(t, async function* () {
      yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Value: ${fragment}` } });
      if (completed) yield success(`Value: ${fragment}`);
    });
    const result = await fixture.run();
    assert.equal(result.isError, !completed);
    assert.equal(result.result, 'Value: [REDACTED]');
    assert.equal(fixture.events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Value: [REDACTED]');
    assert.equal(fixture.events.at(-1).result, 'Value: [REDACTED]');
    assert.equal(JSON.stringify({ events: fixture.events, result }).includes(fragment), false);
  });
}

test('a failed trailing text notification still releases the service and attempts done', async t => {
  let requests = 0;
  const fixture = await harness(t, async function* () {
    requests += 1;
    if (requests === 1) {
      yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fakeToken.slice(0, 18) } });
      return;
    }
    yield success();
  });
  const original = fixture.service.onEvent;
  fixture.service.onEvent = async event => {
    await original(event);
    if (requests === 1 && event.type === 'text') throw new Error('Fixture notification failure.');
  };
  await assert.rejects(fixture.run(), /Fixture notification failure/);
  assert.equal(fixture.service.currentRun, null);
  assert.equal(fixture.service.pendingPermissions.size, 0);
  assert.equal(fixture.events.at(-1).type, 'done');
  assert.equal(fixture.events.at(-1).isError, true);
  assert.equal((await fixture.run()).isError, false);
  assert.equal(fixture.service.currentRun, null);
});
