import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCapture } from '../src/spawn.ts';

const root = path.resolve(import.meta.dirname, '..');
const readJson = (rel: string): any => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

// Exec form with node and the plugin's own dist: no npm .cmd shim, so it runs the same on every OS.
const hookCommand = {
  type: 'command',
  command: 'node',
  args: ['${CLAUDE_PLUGIN_ROOT}/dist/bin/reviewproof.js', 'hook'],
};

test('hooks.json wires the Read and shell events to the exec-form hook command', () => {
  const hooks = readJson('hooks/hooks.json').hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse']);
  assert.deepEqual(hooks.PostToolUse, [{ matcher: 'Read', hooks: [hookCommand] }]);
  assert.deepEqual(hooks.PreToolUse, [{ matcher: 'Bash|PowerShell', hooks: [hookCommand] }]);
});

test('plugin.json and marketplace.json name the plugin and match the package version', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'reviewproof');
  assert.equal(plugin.version, pkg.version);
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'reviewproof');
  assert.deepEqual(market.plugins.map((p: { name: string }) => p.name), ['reviewproof']);
  assert.deepEqual(market.plugins[0].source, { source: 'npm', package: 'reviewproof' });
});

// dist/ is git-ignored and Claude Code runs no build: prepack must build it into the tarball.
test('the npm tarball carries the built CLI and the plugin files', () => {
  const r = runCapture(['npm', 'pack', '--dry-run', '--json'], root);
  assert.equal(r.status, 0, r.output);
  const files: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path);
  for (const want of [
    'dist/bin/reviewproof.js',
    'hooks/hooks.json',
    '.claude-plugin/plugin.json',
    'skills/review-round/SKILL.md',
  ]) {
    assert.ok(files.includes(want), `${want} missing from the tarball`);
  }
});

test('the review-round skill has its front matter and tells the agent never to post', () => {
  const text = fs.readFileSync(path.join(root, 'skills/review-round/SKILL.md'), 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  assert.match(front, /^name: review-round$/m);
  const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
  assert.ok(description.length > 0 && description.length < 1024, `description is ${description.length} characters`);
  assert.ok(text.includes('never run reviewproof post'));
  assert.ok(text.split('\n').length <= 150);
});
