import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_TOTAL = 20 * 1024 * 1024;
export const MAX_IMAGES = 4;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp)$/i;

export class ChatAttachments {
  constructor({ directory, nativeImage }) {
    this.directory = path.resolve(directory);
    this.nativeImage = nativeImage;
  }

  async importFile(file) {
    if (!IMAGE_EXTENSION.test(file)) return { path: file, name: path.basename(file) };
    const stat = await fs.stat(file);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB。');
    return this.importBytes(await fs.readFile(file), path.basename(file));
  }

  async importBytes(value, name = '截图.png') {
    if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 10 MB。');
    const image = this.nativeImage.createFromBuffer(Buffer.from(value));
    if (image.isEmpty()) throw new Error('无法读取这张图片，请使用 PNG、JPEG、WebP 或 GIF。');
    const { width, height } = image.getSize();
    if (width > 16384 || height > 16384 || width * height > 40000000) throw new Error('图片尺寸过大，请裁剪后重试。');
    const bytes = image.toPNG();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片解码后超过 10 MB，请缩小后重试。');
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `${Date.now()}-${randomUUID()}.png`);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    const scale = Math.min(240 / width, 180 / height, 1);
    const preview = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' });
    return { path: file, name: path.basename(name).slice(0, 160), mimeType: 'image/png', size: bytes.length, width, height, previewSrc: preview.toDataURL() };
  }

  async inputImages(attachments) {
    const images = attachments.filter(item => item.mimeType === 'image/png');
    if (images.length > MAX_IMAGES) throw new Error('每条消息最多添加 4 张图片。');
    let total = 0;
    const result = [];
    for (const image of images) {
      if (path.dirname(path.resolve(image.path)) !== this.directory) throw new Error('无效的图片附件。');
      const stat = await fs.stat(image.path);
      total += stat.size;
      if (stat.size > MAX_IMAGE_BYTES || total > MAX_IMAGE_TOTAL) throw new Error('单张图片最多 10 MB，每条消息的图片合计最多 20 MB。');
      result.push({ mimeType: 'image/png', dataBase64: (await fs.readFile(image.path)).toString('base64'), name: image.name });
    }
    return result;
  }
}
