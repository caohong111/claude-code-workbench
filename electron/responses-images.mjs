import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveWorkspacePath } from './workspace.mjs';

export const INPUT_IMAGE_LIMIT = 10 * 1024 * 1024;
const INPUT_TOTAL_LIMIT = 20 * 1024 * 1024;
const CONTEXT_IMAGE_LIMIT = 40 * 1024 * 1024;
const OUTPUT_IMAGE_LIMIT = 20 * 1024 * 1024;
const REFERENCE = /^[a-f0-9]{64}\.(?:png|jpg|webp)$/;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function abortCheck(signal) { if (signal?.aborted) throw new Error('任务已停止。'); }

function imageType(buffer) {
  if (buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.toString('ascii', buffer.length - 8, buffer.length - 4) === 'IEND') return { mimeType: 'image/png', extension: 'png' };
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 && buffer.at(-2) === 255 && buffer.at(-1) === 217) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length) return { mimeType: 'image/webp', extension: 'webp' };
  throw new Error('图片数据无效或格式不受支持，请使用 PNG、JPEG 或 WebP 图片。');
}

function decodeImage(value, limit) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('图片数据无效或超过大小限制。');
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > limit || buffer.toString('base64') !== value) throw new Error('图片数据无效或超过大小限制。');
  return { buffer, ...imageType(buffer) };
}

export async function persistInputImages(cacheDirectory, images = [], signal) {
  if (!Array.isArray(images) || images.length > 4) throw new Error('每次最多发送 4 张图片。');
  const decoded = images.map(image => {
    if (!image || !MIME_TYPES.has(image.mimeType)) throw new Error('请使用 PNG、JPEG 或 WebP 图片。');
    const result = decodeImage(image.dataBase64, INPUT_IMAGE_LIMIT);
    if (result.mimeType !== image.mimeType) throw new Error('图片格式与内容不匹配。');
    return result;
  });
  if (decoded.reduce((size, image) => size + image.buffer.length, 0) > INPUT_TOTAL_LIMIT) throw new Error('本次图片总大小不能超过 20 MiB。');
  if (!decoded.length) return [];
  const directory = path.join(cacheDirectory, 'direct-responses', 'attachments');
  await fs.mkdir(directory, { recursive: true });
  const references = [];
  for (const image of decoded) {
    abortCheck(signal);
    const attachmentId = `${createHash('sha256').update(image.buffer).digest('hex')}.${image.extension}`;
    const file = path.join(directory, attachmentId);
    let handle;
    try {
      handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(image.buffer, { signal });
    } catch (error) {
      if (handle) { await handle.close(); handle = null; await fs.unlink(file).catch(() => {}); }
      if (error.code !== 'EEXIST') throw error;
    } finally { await handle?.close(); }
    references.push({ type: 'workbench_input_image', attachmentId, mimeType: image.mimeType });
  }
  abortCheck(signal);
  return references;
}

async function readCachedImage(directory, part, remaining, signal) {
  if (!REFERENCE.test(part.attachmentId || '') || !MIME_TYPES.has(part.mimeType)) throw new Error('invalid image reference');
  const file = await fs.open(path.join(directory, part.attachmentId), 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > INPUT_IMAGE_LIMIT) throw new Error('invalid cached image');
    if (stat.size > remaining) return null;
    const bytes = await file.readFile({ signal });
    if (bytes.length !== stat.size) throw new Error('cached image size changed');
    const actual = imageType(bytes);
    if (actual.mimeType !== part.mimeType || `${createHash('sha256').update(bytes).digest('hex')}.${actual.extension}` !== part.attachmentId) throw new Error('cached image changed');
    return bytes;
  } finally { await file.close(); }
}

export async function hydrateInputImages(cacheDirectory, input, currentTurnIndex, signal) {
  const directory = path.join(cacheDirectory, 'direct-responses', 'attachments');
  const result = input.slice();
  let remaining = CONTEXT_IMAGE_LIMIT, omitted = 0, unavailable = 0;
  // Select newest first, but preserve message, image and tool order in the wire copy.
  for (let i = currentTurnIndex; i >= 0; i--) {
    const item = input[i];
    if (item.role !== 'user' || !Array.isArray(item.content)) continue;
    const content = item.content.slice();
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part.type !== 'workbench_input_image') continue;
      abortCheck(signal);
      let bytes;
      try { if (remaining) bytes = await readCachedImage(directory, part, remaining, signal); }
      catch {
        abortCheck(signal);
        if (i === currentTurnIndex) throw new Error('本次添加的图片无法读取或校验失败，请重新添加图片。');
        unavailable++;
        content[j] = { type: 'input_text', text: '[此处历史附件的图片数据不可用，本次未发送。]' };
        continue;
      }
      if (bytes) {
        remaining -= bytes.length;
        content[j] = { type: 'input_image', image_url: `data:${part.mimeType};base64,${bytes.toString('base64')}` };
      } else {
        if (i === currentTurnIndex) throw new Error('本次图片超过单次请求预算，请分两次发送。');
        omitted++;
        remaining = 0; // Keep a contiguous window of the most recent available images.
        content[j] = { type: 'input_text', text: '[此处有一张较早的图片，本次未发送其像素。]' };
      }
    }
    result[i] = { ...item, content };
  }
  abortCheck(signal);
  return { input: result, omitted, unavailable };
}

export async function saveGeneratedImages(cwd, items, signal) {
  if (!items.length || items.length > 4) throw new Error('图片接口未返回有效图片，或返回的图片数量超过 4 张。');
  const decoded = items.map(item => {
    if (item.status && item.status !== 'completed') throw new Error('图片生成未完成，请重试。');
    return decodeImage(item.result, OUTPUT_IMAGE_LIMIT);
  });
  if (decoded.reduce((size, image) => size + image.buffer.length, 0) > CONTEXT_IMAGE_LIMIT) throw new Error('生成图片总大小超过 40 MiB。');
  const directory = await resolveWorkspacePath(cwd, 'generated-images', { allowMissing: true });
  await fs.mkdir(directory, { recursive: true });
  await resolveWorkspacePath(cwd, 'generated-images');
  const saved = [];
  try {
    for (const image of decoded) {
      abortCheck(signal);
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.${image.extension}`;
      const file = await resolveWorkspacePath(cwd, path.join('generated-images', name), { allowMissing: true });
      const handle = await fs.open(file, 'wx', 0o600);
      saved.push({ path: file, name, mimeType: image.mimeType });
      try { await handle.writeFile(image.buffer, { signal }); }
      finally { await handle.close(); }
    }
    abortCheck(signal);
    return saved;
  } catch (error) {
    await Promise.allSettled(saved.map(image => fs.unlink(image.path)));
    throw error;
  }
}

export function generatedImageMarkdown(images) {
  return images.map((image, index) => {
    const target = image.path.split(path.sep).join('/');
    return `![生成图片 ${index + 1}](<${target}>)\n\n[打开原图](<${target}>) | [下载原图](<${target}>)`;
  }).join('\n\n');
}
