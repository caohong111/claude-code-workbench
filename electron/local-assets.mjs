import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { insideDirectory, resolveWorkspacePath } from './workspace.mjs';
import { classifyChatHref } from '../shared/chat-links.mjs';

const IMAGE_MIME_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'],
  ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
]);
const OPENABLE_DOCUMENTS = new Set(['.pdf', '.txt', '.md', '.csv', '.json', '.log', '.yaml', '.yml', '.toml', '.docx', '.xlsx', '.pptx']);
export const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;

function localPathFromHref(root, href) {
  if (classifyChatHref(href) !== 'local') throw new Error('这个链接不是本地文件。');
  let url;
  try {
    if (/^[a-z]:\\/i.test(href)) {
      url = pathToFileURL(href);
    } else if (/^[a-z]:(?:\/|%5c|%2f)/i.test(href)) {
      // Markdown percent-encodes Windows separators before calling urlTransform.
      url = new URL(`file:///${href.replace(/%5c|%2f/gi, '/')}`);
    } else {
      const rootUrl = pathToFileURL(`${path.resolve(root)}${path.sep}`);
      url = new URL(href.replaceAll('\\', '/'), rootUrl);
    }
    if (url.protocol !== 'file:' || url.hostname) throw new Error('remote file');
    url.search = '';
    url.hash = '';
    return fileURLToPath(url);
  } catch { throw new Error('文件链接格式无效。'); }
}

export async function resolveChatAsset(workspaceRoot, href, { allowedRoots = [] } = {}) {
  const candidate = localPathFromHref(workspaceRoot, href);
  const roots = [workspaceRoot, ...allowedRoots].filter((root) => typeof root === 'string' && root);
  let resolved;
  for (const root of roots) {
    if (!insideDirectory(path.resolve(root), candidate)) continue;
    try {
      resolved = await resolveWorkspacePath(root, candidate);
      break;
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('文件不存在，可能已移动或删除。');
      throw error;
    }
  }
  if (!resolved) throw new Error('文件不在当前工作文件夹或聊天附件目录中。');
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error('这个链接指向文件夹，请在文件列表中打开。');
  const extension = path.extname(resolved).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES.get(extension) || 'application/octet-stream';
  return {
    path: resolved,
    name: path.basename(resolved),
    extension,
    mimeType,
    size: stat.size,
    kind: IMAGE_MIME_TYPES.has(extension) ? 'image' : 'file',
    openMode: OPENABLE_DOCUMENTS.has(extension) ? 'open' : 'reveal',
  };
}

export async function readChatAsset(workspaceRoot, href, options = {}) {
  const asset = await resolveChatAsset(workspaceRoot, href, options);
  if (asset.kind !== 'image') return asset;
  const handle = await fs.open(asset.path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CHAT_IMAGE_BYTES) throw new Error('图片超过 20 MB，请下载原图或在文件夹中查看。');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return { ...asset, size: offset, dataUrl: `data:${asset.mimeType};base64,${bytes.subarray(0, offset).toString('base64')}` };
  } finally { await handle.close(); }
}
