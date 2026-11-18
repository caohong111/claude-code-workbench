import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'build', 'third-party-licenses');
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
await fs.mkdir(directory, { recursive: true });
const entries = [];
for (const [relative, metadata] of Object.entries(lock.packages || {})) {
  if (!relative.startsWith('node_modules/') || metadata.dev) continue;
  const packageDirectory = path.resolve(root, relative);
  if (!packageDirectory.startsWith(`${root}${path.sep}`)) throw new Error('Dependency path escaped the project.');
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && metadata.optional) continue; throw error; }
  const output = path.join(directory, `${pkg.name.replace(/[^a-z0-9_.-]/gi, '_')}-${pkg.version}`);
  const licenseFiles = (await fs.readdir(packageDirectory)).filter(name => /^(?:licen[cs]e|notice|copying)(?:[.-]|$)/i.test(name));
  if (typeof pkg.license === 'string' && /README\.md/i.test(pkg.license)) licenseFiles.push('README.md');
  await fs.mkdir(output, { recursive: true });
  const copied = [];
  for (const name of new Set(licenseFiles)) {
    const file = path.join(packageDirectory, name);
    if (!(await fs.stat(file)).isFile()) continue;
    await fs.copyFile(file, path.join(output, name));
    copied.push(name);
  }
  entries.push({ name: pkg.name, version: pkg.version, license: pkg.license || metadata.license || 'See package documentation', files: copied });
}
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ packages: entries }, null, 2));
console.log(`Collected license notices for ${entries.length} installed production packages.`);
