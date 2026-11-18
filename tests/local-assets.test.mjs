import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TEST_ROOT } from './test-paths.mjs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { classifyChatHref, chatUrlTransform, remarkWindowsFileLinks } from '../shared/chat-links.mjs';
import { MAX_CHAT_IMAGE_BYTES, readChatAsset, resolveChatAsset } from '../electron/local-assets.mjs';

const root = path.join(TEST_ROOT, `chat-assets-tests-${randomUUID()}`);
const workspace = path.join(root, 'project');
const attachments = path.join(root, 'attachments');
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(attachments);

test('chat URLs retain local and encoded links without enabling active schemes', () => {
  for (const href of ['D:\\project\\图片.svg', 'D:%5Cproject%5Cimage.svg', 'file:///D:/project/image.svg', './output%20image.svg', '目录/图片.svg']) {
    assert.equal(classifyChatHref(href), 'local');
    assert.equal(chatUrlTransform(href), href);
  }
  assert.equal(classifyChatHref('https://example.com/file.svg'), 'external');
  assert.equal(classifyChatHref('#section'), 'anchor');
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', '\\\\server\\file.svg', '//server/file.svg', 'https://name:secret@example.com', 'a\0b']) assert.equal(chatUrlTransform(href), '');
});

test('Markdown supplies original Windows and encoded paths to clickable renderers', () => {
  const links = [];
  const images = [];
  renderToStaticMarkup(React.createElement(ReactMarkdown, {
    urlTransform: chatUrlTransform,
    components: {
      a: ({ href, children }) => { links.push(href); return React.createElement('span', null, children); },
      img: ({ src, alt }) => { images.push(src); return React.createElement('span', null, alt); },
    },
  }, '[打开或下载 SVG 原图](E:\\Fixture\\车机APP概念图.svg)\n\n![原图](<E:/Fixture/车机 APP.svg>)\n\n[下载](./车机%20APP.svg)'));
  assert.deepEqual(links, ['E:%5CFixture%5C%E8%BD%A6%E6%9C%BAAPP%E6%A6%82%E5%BF%B5%E5%9B%BE.svg', './%E8%BD%A6%E6%9C%BA%20APP.svg']);
  assert.deepEqual(images, ['E:/Fixture/%E8%BD%A6%E6%9C%BA%20APP.svg']);
});

test('raw Windows angle-bracket destinations preserve punctuation without changing code', () => {
  const links = [];
  const images = [];
  const markdown = [
    '[打开](<D:\\project\\.tmp\\#draft\\车机 APP.svg> "原图")',
    '![原图](<D:\\project\\.tmp\\车机 APP.svg>)',
    '[![预览](<D:\\project\\.cache\\preview.svg>)](<D:\\project\\.tmp\\original.svg>)',
    '`[代码](<D:\\project\\.tmp\\code.svg>)`',
    '```md\n[代码块](<D:\\project\\.tmp\\code.svg>)\n```',
  ].join('\n\n');
  const rendered = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkWindowsFileLinks],
    urlTransform: chatUrlTransform,
    components: {
      a: ({ href, children }) => { links.push(href); return React.createElement('span', null, children); },
      img: ({ src, alt }) => { images.push(src); return React.createElement('span', null, alt); },
    },
  }, markdown));
  assert.deepEqual(links, ['D:/project/.tmp/%23draft/%E8%BD%A6%E6%9C%BA%20APP.svg', 'D:/project/.tmp/original.svg']);
  assert.deepEqual(images, ['D:/project/.tmp/%E8%BD%A6%E6%9C%BA%20APP.svg', 'D:/project/.cache/preview.svg']);
  assert.ok(rendered.includes('[代码](&lt;D:\\project\\.tmp\\code.svg&gt;)'));
  assert.ok(rendered.includes('[代码块](&lt;D:\\project\\.tmp\\code.svg&gt;)'));
});

test('local SVG originals resolve via Windows, relative and file URLs', async () => {
  const name = '车机 APP #概念图.svg';
  const file = path.join(workspace, name);
  const contents = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  await fs.writeFile(file, contents);
  const hrefs = [file, encodeURIComponent(name), `${pathToFileURL(file).href}?download=1#preview`, file.split(path.sep).map(encodeURIComponent).join('%5C').replace('%3A', ':')];
  for (const href of hrefs) {
    const asset = await readChatAsset(workspace, href);
    assert.equal(asset.name, name);
    assert.equal(asset.kind, 'image');
    assert.equal(asset.openMode, 'reveal');
    assert.equal(asset.dataUrl, `data:image/svg+xml;base64,${Buffer.from(contents).toString('base64')}`);
  }
});

test('host-selected attachment root works while traversal and junction escapes fail', async () => {
  const attachment = path.join(attachments, 'shot.png');
  await fs.writeFile(attachment, 'png');
  await assert.rejects(readChatAsset(workspace, attachment), /不在当前/);
  assert.equal((await readChatAsset(workspace, attachment, { allowedRoots: [attachments] })).name, 'shot.png');
  await assert.rejects(readChatAsset(workspace, '../attachments/shot.png'), /不在当前/);
  await fs.symlink(attachments, path.join(workspace, 'escape'), 'junction');
  await assert.rejects(readChatAsset(workspace, 'escape/shot.png'), /链接目标/);
  await assert.rejects(readChatAsset(workspace, 'file://server/share/file.svg'), /格式无效/);
  await assert.rejects(readChatAsset(workspace, 'missing.svg'), /不存在/);
});

test('image read is bounded and executable originals only reveal in Explorer', async () => {
  const largeImage = path.join(workspace, 'large.png');
  const handle = await fs.open(largeImage, 'w');
  await handle.truncate(MAX_CHAT_IMAGE_BYTES + 1); await handle.close();
  await assert.rejects(readChatAsset(workspace, 'large.png'), /20 MB/);
  await fs.writeFile(path.join(workspace, 'run.cmd'), '@echo test');
  assert.equal((await resolveChatAsset(workspace, 'run.cmd')).openMode, 'reveal');
  await fs.writeFile(path.join(workspace, 'readme.txt'), 'hello');
  const document = await readChatAsset(workspace, 'readme.txt');
  assert.equal(document.openMode, 'open');
  assert.equal(document.dataUrl, undefined);
});
