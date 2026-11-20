import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// plugin/ is the folder submitted to the Claude plugin directory. From an organization that is not
// Verified the directory accepts only Markdown, text, JSON, YAML and images, so it carries the
// review-round skill alone (no hooks, no CLI); the person installs the reviewproof CLI themselves.
const root = path.resolve(import.meta.dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

function files(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return fs.statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('plugin/ carries the same review-round skill as skills/', () => {
  assert.equal(read('plugin', 'skills', 'review-round', 'SKILL.md'), read('skills', 'review-round', 'SKILL.md'));
});

test('plugin/ manifest names the plugin at the package version and declares no hooks', () => {
  const manifest = JSON.parse(read('plugin', '.claude-plugin', 'plugin.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.name, 'reviewproof');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.hooks, undefined);
  assert.equal(fs.existsSync(path.join(root, 'plugin', 'hooks')), false);
});

test('plugin/ holds only file types the directory accepts, and no download-and-run command', () => {
  const images = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);
  const allowed = new Set(['.md', '.txt', '.json', '.yaml', '.yml', ...images]);
  for (const file of files(path.join(root, 'plugin'))) {
    const rel = path.relative(root, file);
    const ext = path.extname(file).toLowerCase();
    assert.ok(allowed.has(ext), `${rel} type`);
    if (images.has(ext)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.startsWith('#!'), `${rel} starts with #!`);
    assert.ok(!/\|\s*(ba|z)?sh\b|\|\s*iex\b|Invoke-Expression|\bnpx\s/i.test(text), `${rel} download-and-run`);
  }
});

test('the skill says the Read tool counts only with the full plugin', () => {
  assert.match(read('skills', 'review-round', 'SKILL.md'), /Read tool count too when the\s+reviewproof hooks are installed/);
});
