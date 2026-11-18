import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppearanceAssets } from '../electron/appearance-assets.mjs';
import { TEST_ROOT } from './test-paths.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(TEST_ROOT, 'appearance-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const defaults = {
    appIcon: path.join(root, 'default-app.png'),
    claudeAvatar: path.join(root, 'default-claude.png'),
    userAvatar: path.join(root, 'default-user.png'),
    appIconIco: path.join(root, 'default-app.ico'),
  };
  await Promise.all(Object.values(defaults).map(file => fs.writeFile(file, png)));
  const crops = [];
  const nativeImage = {
    createFromBuffer(buffer) {
      const valid = buffer.equals(png) || buffer.toString() === 'wide-fixture';
      return {
        isEmpty: () => !valid,
        getSize: () => buffer.toString() === 'wide-fixture' ? { width: 600, height: 300 } : { width: 1, height: 1 },
        crop(rect) {
          crops.push(rect);
          return { resize(options) { assert.deepEqual(options, { width: 256, height: 256, quality: 'best' }); return { toPNG: () => png }; } };
        },
      };
    },
  };
  const options = { directory: path.join(root, 'saved'), defaults, nativeImage };
  return { root, defaults, crops, options, assets: new AppearanceAssets(options) };
}

test('imports square normalized copies, creates a Windows icon and restores all slots', async t => {
  const f = await fixture(t);
  const initial = await f.assets.getAppearance();
  assert.equal(initial.appIcon.custom, false);
  assert.equal(initial.userAvatar.fileName, 'default-user.png');
  assert.equal(await f.assets.getApplicationIconPath(), f.defaults.appIconIco);
  const source = path.join(f.root, 'chosen-photo.jpg');
  await fs.writeFile(source, 'wide-fixture');
  for (const slot of ['appIcon', 'claudeAvatar', 'userAvatar']) {
    const appearance = await f.assets.importAsset(slot, source);
    assert.equal(appearance[slot].custom, true);
    assert.equal(appearance[slot].fileName, 'chosen-photo.jpg');
    assert.match(appearance[slot].src, /^data:image\/png;base64,/);
    assert.equal(JSON.stringify(appearance).includes(f.root), false);
  }
  assert.ok(f.crops.some(rect => rect.x === 150 && rect.y === 0 && rect.width === 300 && rect.height === 300));
  assert.equal(await fs.readFile(source, 'utf8'), 'wide-fixture');
  const icon = await fs.readFile(await f.assets.getApplicationIconPath());
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 1);
  assert.equal(icon.readUInt8(6), 0);
  assert.equal(icon.readUInt8(7), 0);
  assert.equal(icon.readUInt32LE(14), png.length);
  assert.equal(icon.readUInt32LE(18), 22);
  assert.deepEqual(icon.subarray(22), png);
  const restored = new AppearanceAssets(f.options);
  assert.deepEqual(await restored.getAppearance(), await f.assets.getAppearance());
  const reset = await restored.resetAsset('appIcon');
  assert.equal(reset.appIcon.custom, false);
  assert.equal(reset.claudeAvatar.custom, true);
  assert.equal(await restored.getApplicationIconPath(), f.defaults.appIconIco);
});

test('invalid or oversized files leave the previously selected image intact', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'valid.png');
  await fs.writeFile(source, png);
  const selected = await f.assets.importAsset('userAvatar', source);
  const invalid = path.join(f.root, 'invalid.svg');
  await fs.writeFile(invalid, '<svg><script>external content</script></svg>');
  await assert.rejects(f.assets.importAsset('userAvatar', invalid), /无法识别/);
  await assert.rejects(f.assets.importAsset('userAvatar', 'relative.png'), /本机图片/);
  assert.throws(() => f.assets.importAsset('../elsewhere', source), /不支持/);
  const large = path.join(f.root, 'large.png');
  const handle = await fs.open(large, 'w');
  await handle.truncate(10 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(f.assets.importAsset('userAvatar', large), /10 MB/);
  assert.deepEqual(await f.assets.getAppearance(), selected);
});

test('saved metadata cannot point outside the appearance directory and damaged custom copies recover', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.options.directory);
  await fs.writeFile(path.join(f.options.directory, 'appearance.json'), JSON.stringify({ version: 1, slots: {
    appIcon: { fileName: '../outside.png', originalName: 'outside.png' },
    userAvatar: { fileName: 'userAvatar-00000000-0000-0000-0000-000000000000.png', originalName: 'missing.png' },
  } }));
  const appearance = await f.assets.getAppearance();
  assert.equal(appearance.appIcon.custom, false);
  assert.equal(appearance.userAvatar.custom, false);
  assert.equal(await f.assets.getApplicationIconPath(), f.defaults.appIconIco);
});

test('concurrent changes preserve other slots and persist the final reset', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'valid.png');
  await fs.writeFile(source, png);
  await Promise.all([
    f.assets.importAsset('appIcon', source),
    f.assets.importAsset('claudeAvatar', source),
    f.assets.resetAsset('appIcon'),
  ]);
  const saved = await new AppearanceAssets(f.options).getAppearance();
  assert.equal(saved.appIcon.custom, false);
  assert.equal(saved.claudeAvatar.custom, true);
});
