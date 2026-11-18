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

export async function hydrateInputImages(cacheDirectory, input, signal) {
  let total = 0;
  const result = [];
  for (const item of input) {
    if (item.role !== 'user' || !Array.isArray(item.content)) { result.push(item); continue; }
    const content = [];
    for (const part of item.content) {
      if (part.type !== 'workbench_input_image') { content.push(part); continue; }
      abortCheck(signal);
      if (!REFERENCE.test(part.attachmentId || '') || !MIME_TYPES.has(part.mimeType)) throw new Error('对话中的图片记录无效，请新建对话后重试。');
      const file = path.join(cacheDirectory, 'direct-responses', 'attachments', part.attachmentId);
      let buffer;
      try {
        const handle = await fs.open(file, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > INPUT_IMAGE_LIMIT) throw new Error('invalid image');
          buffer = await handle.readFile({ signal });
        } finally { await handle.close(); }
      } catch { throw new Error('对话中的图片文件无法读取，请重新添加图片或新建对话。'); }
      const actual = imageType(buffer);
      if (actual.mimeType !== part.mimeType || `${createHash('sha256').update(buffer).digest('hex')}.${actual.extension}` !== part.attachmentId) throw new Error('对话中的图片文件已发生变化，请重新添加图片。');
      total += buffer.length;
      if (total > CONTEXT_IMAGE_LIMIT) throw new Error('对话中的图片总大小超过 40 MiB，请新建对话后继续。');
      content.push({ type: 'input_image', image_url: `data:${actual.mimeType};base64,${buffer.toString('base64')}` });
    }
    result.push({ ...item, content });
  }
  abortCheck(signal);
  return result;
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
