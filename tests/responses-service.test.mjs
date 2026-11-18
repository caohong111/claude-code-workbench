import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { ResponsesService } from '../electron/responses-service.mjs';
import { providerRequestKey } from '../electron/provider-config.mjs';

const testRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp');
const token = 'fixture-direct-private-token-123456789';
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
const imageItem = (result = imageBase64, overrides = {}) => ({ type: 'image_generation_call', id: 'image-1', status: 'completed', result, ...overrides });
const textItem = (text, id = 'message-1') => ({ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] });
const callItem = (name, args, id = 'call-1') => ({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const complete = output => ({ type: 'response.completed', response: { id: 'resp-fixture', status: 'completed', output, usage: { input_tokens: 13, output_tokens: 4, input_tokens_details: { cached_tokens: 5 } } } });

function largePngFixture() {
  function chunk(type, bytes) {
    const data = Buffer.concat([Buffer.from(type, 'ascii'), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, data, checksum]);
  }
  const width = 640;
  const height = 640;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  let random = 0x12345678;
  for (let row = 0; row < height; row++) {
    const offset = row * (width * 4 + 1);
    for (let column = 1; column <= width * 4; column++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      pixels[offset + column] = random & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sse(events, fragmentSize = 17) {
  const data = new TextEncoder().encode(events.map(value => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < data.length; index += fragmentSize) controller.enqueue(data.slice(index, index + fragmentSize));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t, scenario = () => sse([complete([textItem('Finished.')])]), options = {}) {
  await fs.mkdir(testRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(testRoot, 'direct-responses-'));
  const configDirectory = path.join(directory, 'config');
  await fs.mkdir(configDirectory);
  const settings = { env: { ANTHROPIC_BASE_URL: 'https://relay.invalid', ANTHROPIC_AUTH_TOKEN: token } };
  await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify(settings));
  const events = [];
  const requests = [];
  let onEvent;
  const service = new ResponsesService({
    configDirectory, cacheDirectory: path.join(directory, 'cache'), environment: {},
    fetchImpl: async (url, request) => { const entry = { url, request, body: JSON.parse(request.body) }; requests.push(entry); return scenario(entry, service); },
    onEvent: async event => { events.push(event); await onEvent?.(event); }, ...options,
  });
  t.after(async () => { service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, settings, directory, configDirectory, events, requests,
    set onEvent(callback) { onEvent = callback; },
    saveSettings: () => fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify(settings)),
    run: overrides => service.run({ cwd: directory, prompt: 'Read this folder.', model: 'gpt-6.1-sol', ...overrides }),
  };
}

test('posts directly to the configured Responses API and streams UTF-8 text once without Codex', async t => {
  const f = await fixture(t, () => sse([
    { type: 'response.output_text.delta', item_id: 'message-1', delta: '你好 ' },
    { type: 'response.output_text.delta', item_id: 'message-1', delta: 'world' },
    { type: 'response.output_text.done', item_id: 'message-1', text: '你好 world' },
    complete([textItem('你好 world')]),
  ], 3));
  const result = await f.run({ effort: 'max' });
  assert.equal(result.result, '你好 world');
  assert.match(result.sessionId, /^direct-/);
  assert.equal(result.isError, false);
  assert.equal(f.events.filter(event => event.type === 'text').map(event => event.text).join(''), '你好 world');
  assert.equal(f.events.find(event => event.type === 'session').engine, 'responses');
  assert.deepEqual(f.events.find(event => event.type === 'usage').usage, { inputTokens: 13, outputTokens: 4, cachedInputTokens: 5 });
  const { url, request, body } = f.requests[0];
  assert.equal(url, 'https://relay.invalid/v1/responses');
  assert.equal(request.headers.Authorization, `Bearer ${token}`);
  assert.equal(request.redirect, 'error');
  assert.equal(body.model, 'gpt-6.1-sol');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.previous_response_id, undefined);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(body.reasoning.effort, 'xhigh');
  assert.match(body.instructions, /provided workspace tools/);
  assert.equal(body.tools.length, 7);
  assert.equal(JSON.stringify(body).includes(token), false);
  assert.equal(JSON.stringify(f.events).includes(token), false);
  assert.equal(f.service.currentRun, null);
  const files = await fs.readdir(path.join(f.directory, 'cache', 'direct-responses'));
  assert.deepEqual(files, [`${result.sessionId}.json`]);
});

test('normalizes root, v1, proxy-prefix and full Responses endpoints without changing origins', async t => {
  const f = await fixture(t);
  for (const [base, expected] of [
    ['https://relay.invalid/', 'https://relay.invalid/v1/responses'],
    ['https://relay.invalid/v1/', 'https://relay.invalid/v1/responses'],
    ['https://relay.invalid/proxy', 'https://relay.invalid/proxy/v1/responses'],
    ['https://relay.invalid/custom/responses/', 'https://relay.invalid/custom/responses'],
  ]) {
    f.settings.env.ANTHROPIC_BASE_URL = base;
    await f.saveSettings();
    assert.equal((await f.run()).isError, false);
    assert.equal(f.requests.at(-1).url, expected);
  }
});

test('resumes local stateless history across channel and model changes including encrypted reasoning', async t => {
  let count = 0;
  const reasoning = { type: 'reasoning', id: 'reason-1', summary: [], encrypted_content: 'encrypted-reasoning-fixture' };
  const f = await fixture(t, () => ++count === 1 ? sse([complete([reasoning, textItem('FIRST_REPLY')])]) : sse([complete([textItem('SECOND_REPLY', 'message-2')])]));
  const first = await f.run({ prompt: 'FIRST_TASK' });
  f.settings.env.ANTHROPIC_BASE_URL = 'https://second.invalid/v1';
  f.settings.env.ANTHROPIC_AUTH_TOKEN = 'second-private-fixture-key';
  await f.saveSettings();
  const second = await f.run({ resumeSessionId: first.sessionId, model: 'gpt-5.6-sol', prompt: 'SECOND_TASK' });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(f.requests[1].url, 'https://second.invalid/v1/responses');
  assert.equal(f.requests[1].request.headers.Authorization, 'Bearer second-private-fixture-key');
  const input = f.requests[1].body.input;
  assert.equal(input[0].content[0].text, 'FIRST_TASK');
  assert.deepEqual(input[1], reasoning);
  assert.equal(input[2].content[0].text, 'FIRST_REPLY');
  assert.equal(input[3].content[0].text, 'SECOND_TASK');
  const stored = JSON.parse(await fs.readFile(path.join(f.directory, 'cache', 'direct-responses', `${first.sessionId}.json`), 'utf8'));
  assert.equal(stored.input.at(-1).content[0].text, 'SECOND_REPLY');
  assert.equal(JSON.stringify(stored).includes(token), false);
});

test('executes function tools inside the workbench and feeds approved workspace writes back to the API', async t => {
  let f;
  let count = 0;
  const reasoning = { type: 'reasoning', id: 'reason-tool', summary: [], encrypted_content: 'encrypted-tool-state' };
  f = await fixture(t, () => {
    count++;
    if (count === 1) return sse([complete([reasoning, callItem('Write', { file_path: 'created.txt', content: 'WORKBENCH_WRITE' })])]);
    return sse([complete([textItem('WRITE_OK')])]);
  });
  f.onEvent = event => {
    if (event.type === 'permission') {
      assert.equal(event.permission.toolName, 'Write');
      assert.equal(f.service.respondPermission({ id: event.permission.id, decision: 'allow' }), true);
    }
  };
  const result = await f.run();
  assert.equal(result.result, 'WRITE_OK');
  assert.equal(await fs.readFile(path.join(f.directory, 'created.txt'), 'utf8'), 'WORKBENCH_WRITE');
  assert.deepEqual(f.requests[1].body.input[1], reasoning);
  const output = f.requests[1].body.input.at(-1);
  assert.equal(output.type, 'function_call_output');
  assert.equal(output.call_id, 'call-1');
  assert.match(output.output, /created.txt/);
  assert.equal(f.events.filter(event => event.type === 'beforeTool').length, 1);
  assert.equal(f.events.filter(event => event.type === 'afterTool').length, 1);
  assert.equal(f.service.pendingPermissions.size, 0);
});

test('routes user questions and denied commands through the panel permission API', async t => {
  let count = 0;
  const f = await fixture(t, () => {
    count++;
    if (count === 1) return sse([complete([callItem('AskUserQuestion', { questions: [{ question: 'Which folder?', header: 'Folder', options: [{ label: 'Source', description: 'Project source' }] }] }, 'question-1')])]);
    if (count === 2) return sse([complete([callItem('Bash', { command: 'Write-Output DO_NOT_EXECUTE' }, 'command-1')])]);
    return sse([complete([textItem('DECISIONS_OK')])]);
  });
  f.onEvent = event => {
    if (event.type !== 'permission') return;
    const question = event.permission.toolName === 'AskUserQuestion';
    if (question) assert.equal(event.permission.questions[0].question, 'Which folder?');
    assert.equal(f.service.respondPermission({ id: event.permission.id, decision: question ? 'allow' : 'deny', answers: { 'Which folder?': 'Source' } }), true);
  };
  assert.equal((await f.run()).result, 'DECISIONS_OK');
  assert.match(f.requests[1].body.input.at(-1).output, /Source/);
  assert.match(f.requests[2].body.input.at(-1).output, /declined|拒绝/);
  assert.equal(f.events.filter(event => event.type === 'permission').length, 2);
});

test('plan mode exposes only inspection tools and still rejects a fabricated mutation call', async t => {
  let count = 0;
  const f = await fixture(t, () => ++count === 1 ? sse([complete([callItem('Write', { file_path: 'forbidden.txt', content: 'NO' })])]) : sse([complete([textItem('PLAN_OK')])]));
  const result = await f.run({ permissionMode: 'plan' });
  assert.equal(result.result, 'PLAN_OK');
  assert.deepEqual(f.requests[0].body.tools.map(tool => tool.name), ['Read', 'Glob', 'Grep', 'AskUserQuestion']);
  assert.match(f.requests[0].body.instructions, /Planning mode/);
  assert.equal(await fs.stat(path.join(f.directory, 'forbidden.txt')).then(() => true, () => false), false);
  assert.match(f.requests[1].body.input.at(-1).output, /计划|plan|只读/);
});

test('redacts credentials across text chunks, error bodies and saved history without retrying', async t => {
  let count = 0;
  const f = await fixture(t, () => {
    count++;
    if (count === 1) return sse([
      { type: 'response.output_text.delta', item_id: 'message-1', delta: `hidden ${token.slice(0, 16)}` },
      { type: 'response.output_text.delta', item_id: 'message-1', delta: token.slice(16) },
      complete([textItem(`hidden ${token}`)]),
    ]);
    return new Response(JSON.stringify({ error: { message: `Gateway refused ${token}` } }), { status: 403, headers: { 'content-type': 'application/json' } });
  });
  const first = await f.run();
  const second = await f.run({ resumeSessionId: first.sessionId });
  assert.equal(second.isError, true);
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.stringify(f.events).includes(token), false);
  assert.equal(JSON.stringify(first).includes(token), false);
  assert.match(f.events.filter(event => event.type === 'text').map(event => event.text).join(''), /密钥已隐藏/);
  assert.match(f.events.find(event => event.type === 'error').error, /HTTP 403/);
  const saved = await fs.readFile(path.join(f.directory, 'cache', 'direct-responses', `${first.sessionId}.json`), 'utf8');
  assert.equal(saved.includes(token), false);
});

test('reports incomplete, invalid and interrupted streams instead of silently accepting partial replies', async t => {
  for (const events of [
    [{ type: 'response.incomplete', response: { status: 'incomplete' } }],
    [{ type: 'response.failed', response: { error: { message: 'Fixture failure' } } }],
    [{ type: 'response.output_text.delta', item_id: 'message-1', delta: 'partial' }],
  ]) {
    const f = await fixture(t, () => sse(events));
    assert.equal((await f.run()).isError, true);
    assert.equal(f.events.filter(event => event.type === 'error').length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.service.currentRun, null);
  }
});

test('stop cancels the HTTP stream and releases the running task', async t => {
  let observed;
  const waiting = new Promise(resolve => { observed = resolve; });
  let cancelled = false;
  const f = await fixture(t, ({ request }) => new Response(new ReadableStream({
    start(controller) {
      request.signal.addEventListener('abort', () => { cancelled = true; controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
      observed();
    }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const pending = f.run();
  await waiting;
  assert.equal(f.service.stop(), true);
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(result.isError, false);
  assert.equal(cancelled, true);
  assert.equal(f.service.currentRun, null);
  assert.equal(f.events.filter(event => event.type === 'error').length, 0);
});

test('stop denies pending workspace approvals without writing the requested file', async t => {
  let observed;
  const waiting = new Promise(resolve => { observed = resolve; });
  const f = await fixture(t, () => sse([complete([callItem('Write', { file_path: 'cancelled.txt', content: 'NO' })])]));
  f.onEvent = event => { if (event.type === 'permission') observed(); };
  const pending = f.run();
  await waiting;
  assert.equal(f.service.stop(), true);
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(f.service.pendingPermissions.size, 0);
  assert.equal(await fs.stat(path.join(f.directory, 'cancelled.txt')).then(() => true, () => false), false);
  assert.equal(f.requests.length, 1);
});

test('times out a stalled request and rejects changed providers before sending HTTP', async t => {
  const f = await fixture(t, ({ request }) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })), { requestTimeoutMs: 20 });
  assert.equal((await f.run()).isError, true);
  assert.match(f.events.find(event => event.type === 'error').error, /超时/);
  const before = f.requests.length;
  assert.equal((await f.run({ expectedProviderKey: providerRequestKey({ ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_AUTH_TOKEN: token }) })).isError, true);
  assert.equal(f.requests.length, before);
  assert.match(f.events.filter(event => event.type === 'error').at(-1).error, /渠道刚刚发生变化/);
});

test('does not lose context silently when a local resumed session is missing', async t => {
  const f = await fixture(t);
  const result = await f.run({ resumeSessionId: 'direct-00000000-0000-0000-0000-000000000001' });
  assert.equal(result.isError, true);
  assert.equal(f.requests.length, 0);
  assert.match(f.events.find(event => event.type === 'error').error, /本地记录无法读取/);
  const old = await f.run({ resumeSessionId: 'legacy-codex-thread-id' });
  assert.equal(old.isError, false);
  assert.match(old.sessionId, /^direct-/);
});

test('supports JSON-only responses and sends malformed tool arguments back as a tool error', async t => {
  let count = 0;
  const f = await fixture(t, () => {
    count++;
    if (count === 1) return sse([complete([callItem('Write', '{broken')])]);
    return new Response(JSON.stringify({ status: 'completed', output: [textItem('JSON_OK')] }), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal((await f.run()).result, 'JSON_OK');
  assert.match(f.requests[1].body.input.at(-1).output, /Invalid tool arguments/);
  assert.equal(f.events.filter(event => event.type === 'permission').length, 0);
});

test('invalid endpoints are rejected before any key-bearing network request', async t => {
  const f = await fixture(t);
  for (const base of ['https://user:pass@relay.invalid', 'https://relay.invalid/?token=private', 'file:///D:/fixture']) {
    f.settings.env.ANTHROPIC_BASE_URL = base;
    await f.saveSettings();
    assert.equal((await f.run()).isError, true);
  }
  assert.equal(f.requests.length, 0);
});

test('explicit image generation calls the real image tool and saves a bitmap with functional local links', async t => {
  const f = await fixture(t, () => sse([complete([imageItem()])]));
  const result = await f.run({ prompt: 'Generate a forest image.', imageGeneration: true });
  assert.equal(result.isError, false);
  assert.deepEqual(f.requests[0].body.tools, [{ type: 'image_generation', model: 'gpt-image-2' }]);
  assert.deepEqual(f.requests[0].body.tool_choice, { type: 'image_generation' });
  assert.match(f.requests[0].request.headers['X-Codex-Image-Turn-Id'], /^[a-f0-9-]{36}$/);
  assert.match(f.requests[0].body.instructions, /real bitmap/);
  const image = f.events.find(event => event.type === 'image').image;
  assert.equal(image.mimeType, 'image/png');
  assert.equal(path.dirname(image.path), path.join(f.directory, 'generated-images'));
  assert.deepEqual(await fs.readFile(image.path), Buffer.from(imageBase64, 'base64'));
  assert.match(result.result, /!\[生成图片 1\]/);
  assert.match(result.result, /\[打开原图\]/);
  assert.match(result.result, /\[下载原图\]/);
  assert.ok(result.result.includes(image.path.split(path.sep).join('/')));
  const history = await fs.readFile(path.join(f.directory, 'cache', 'direct-responses', `${result.sessionId}.json`), 'utf8');
  assert.equal(history.includes(imageBase64), false);
  assert.equal(history.includes('image_generation_call'), false);
  assert.equal(JSON.stringify(f.events).includes(imageBase64), false);
  assert.ok(history.includes('生成图片'));
  await f.run({ imageGeneration: true });
  assert.notEqual(f.requests[0].request.headers['X-Codex-Image-Turn-Id'], f.requests[1].request.headers['X-Codex-Image-Turn-Id']);
});

test('input images are sent as real image parts and resumed from bounded binary cache without base64 history', async t => {
  const f = await fixture(t);
  const first = await f.run({ inputImages: [{ mimeType: 'image/png', dataBase64: imageBase64, name: 'screenshot.png' }] });
  assert.equal(first.isError, false);
  assert.deepEqual(f.requests[0].body.input[0].content[1], { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` });
  assert.equal(f.requests[0].body.tools.length, 7);
  assert.equal(f.requests[0].request.headers['X-Codex-Image-Turn-Id'], undefined);
  const history = await fs.readFile(path.join(f.directory, 'cache', 'direct-responses', `${first.sessionId}.json`), 'utf8');
  assert.equal(history.includes(imageBase64), false);
  const stored = JSON.parse(history);
  const reference = stored.input[0].content[1];
  assert.equal(reference.type, 'workbench_input_image');
  assert.match(reference.attachmentId, /^[a-f0-9]{64}\.png$/);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'cache', 'direct-responses', 'attachments', reference.attachmentId)), Buffer.from(imageBase64, 'base64'));
  const second = await f.run({ resumeSessionId: first.sessionId, prompt: 'What did you see in that screenshot?' });
  assert.equal(second.isError, false);
  assert.deepEqual(f.requests[1].body.input[0].content[1], f.requests[0].body.input[0].content[1]);
});

test('rejects malformed, mismatched and excessive input images before requesting the model', async t => {
  const f = await fixture(t);
  for (const inputImages of [
    [{ mimeType: 'image/png', dataBase64: 'not-a-valid-image' }],
    [{ mimeType: 'image/jpeg', dataBase64: imageBase64 }],
    [{ mimeType: 'image/svg+xml', dataBase64: Buffer.from('<svg/>').toString('base64') }],
    Array.from({ length: 5 }, () => ({ mimeType: 'image/png', dataBase64: imageBase64 })),
  ]) assert.equal((await f.run({ inputImages })).isError, true);
  assert.equal(f.requests.length, 0);
});

test('does not silently drop missing or tampered image references on continuation', async t => {
  const f = await fixture(t);
  const first = await f.run({ inputImages: [{ mimeType: 'image/png', dataBase64: imageBase64 }] });
  const directory = path.join(f.directory, 'cache', 'direct-responses', 'attachments');
  const [name] = await fs.readdir(directory);
  await fs.writeFile(path.join(directory, name), 'CORRUPTED');
  assert.equal((await f.run({ resumeSessionId: first.sessionId })).isError, true);
  assert.equal(f.requests.length, 1);
  assert.match(f.events.filter(event => event.type === 'error').at(-1).error, /图片/);
});

test('image generation rejects descriptions, unfinished images and disguised SVG instead of claiming success', async t => {
  for (const output of [
    [textItem('Here is a picture description.')],
    [imageItem(imageBase64, { status: 'in_progress' })],
    [imageItem(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'))],
    [imageItem('%%%')],
    [imageItem(), callItem('Write', { file_path: 'not-an-image.svg', content: '<svg/>' })],
  ]) {
    const f = await fixture(t, () => sse([complete(output)]));
    assert.equal((await f.run({ imageGeneration: true })).isError, true);
    assert.equal(f.requests.length, 1);
    assert.equal(f.events.filter(event => event.type === 'image').length, 0);
    assert.equal(await fs.stat(path.join(f.directory, 'generated-images')).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(f.directory, 'not-an-image.svg')).then(() => true, () => false), false);
  }
});

test('image API permission and unavailable-service failures explain the gateway setting without retrying or leaking keys', async t => {
  for (const [status, hint] of [[403, /分组.*图片生成权限/], [503, /没有可用的生图服务/]]) {
    const f = await fixture(t, () => new Response(JSON.stringify({ error: { message: `Fixture image failure ${token}` } }), { status, headers: { 'content-type': 'application/json' } }));
    assert.equal((await f.run({ imageGeneration: true })).isError, true);
    assert.equal(f.requests.length, 1);
    assert.match(f.events.find(event => event.type === 'error').error, hint);
    assert.equal(JSON.stringify(f.events).includes(token), false);
  }
});

test('supports JSON image responses and streaming output-item completion without duplicate image saves', async t => {
  for (const scenario of [
    () => new Response(JSON.stringify({ status: 'completed', output: [imageItem()] }), { headers: { 'content-type': 'application/json' } }),
    () => sse([{ type: 'response.output_item.done', output_index: 0, item: imageItem() }, { type: 'response.completed', response: { status: 'completed' } }]),
  ]) {
    const f = await fixture(t, scenario);
    assert.equal((await f.run({ imageGeneration: true, imageModel: 'provider-image-model' })).isError, false);
    assert.equal(f.requests[0].body.tools[0].model, 'provider-image-model');
    assert.equal(f.events.filter(event => event.type === 'image').length, 1);
    assert.equal((await fs.readdir(path.join(f.directory, 'generated-images'))).length, 1);
  }
});

test('plan mode and invalid image model settings cannot make paid image requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.run({ imageGeneration: true, permissionMode: 'plan' })).isError, true);
  assert.equal((await f.run({ imageGeneration: true, imageModel: '' })).isError, true);
  assert.equal((await f.run({ imageGeneration: true, imageSize: 'unsupported' })).isError, true);
  assert.equal(f.requests.length, 0);
});

test('large image inputs and outputs bypass the text length bound without truncation or corrupting binary data', async t => {
  const data = largePngFixture();
  assert.ok(data.length > 1024 * 1024, 'A valid PNG larger than 1 MiB must exercise the binary path');
  const encoded = data.toString('base64');
  assert.ok(encoded.length > 200000);
  const f = await fixture(t, () => new Response(JSON.stringify({ status: 'completed', output: [imageItem(encoded)] }), { headers: { 'content-type': 'application/json' } }));
  const result = await f.run({ imageGeneration: true, imageSize: '1024x1024', inputImages: [{ mimeType: 'image/png', dataBase64: encoded }] });
  assert.equal(result.isError, false);
  assert.equal(f.requests[0].body.tools[0].size, '1024x1024');
  assert.equal(f.requests[0].body.input[0].content[1].image_url, `data:image/png;base64,${encoded}`);
  assert.deepEqual(await fs.readFile(f.events.find(event => event.type === 'image').image.path), data);
  assert.ok(result.result.length < 200000);
  const saved = await fs.readFile(path.join(f.directory, 'cache', 'direct-responses', `${result.sessionId}.json`), 'utf8');
  assert.ok(saved.length < 10000);
  assert.equal(saved.includes(encoded), false);
  assert.equal(JSON.stringify(f.events).includes(encoded), false);
});

test('generated images cannot escape through an existing workspace directory junction', async t => {
  const f = await fixture(t, () => sse([complete([imageItem()])]));
  const outside = await fs.mkdtemp(path.join(testRoot, 'image-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(f.directory, 'generated-images'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.run({ imageGeneration: true })).isError, true);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(f.events.filter(event => event.type === 'image').length, 0);
});
