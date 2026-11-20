import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const root = path.resolve('.');
const isolated = path.join(TEST_ROOT, `desktop-media-${randomUUID()}`);
const workspace = path.join(isolated, 'workspace');
const configDirectory = path.join(isolated, 'config');
const outputDirectory = path.join(root, 'output', 'media-check');
const downloads = path.join(isolated, 'downloads');
const credential = 'fixture-media-private-token';
const requests = [];
const serverErrors = [];
const rendererErrors = [];
const svgNames = ['车机APP概念图.svg', '车机 APP #概念图.svg'];
let imageBase64;
let probeCount = 0;
let svgSource;
let svgMarkdown;
let application;

const textItem = (text) => ({ type: 'message', id: randomUUID(), role: 'assistant', content: [{ type: 'output_text', text }] });
function complete(response, output) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const value = { type: 'response.completed', response: { id: randomUUID(), status: 'completed', output, usage: { input_tokens: 50, output_tokens: 20 } } };
  response.end(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/svg-probe') { probeCount++; response.end('probe'); return; }
    if (request.method === 'GET' && pathname.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-fixture-media', display_name: 'GPT Media Fixture' }], has_more: false }));
      return;
    }
    assert.equal(request.method, 'POST');
    assert.ok(['/responses', '/v1/responses'].includes(pathname), `Unexpected path: ${pathname}`);
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, 'gpt-fixture-media');
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(JSON.stringify(body).includes(credential), false);
    const user = body.input.findLast((item) => item.role === 'user');
    const text = user.content.filter((item) => item.type === 'input_text').map((item) => item.text).join('\n');
    requests.push({ body, user, headers: request.headers });
    if (text.includes('MEDIA_PASTE')) {
      const images = user.content.filter((item) => item.type === 'input_image');
      assert.equal(images.length, 1, 'A screenshot must be sent as image input, not just a file path');
      assert.match(images[0].image_url, /^data:image\/png;base64,/);
      assert.equal(Buffer.from(images[0].image_url.split(',')[1], 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(body.tools.some((tool) => tool.type === 'image_generation'), false);
      complete(response, [textItem('MEDIA_PASTE_OK：已收到截图和正常粘贴的文字。')]);
    } else if (text.includes('MEDIA_GENERATE')) {
      assert.deepEqual(body.tool_choice, { type: 'image_generation' });
      assert.deepEqual(body.tools, [{ type: 'image_generation', model: 'gpt-image-2' }]);
      assert.match(request.headers['x-codex-image-turn-id'], /^[a-f0-9-]{36}$/i);
      complete(response, [textItem('MEDIA_GENERATE_OK'), { type: 'image_generation_call', id: randomUUID(), status: 'completed', result: imageBase64 }]);
    } else if (text.includes('MEDIA_SVG')) {
      assert.equal(body.tools.some((tool) => tool.type === 'image_generation'), false);
      complete(response, [textItem(svgMarkdown)]);
    } else throw new Error('Unexpected media fixture task');
  } catch (error) {
    serverErrors.push(error.message);
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Media fixture request validation failed' } }));
  }
});

await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(configDirectory, { recursive: true });
await fs.mkdir(downloads, { recursive: true });
await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(path.join(workspace, 'README.md'), '# Media fixture workspace\n');
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
svgSource = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240" onload="parent.postMessage('MEDIA_SVG_EXECUTED','*');fetch('${address}/svg-probe')"><script><![CDATA[parent.postMessage('MEDIA_SVG_EXECUTED','*');fetch('${address}/svg-probe');]]></script><rect width="480" height="240" fill="#153d43"/><rect x="24" y="24" width="432" height="192" rx="8" fill="#75c9af"/><circle cx="120" cy="120" r="52" fill="#f2d58d"/><text x="208" y="132" fill="#123d3b" font-size="32">SVG MEDIA</text></svg>`;
for (const name of svgNames) await fs.writeFile(path.join(workspace, name), svgSource);
svgMarkdown = [
  `![SVG 中文图片](./${encodeURIComponent(svgNames[1])})`,
  `[打开 Windows SVG 原图](<${path.join(workspace, svgNames[0])}>)`,
  `[打开相对 SVG 原图](./${svgNames[0]})`,
  `[下载中文编码 SVG 原图](./${encodeURIComponent(svgNames[1])})`,
  `[打开文件 URL SVG 原图](${pathToFileURL(path.join(workspace, svgNames[1])).href})`,
  '[打开缺失 SVG 原图](./不存在的原图.svg)',
].join('\n\n');
await fs.writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: address, ANTHROPIC_AUTH_TOKEN: credential } }));
const env = {
  ...process.env,
  CLAUDE_PANEL_TEST: '1', CLAUDE_PANEL_TEST_CONFIG_DIR: configDirectory,
  CLAUDE_PANEL_DATA_DIR: path.join(isolated, 'state'),
  CODEX_CLI_PATH: path.join(isolated, 'missing-codex.exe'),
  PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  Path: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  TEMP: TEST_ROOT, TMP: TEST_ROOT,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CODEX_HOME;

try {
  application = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], env, timeout: 30000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.getByRole('heading', { name: 'Claude 工作台', exact: true }).waitFor();
  await page.evaluate(() => {
    window.__mediaSvgExecuted = false;
    window.addEventListener('message', (event) => { if (event.data === 'MEDIA_SVG_EXECUTED') window.__mediaSvgExecuted = true; });
  });
  await application.evaluate(({ dialog, shell }, paths) => {
    globalThis.__mediaSaved = [];
    globalThis.__mediaRevealed = [];
    globalThis.__mediaOpened = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.workspace] });
    dialog.showSaveDialog = async (_window, options) => {
      const name = options.defaultPath.split(/[\\/]/).at(-1);
      const filePath = `${paths.downloads}\\copy-${globalThis.__mediaSaved.length + 1}-${name}`;
      globalThis.__mediaSaved.push(filePath);
      return { canceled: false, filePath };
    };
    shell.showItemInFolder = (file) => { globalThis.__mediaRevealed.push(file); };
    shell.openPath = async (file) => { globalThis.__mediaOpened.push(file); return ''; };
  }, { workspace, downloads });
  await page.evaluate(() => window.claudePanel.openWorkspace());
  await page.waitForFunction(async () => (await window.claudePanel.getState()).connection.catalog.status === 'ready');
  await page.evaluate(() => window.claudePanel.savePreferences({ model: 'gpt-fixture-media', permissionMode: 'manual', effort: 'low' }));
  const composer = page.getByRole('textbox', { name: '输入任务', exact: true });
  const snapshot = () => page.evaluate(() => window.claudePanel.getState());
  async function finish(marker) {
    await page.locator('.message-assistant').last().filter({ hasText: marker }).waitFor();
    await page.waitForFunction(async () => !(await window.claudePanel.getState()).run);
    const state = await snapshot();
    assert.equal(state.error, null);
    return state;
  }
  async function imageLoaded(locator, label = 'image') {
    try {
      await locator.waitFor();
      await locator.evaluate((image) => image.decode());
      assert.ok(await locator.evaluate((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0));
    } catch (error) {
      const visibleErrors = await page.locator('.chat-asset-error:visible').allTextContents();
      throw new Error(`${label}: ${error.message}; visible asset errors: ${visibleErrors.join(' | ') || '(none)'}`, { cause: error });
    }
  }
  async function savePreview(expectedBytes) {
    const before = await application.evaluate(() => globalThis.__mediaSaved.length);
    await page.getByRole('dialog').getByRole('button', { name: '下载原图', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.chat-asset-preview button[aria-label="下载原图"]').disabled);
    const saved = await application.evaluate(() => globalThis.__mediaSaved);
    assert.equal(saved.length, before + 1);
    assert.deepEqual(await fs.readFile(saved.at(-1)), expectedBytes, 'Download must preserve the original bytes');
  }

  imageBase64 = await application.evaluate(async ({ clipboard, nativeImage, ClipboardItem }) => {
    globalThis.__mediaClipboard = [];
    for (const item of await clipboard.read()) {
      // Empty Windows runner clipboards can contain a placeholder without MIME types.
      if (!item.types.length) continue;
      const data = {};
      for (const type of item.types) data[type] = await item.getType(type);
      globalThis.__mediaClipboard.push(new ClipboardItem(data));
    }
    const pixels = Buffer.alloc(96 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
      const offset = (y * 96 + x) * 4;
      pixels[offset] = x < 48 ? 190 : 65;
      pixels[offset + 1] = y < 32 ? 205 : 95;
      pixels[offset + 2] = x < 48 ? 65 : 210;
      pixels[offset + 3] = 255;
    }
    const image = nativeImage.createFromBitmap(pixels, { width: 96, height: 64, scaleFactor: 1 });
    const png = image.toPNG();
    if (image.isEmpty() || !png.length) throw new Error('Clipboard fixture PNG must not be empty');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    if (!(await clipboard.has('image/png'))) throw new Error('Clipboard fixture PNG was not written');
    return png.toString('base64');
  });
  await composer.focus();
  await composer.press('Control+V');
  await imageLoaded(page.locator('.attachment-chip.has-image img'));
  assert.equal(await page.locator('.attachment-chip').count(), 1);
  await page.locator('.attachment-chip').getByRole('button', { name: /^移除 / }).click();
  await page.locator('.attachment-chip').waitFor({ state: 'hidden' });
  await composer.focus();
  await composer.press('Control+V');
  await imageLoaded(page.locator('.attachment-chip.has-image img'));
  const plainText = 'MEDIA_PASTE：这是正常粘贴的文字。\n第二行继续输入。';
  await application.evaluate(async ({ clipboard }, text) => { await clipboard.writeText(text); }, plainText);
  await composer.press('Control+V');
  assert.equal(await composer.inputValue(), plainText, 'Text paste must keep its normal behavior');
  assert.equal(await page.locator('.attachment-chip').count(), 1);
  await page.screenshot({ path: path.join(outputDirectory, '01-native-clipboard.png') });
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const pasted = await finish('MEDIA_PASTE_OK');
  assert.equal(pasted.session.messages.findLast((message) => message.role === 'user').attachments[0].mimeType, 'image/png');
  const inputImage = requests[0].user.content.find((item) => item.type === 'input_image').image_url;
  assert.deepEqual(await application.evaluate(({ nativeImage }, source) => nativeImage.createFromDataURL(source).getSize(), inputImage), { width: 96, height: 64 });
  const attachmentThumb = page.locator('.message-user').last().locator('.chat-attachment-image img');
  await imageLoaded(attachmentThumb);
  await attachmentThumb.click();
  await imageLoaded(page.locator('.chat-asset-preview img'));
  await page.getByRole('button', { name: '打开所在文件夹', exact: true }).click();
  assert.equal((await application.evaluate(() => globalThis.__mediaRevealed)).length, 1);
  await page.keyboard.press('Escape');

  const imageMode = page.getByRole('button', { name: 'AI 生图', exact: true });
  await imageMode.click();
  assert.equal(await imageMode.getAttribute('aria-pressed'), 'true');
  await composer.fill('MEDIA_GENERATE：生成一张彩色图片。');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const generated = await finish('MEDIA_GENERATE_OK');
  const generatedFiles = await fs.readdir(path.join(workspace, 'generated-images'));
  assert.equal(generatedFiles.length, 1);
  const bitmap = await fs.readFile(path.join(workspace, 'generated-images', generatedFiles[0]));
  assert.deepEqual(bitmap, Buffer.from(imageBase64, 'base64'));
  const generatedMessage = page.locator('.message-assistant').last();
  await imageLoaded(generatedMessage.locator('.chat-image-button img'));
  await generatedMessage.getByRole('link', { name: '打开原图', exact: true }).click();
  await imageLoaded(page.locator('.chat-asset-preview img'));
  await page.screenshot({ path: path.join(outputDirectory, '02-generated-bitmap.png') });
  await savePreview(bitmap);
  await page.keyboard.press('Escape');
  const generatedSaveCount = await application.evaluate(() => globalThis.__mediaSaved.length);
  await generatedMessage.getByRole('link', { name: '下载原图', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.__mediaSaved.length)).toBe(generatedSaveCount + 1);
  assert.deepEqual(await fs.readFile((await application.evaluate(() => globalThis.__mediaSaved)).at(-1)), bitmap);
  assert.match(generated.session.messages.at(-1).text, /generated-images/);
  await imageMode.click();
  assert.equal(await imageMode.getAttribute('aria-pressed'), 'false');

  await composer.fill('MEDIA_SVG：查看原始 SVG 文件。');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await finish('打开 Windows SVG 原图');
  const svgMessage = page.locator('.message-assistant').last();
  await imageLoaded(svgMessage.locator('.chat-image-button img'));
  for (const label of ['打开 Windows SVG 原图', '打开相对 SVG 原图', '下载中文编码 SVG 原图', '打开文件 URL SVG 原图']) {
    const before = await application.evaluate(() => globalThis.__mediaSaved.length);
    await svgMessage.getByRole('link', { name: label, exact: true }).click();
    if (label.startsWith('下载')) {
      await expect.poll(() => application.evaluate(() => globalThis.__mediaSaved.length)).toBe(before + 1);
      assert.deepEqual(await fs.readFile((await application.evaluate(() => globalThis.__mediaSaved)).at(-1)), Buffer.from(svgSource));
      continue;
    }
    await imageLoaded(page.locator('.chat-asset-preview img'), label);
    await savePreview(Buffer.from(svgSource));
    if (label === '打开 Windows SVG 原图') await page.screenshot({ path: path.join(outputDirectory, '03-svg-original-preview.png') });
    await page.keyboard.press('Escape');
    await page.locator('.chat-asset-preview').waitFor({ state: 'hidden' });
  }
  assert.equal(await page.evaluate(() => window.__mediaSvgExecuted), false, 'SVG scripts must not run in the renderer');
  assert.equal(probeCount, 0, 'SVG scripts must not make network requests');
  assert.deepEqual(await application.evaluate(() => globalThis.__mediaOpened), [], 'Images must use the safe preview instead of launching an executable handler');
  await svgMessage.getByRole('link', { name: '打开缺失 SVG 原图', exact: true }).click();
  await svgMessage.getByRole('alert').filter({ hasText: /文件不存在/ }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, '04-missing-file-error.png') });
  // Remove only the synthetic provider cache entry. The chat thumbnail and original must survive.
  const binaryCache = path.join(isolated, 'state', 'responses', 'direct-responses', 'attachments');
  const [cached] = await fs.readdir(binaryCache);
  await fs.unlink(path.join(binaryCache, cached));
  await composer.fill('MEDIA_SVG：继续上次对话。');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const notice = page.locator('.message-assistant').last().getByRole('note');
  await expect(notice).toContainText('1 张历史图片无法读取');
  await expect(page.locator('.message-assistant').last().getByRole('link', { name: '打开 Windows SVG 原图', exact: true })).toBeVisible();
  await imageLoaded(page.locator('.message-user .chat-attachment-image img').first());
  assert.equal(requests.length, 4);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(rendererErrors, []);
  console.log(`Electron media fixture passed: native clipboard, image input, bitmap generation, SVG original actions, safe previews, and visible missing-file errors. Screenshots: ${outputDirectory}`);
} finally {
  if (application) {
    await application.evaluate(async ({ clipboard }) => {
      const previous = globalThis.__mediaClipboard;
      if (previous?.length) await clipboard.write(previous);
      else if (previous) clipboard.clear();
    }).catch(() => {});
    await application.close();
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
