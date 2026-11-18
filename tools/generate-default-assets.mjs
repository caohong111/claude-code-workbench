import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { PanelsTopLeft, Bot, UserRound } = require('lucide-react');
const { chromium } = require('@playwright/test');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'assets');
await fs.mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  for (const [name, Icon, background, foreground] of [
    ['app-icon', PanelsTopLeft, '#10191c', '#67d5df'],
    ['assistant-avatar', Bot, '#163331', '#8fe0c1'],
    ['user-avatar', UserRound, '#30242c', '#f4b6cf'],
  ]) {
    const svg = renderToStaticMarkup(React.createElement(Icon, { size: 144, color: foreground, strokeWidth: 1.7 }));
    const dataUrl = await page.evaluate(async ({ svg, background }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const context = canvas.getContext('2d');
      context.fillStyle = background;
      context.fillRect(0, 0, 256, 256);
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await image.decode();
      context.drawImage(image, 56, 56, 144, 144);
      return canvas.toDataURL('image/png');
    }, { svg, background });
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    await fs.writeFile(path.join(directory, `${name}.png`), png);
    if (name === 'app-icon') {
      const header = Buffer.alloc(22);
      header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
      header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
      header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
      await fs.writeFile(path.join(directory, `${name}.ico`), Buffer.concat([header, png]));
    }
  }
} finally { await browser.close(); }
console.log('Generated neutral default artwork from ISC-licensed Lucide icons.');
