import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'node_modules', 'electron');
process.env.electron_config_cache ||= process.env.ELECTRON_CACHE || path.join(root, 'local-data', 'cache', 'electron');
await fs.mkdir(process.env.electron_config_cache, { recursive: true });
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(directory, 'install.js')], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => resolve(code ?? 1));
});
if (code) throw new Error('Electron runtime download failed. Check access to official Electron releases, then run npm run runtime:install.');
const platformPath = (await fs.readFile(path.join(directory, 'path.txt'), 'utf8')).trim();
await fs.access(path.join(directory, 'dist', platformPath));
console.log('Electron runtime is installed and ready.');
