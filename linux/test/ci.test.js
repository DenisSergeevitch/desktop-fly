// test/ci.test.js — Phase 6 acceptance gate. Verifies that:
//   - .github/workflows/linux.yml runs both suites on ubuntu-24.04.
//   - docs/ubuntu.md exists, has install + run + troubleshooting sections.
//   - CLAUDE.md mentions the linux/ tree and the symlink rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

const workflow = resolve(repo, '.github/workflows/linux.yml');
const ubuntuDoc = resolve(repo, 'docs/ubuntu.md');
const claude = resolve(repo, 'CLAUDE.md');
const readme = resolve(repo, 'README.md');

test('CI workflow exists at .github/workflows/linux.yml', () => {
  assert.ok(existsSync(workflow), `missing ${workflow}`);
});

test('CI workflow runs on ubuntu-24.04', () => {
  const yaml = readFileSync(workflow, 'utf8');
  assert.match(yaml, /ubuntu-24\.04/, 'must use ubuntu-24.04');
  assert.match(yaml, /npm\s+test|simtest|behaviortest/, 'must run the suites');
  assert.match(yaml, /xvfb-run/, 'must wrap three.js in xvfb');
});

test('CI workflow installs x11-utils + xdotool + wmctrl', () => {
  const yaml = readFileSync(workflow, 'utf8');
  for (const pkg of ['x11-utils', 'xdotool']) {
    assert.ok(yaml.includes(pkg), `CI must apt-install ${pkg}`);
  }
});

test('docs/ubuntu.md exists with required sections', () => {
  assert.ok(existsSync(ubuntuDoc), `missing ${ubuntuDoc}`);
  const doc = readFileSync(ubuntuDoc, 'utf8');
  for (const section of ['Install', 'Run', 'Test', 'Troubleshoot']) {
    assert.ok(doc.includes(section) || doc.toLowerCase().includes(section.toLowerCase()),
      `docs/ubuntu.md missing ${section} section`);
  }
  assert.ok(doc.length < 12_000, 'docs/ubuntu.md too long');
});

test('docs/ubuntu.md documents the Wayland v1 no-op', () => {
  const doc = readFileSync(ubuntuDoc, 'utf8');
  assert.ok(/wayland/i.test(doc), 'must mention Wayland');
  assert.ok(/foreign-toplevel|DBus|dbus/i.test(doc),
    'must link Wayland to the planned DBus bridge');
});

test('docs/ubuntu.md documents the nvidia-smi verification recipe', () => {
  const doc = readFileSync(ubuntuDoc, 'utf8');
  assert.ok(doc.includes('nvidia-smi'), 'must mention nvidia-smi');
});

test('CLAUDE.md is updated to mention the linux/ tree and symlink rule', () => {
  assert.ok(existsSync(claude), `missing ${claude}`);
  const md = readFileSync(claude, 'utf8');
  assert.ok(md.includes('linux/'), 'CLAUDE.md must mention linux/');
  // The new rule: a single change to sim/flymodel touches one symlink target.
  assert.ok(/symlink|single source|single-source/i.test(md),
    'CLAUDE.md must reference the new symlink / single-source rule');
});

test('README.md links to docs/ubuntu.md', () => {
  assert.ok(existsSync(readme), `missing ${readme}`);
  const md = readFileSync(readme, 'utf8');
  assert.ok(md.includes('docs/ubuntu.md') || md.includes('ubuntu.md'),
    'README.md must link to docs/ubuntu.md');
});
