const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..');

test('published tarball contains only release files and its stable entry loads without dev dependencies', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mimo-package-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Skip recursive prepack and override dry-run inherited from an outer npm pack.
  const [packed] = JSON.parse(execFileSync('npm', [
    'pack', '--ignore-scripts', '--dry-run=false', '--json', '--pack-destination', dir,
  ], { cwd: root, encoding: 'utf8' }));
  const expected = [
    'index.ts', 'package.json', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE',
    'examples/mimo-voice-input.example.json',
    'docs/audio.md', 'docs/text-cleanup.md', 'docs/development.md',
    'src/extension.ts', 'src/audio.ts', 'src/diagnostics.ts', 'src/vad.ts',
    'src/webrtc.ts', 'src/mimo.ts', 'src/cleanup.ts', 'src/cleanup-prompt.ts',
  ].sort();
  assert.deepEqual(packed.files.map(file => file.path).sort(), expected);
  execFileSync('tar', ['-xzf', join(dir, packed.filename), '-C', dir]);
  const packageRoot = join(dir, 'package');
  const manifest = JSON.parse(fs.readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'pi-mimo-voice-input');
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.notEqual(manifest.private, true);
  assert.deepEqual(manifest.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' });
  assert.equal(typeof manifest.author, 'string');
  assert.doesNotMatch(manifest.author, /[<>@]/, 'author metadata must not expose an email');
  assert.deepEqual(manifest.pi.extensions, ['./index.ts']);
  const lock = JSON.parse(fs.readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.name, lock.name);
  assert.equal(manifest.name, lock.packages[''].name);
  assert.equal(packed.filename, `${manifest.name}-${manifest.version}.tgz`);
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.version, lock.packages[''].version);
  const changelog = fs.readFileSync(join(packageRoot, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(`## [${manifest.version}] - `), 'release version must have a dated changelog entry');
  const example = JSON.parse(fs.readFileSync(join(packageRoot, 'examples/mimo-voice-input.example.json'), 'utf8'));
  assert.equal(example.apiKey, '');
  for (const file of expected.filter(file => file.endsWith('.md'))) {
    const markdown = fs.readFileSync(join(packageRoot, file), 'utf8');
    for (const [, href] of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (/^https?:\/\//.test(href)) continue;
      const target = href.split('#')[0];
      if (target) assert.ok(fs.existsSync(resolve(packageRoot, file, '..', target)), `${file}: missing link ${href}`);
    }
  }
  assert.equal(fs.existsSync(join(packageRoot, 'node_modules')), false);
  // Native TS loading also catches missing or stale relative imports in the actual tarball.
  const entry = pathToFileURL(join(packageRoot, manifest.pi.extensions[0])).href;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const extension = await import(${JSON.stringify(entry)});
    assert.equal(typeof extension.default, 'function');
  `], { cwd: dir, stdio: 'pipe' });
});
