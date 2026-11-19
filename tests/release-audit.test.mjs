import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditArtifact, auditRelease, pathProblem, scanText } from '../tools/audit-release.mjs';

async function fixture(t) {
  const temporary = path.resolve('tests', '.tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'release-audit-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rmdir(temporary).catch(() => {}); });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'export const appName = "Fixture";');
  return root;
}

test('source allowlist ignores installed dependencies and build output while rejecting private files', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'fixture', 'settings.json'), '{"fixture":true}');
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist', 'fixture.js'), 'fixture build');
  assert.equal((await auditRelease({ root })).ok, true);
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'settings.json'), '{"fixture":true}');
  const result = await auditRelease({ root });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(problem => problem.rule === 'private-directory'));
});

test('Git candidates catch tracked private files even after ignore rules are added', async t => {
  const root = await fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await fs.writeFile(path.join(root, 'settings.json'), '{}');
  execFileSync('git', ['add', 'settings.json'], { cwd: root });
  await fs.writeFile(path.join(root, '.gitignore'), 'settings.json\nnode_modules/\ndist/\n');
  const result = await auditRelease({ root });
  assert.equal(result.source, 'git-candidates');
  assert.ok(result.problems.some(problem => problem.file === 'settings.json' && problem.rule === 'private-configuration'));
});

test('literal secrets and private markers report locations without including secret values', () => {
  const privateToken = ['sk-', 'z'.repeat(32)].join('');
  const opaque = ['production', 'opaquevalue'].join('');
  const source = `const apiKey = '${privateToken}';\nconst token = '${opaque}';\nconst url = 'https://private.example.net/api';`;
  const result = scanText('src/example.js', source, { secretValues: [privateToken], privateMarkers: ['private.example.net'] });
  assert.ok(result.some(problem => problem.rule === 'secret-format' && problem.line === 1));
  assert.ok(result.some(problem => problem.rule === 'literal-credential-assignment' && problem.line === 2));
  assert.ok(result.some(problem => problem.rule === 'known-private-marker' && problem.line === 3));
  assert.equal(JSON.stringify(result).includes(privateToken), false);
  assert.equal(JSON.stringify(result).includes('productionopaquevalue'), false);
});

test('only explicit dummy values bypass credential checks, not whole test files', () => {
  assert.deepEqual(scanText('tests/sample.test.mjs', "const token = 'fixture-private-token'; const apiKey = 'your-api-key';"), []);
  const value = ['ghp_', 'a'.repeat(36)].join('');
  assert.ok(scanText('tests/sample.test.mjs', `const token = '${value}';`).length > 0);
  assert.deepEqual(scanText('tests/sample.test.mjs', "const url = 'https://user:secret@fixture.invalid/path';"), []);
});

test('credential URLs and literal personal home paths fail without printing their content', () => {
  const opaque = ['opaque', 'value'].join('');
  const host = 'service.test';
  const source = [`https://person:${opaque}@${host}/api`, `https://${host}/api?api_key=${opaque}`, ['C:', 'Users', 'PrivatePerson', 'project'].join('\\')].join('\n');
  const result = scanText('README.md', source);
  assert.equal(result.filter(problem => problem.rule === 'url-credentials').length, 2);
  assert.ok(result.some(problem => problem.rule === 'personal-home-path'));
  assert.equal(JSON.stringify(result).includes('opaquevalue'), false);
});

test('allowlist blocks credentials, private histories, original avatars and live paid tests', () => {
  for (const file of ['data/workspace-state.json', 'local-data/manifest.json', 'cache/api.json', 'tests/.tmp/session.json', '.env', 'assets/personal-avatar.jpg', 'tests/live-media-smoke.mjs', '../secret.txt', 'private.key', 'build/third-party-licenses/fixture-1.0.0/LICENSE']) assert.ok(pathProblem(file), file);
  for (const file of ['electron/provider-config.mjs', 'src/App.jsx', 'assets/app-icon.png', 'install.ps1', '.github/workflows/release.yml', '.gitleaks.toml']) assert.equal(pathProblem(file), null, file);
});

test('artifact audit inspects bundled application files and rejects accidentally packaged user state', async () => {
  const archive = '/fixture/app.asar';
  const entries = {
    'package.json': Buffer.from('{"name":"fixture"}'),
    'electron/main.cjs': Buffer.from('const title = "Fixture";'),
    'node_modules/fixture/settings.json': Buffer.from('dependency fixture'),
    'data/workspace-state.json': Buffer.from('{}'),
  };
  const key = file => file.replaceAll('\\', '/');
  const api = { listPackage: () => Object.keys(entries).map(file => `/${file}`), statFile: (_archive, file, followLinks) => { assert.equal(followLinks, false); return { size: entries[key(file)].length }; }, extractFile: (_archive, file, followLinks) => { assert.equal(followLinks, false); return entries[key(file)]; } };
  const result = await auditArtifact(archive, { asarApi: api });
  assert.equal(result.ok, false);
  assert.equal(result.filesAudited, 2);
  assert.equal(result.dependencyEntriesExcluded, 1);
  assert.ok(result.problems.some(problem => problem.file === 'data/workspace-state.json'));
});

test('generated license output is ignored in a source archive but cannot become a tracked source candidate', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'build', 'third-party-licenses', 'fixture-1.0.0'), { recursive: true });
  await fs.writeFile(path.join(root, 'build', 'third-party-licenses', 'fixture-1.0.0', 'LICENSE'), 'Fixture dependency license');
  assert.equal((await auditRelease({ root })).ok, true);
  const result = await auditRelease({ root, candidates: ['build/third-party-licenses/fixture-1.0.0/LICENSE'] });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].rule, 'generated-license-output');
});

test('unpacked artifact accepts only reviewed license filenames under the licenses resource', async t => {
  const root = await fixture(t);
  const resources = path.join(root, 'resources');
  const licenses = path.join(resources, 'licenses');
  await fs.mkdir(path.join(licenses, 'fixture-1.0.0'), { recursive: true });
  await fs.writeFile(path.join(resources, 'app.asar'), 'fixture archive');
  await fs.writeFile(path.join(licenses, 'manifest.json'), '{}');
  await fs.writeFile(path.join(licenses, 'fixture-1.0.0', 'LICENSE-MIT'), 'Fixture license');
  await fs.writeFile(path.join(licenses, 'fixture-1.0.0', 'README.md'), 'Fixture dependency documentation');
  const api = { listPackage: () => ['/package.json'], statFile: () => ({ size: 2 }), extractFile: () => Buffer.from('{}') };
  const passed = await auditArtifact(root, { asarApi: api });
  assert.equal(passed.ok, true);
  assert.equal(passed.resourceLicenseFilesChecked, 3);
  await fs.writeFile(path.join(licenses, 'fixture-1.0.0', 'settings.json'), '{}');
  const failed = await auditArtifact(root, { asarApi: api });
  assert.equal(failed.ok, false);
  assert.ok(failed.problems.some(problem => problem.rule === 'unexpected-license-resource'));
});

test('unpacked artifact permits a real native icon resource and rejects a renamed or truncated file', async t => {
  const root = await fixture(t);
  const resources = path.join(root, 'resources');
  await fs.mkdir(resources);
  await fs.writeFile(path.join(resources, 'app.asar'), 'fixture archive');
  const iconFile = path.join(resources, 'app-icon.ico');
  const publicIcon = await fs.readFile(new URL('../assets/app-icon.ico', import.meta.url));
  await fs.writeFile(iconFile, publicIcon);
  const api = { listPackage: () => ['/package.json'], statFile: () => ({ size: 2 }), extractFile: () => Buffer.from('{}') };
  const passed = await auditArtifact(root, { asarApi: api });
  assert.equal(passed.ok, true);
  assert.equal(passed.nativeIconResourceChecked, true);
  for (const invalid of [Buffer.from('fixture text pretending to be an icon'), publicIcon.subarray(0, 22)]) {
    await fs.writeFile(iconFile, invalid);
    const failed = await auditArtifact(root, { asarApi: api });
    assert.equal(failed.ok, false);
    assert.ok(failed.problems.some(problem => problem.rule === 'invalid-native-icon-resource'));
  }
});

test('real ASAR nested files use native Windows separators without following links', async t => {
  const root = await fixture(t);
  const asar = await import('@electron/asar');
  const input = path.join(root, 'archive-input');
  const archive = path.join(root, 'nested.asar');
  await fs.mkdir(path.join(input, 'electron', 'nested'), { recursive: true });
  await fs.writeFile(path.join(input, 'package.json'), '{"name":"fixture"}');
  await fs.writeFile(path.join(input, 'electron', 'nested', 'main.cjs'), 'const marker = "private-publish-marker";');
  await asar.createPackage(input, archive);
  const calls = [];
  const api = {
    listPackage: file => asar.listPackage(file),
    statFile: (file, entry, followLinks) => { calls.push({ entry, followLinks }); return asar.statFile(file, entry, followLinks); },
    extractFile: (file, entry, followLinks) => { calls.push({ entry, followLinks }); return asar.extractFile(file, entry, followLinks); },
  };
  const passed = await auditArtifact(archive, { asarApi: api });
  assert.equal(passed.ok, true);
  assert.equal(passed.filesAudited, 2);
  assert.ok(calls.every(call => call.followLinks === false && call.entry === path.normalize(call.entry)));
  const failed = await auditArtifact(archive, { asarApi: api, privateMarkers: ['private-publish-marker'] });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.problems, [{ file: 'electron/nested/main.cjs', line: 1, rule: 'known-private-marker' }]);
});

test('artifact scanner rejects an application symlink before extracting its target', async () => {
  const api = {
    listPackage: () => ['/electron/linked.cjs'],
    statFile: (_archive, _entry, followLinks) => { assert.equal(followLinks, false); return { link: 'electron/main.cjs' }; },
    extractFile: () => { assert.fail('A symlink target must not be extracted'); },
  };
  const result = await auditArtifact('/fixture/app.asar', { asarApi: api });
  assert.deepEqual(result.problems, [{ file: 'electron/linked.cjs', rule: 'non-regular-package-file' }]);
});

test('updater resource accepts only the four reviewed GitHub configuration entries', async t => {
  const root = await fixture(t);
  const resources = path.join(root, 'resources');
  await fs.mkdir(resources);
  await fs.writeFile(path.join(resources, 'app.asar'), 'fixture archive');
  const updateFile = path.join(resources, 'app-update.yml');
  const expected = 'owner: caohong111\nrepo: claude-code-workbench\nprovider: github\nupdaterCacheDirName: claude-code-workbench-updater\n';
  const api = { listPackage: () => ['/package.json'], statFile: () => ({ size: 2 }), extractFile: () => Buffer.from('{}') };
  await fs.writeFile(updateFile, expected);
  const passed = await auditArtifact(root, { asarApi: api });
  assert.equal(passed.ok, true);
  assert.equal(passed.updateConfigurationChecked, true);
  const invalid = [expected + 'token: fixture-private-token\n', expected.replace('provider: github', 'provider: generic'), expected.replace('owner: caohong111', 'owner: another-owner'), expected + 'repo: duplicate-repository\n', '#' + 'x'.repeat(16 * 1024)];
  for (const text of invalid) {
    await fs.writeFile(updateFile, text);
    const failed = await auditArtifact(root, { asarApi: api });
    assert.equal(failed.ok, false);
    assert.ok(failed.problems.some(problem => problem.rule === 'unexpected-update-configuration'));
  }
});

test('official Electron default application is allowed only by its reviewed hash', async t => {
  const root = await fixture(t);
  const resources = path.join(root, 'resources');
  await fs.mkdir(resources);
  await fs.writeFile(path.join(resources, 'app.asar'), 'fixture archive');
  const defaultApp = path.join(resources, 'default_app.asar');
  await fs.copyFile(new URL('../node_modules/electron/dist/resources/default_app.asar', import.meta.url), defaultApp);
  const api = { listPackage: () => ['/package.json'], statFile: () => ({ size: 2 }), extractFile: () => Buffer.from('{}') };
  const passed = await auditArtifact(root, { asarApi: api });
  assert.equal(passed.ok, true);
  assert.equal(passed.officialElectronDefaultAppChecked, true);
  await fs.appendFile(defaultApp, 'fixture changed bytes');
  const failed = await auditArtifact(root, { asarApi: api });
  assert.equal(failed.ok, false);
  assert.ok(failed.problems.some(problem => problem.rule === 'unreviewed-electron-default-app'));
});
