import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SLOTS = new Set(['appIcon', 'claudeAvatar', 'userAvatar']);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;

function slotName(value) {
  if (!SLOTS.has(value)) throw new Error('不支持的图标类型。');
  return value;
}

function storedName(slot, value) {
  return typeof value === 'string' && new RegExp(`^${slot}-[a-f0-9-]{36}\\.png$`).test(value);
}

function windowsIcon(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  // Zero width and height encode a 256-pixel PNG representation in an ICO file.
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

export class AppearanceAssets {
  constructor({ directory, defaults, nativeImage }) {
    if (!path.isAbsolute(directory) || !nativeImage?.createFromBuffer) throw new Error('无效的图标存储配置。');
    this.directory = path.resolve(directory);
    this.defaults = defaults;
    this.nativeImage = nativeImage;
    this.entries = {};
    this.defaultImages = new Map();
    this.mutation = Promise.resolve();
  }

  async _load() {
    if (!this.loading) this.loading = (async () => {
      let saved;
      try { saved = JSON.parse(await fs.readFile(path.join(this.directory, 'appearance.json'), 'utf8')); }
      catch { return; }
      if (saved.version !== 1 || !saved.slots || typeof saved.slots !== 'object') return;
      for (const slot of SLOTS) {
        const entry = saved.slots[slot];
        if (!entry || !storedName(slot, entry.fileName)) continue;
        this.entries[slot] = {
          fileName: entry.fileName,
          originalName: typeof entry.originalName === 'string' ? path.basename(entry.originalName).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) : '',
        };
      }
    })();
    await this.loading;
  }

  _normalize(buffer) {
    try {
      const image = this.nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) throw new Error();
      const { width, height } = image.getSize();
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error();
      const side = Math.min(width, height);
      const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
      const png = square.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
      if (!Buffer.isBuffer(png) || png.length < 8 || png.length > MAX_BYTES || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error();
      return png;
    } catch { throw new Error('无法识别这张图片，请选择有效的 PNG、JPG、WebP 或 ICO 图片。'); }
  }

  async _read(file) {
    try {
      const handle = await fs.open(file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('图片文件不得超过 10 MB。');
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) throw new Error('读取图片失败，请重试。');
        return buffer;
      } finally { await handle.close(); }
    } catch (error) {
      if (error.message === '图片文件不得超过 10 MB。' || error.message === '读取图片失败，请重试。') throw error;
      throw new Error('无法读取图片文件，请重新选择。');
    }
  }

  async _default(slot) {
    if (!this.defaultImages.has(slot)) {
      const png = this._normalize(await this._read(this.defaults[slot]));
      this.defaultImages.set(slot, png);
    }
    return this.defaultImages.get(slot);
  }

  async getAppearance() {
    await this._load();
    const appearance = {};
    for (const slot of SLOTS) {
      const entry = this.entries[slot];
      let png;
      if (entry) {
        try { png = this._normalize(await this._read(path.join(this.directory, entry.fileName))); }
        catch { /* Missing or damaged custom files fall back to the original supplied asset. */ }
      }
      appearance[slot] = {
        src: `data:image/png;base64,${(png || await this._default(slot)).toString('base64')}`,
        custom: Boolean(png),
        fileName: png ? entry.originalName : path.basename(this.defaults[slot]),
      };
    }
    return appearance;
  }

  async getApplicationIconPath() {
    await this._load();
    const entry = this.entries.appIcon;
    if (entry) {
      const file = path.join(this.directory, entry.fileName.replace(/\.png$/, '.ico'));
      try {
        const handle = await fs.open(file, 'r');
        try {
          const header = Buffer.alloc(6);
          await handle.read(header, 0, 6, 0);
          if (header.readUInt16LE(0) === 0 && header.readUInt16LE(2) === 1 && header.readUInt16LE(4) === 1) return file;
        } finally { await handle.close(); }
      } catch {}
    }
    return this.defaults.appIconIco;
  }

  _change(callback) {
    const task = this.mutation.catch(() => {}).then(async () => { await this._load(); return callback(); });
    this.mutation = task;
    return task;
  }

  async _save(entries) {
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `appearance-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, slots: entries }, null, 2), { flag: 'wx' });
      await fs.rename(temporary, path.join(this.directory, 'appearance.json'));
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    this.entries = entries;
  }

  importAsset(slot, file) {
    slotName(slot);
    return this._change(async () => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('请选择本机图片文件。');
      const png = this._normalize(await this._read(file));
      const fileName = `${slot}-${randomUUID()}.png`;
      const destination = path.join(this.directory, fileName);
      const icon = slot === 'appIcon' ? destination.replace(/\.png$/, '.ico') : null;
      await fs.mkdir(this.directory, { recursive: true });
      try {
        await fs.writeFile(destination, png, { flag: 'wx' });
        if (icon) await fs.writeFile(icon, windowsIcon(png), { flag: 'wx' });
        await this._save({ ...this.entries, [slot]: { fileName, originalName: path.basename(file).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) } });
      } catch (error) {
        await fs.rm(destination, { force: true }).catch(() => {});
        if (icon) await fs.rm(icon, { force: true }).catch(() => {});
        throw error;
      }
      return this.getAppearance();
    });
  }

  resetAsset(slot) {
    slotName(slot);
    return this._change(async () => {
      const next = { ...this.entries };
      delete next[slot];
      await this._save(next);
      return this.getAppearance();
    });
  }
}
