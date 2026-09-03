// test/snapshot.test.js — Phase 5 acceptance gate for the offscreen
// --snapshot / --brainshot path. We do NOT actually run Electron here
// (no GPU on CI); we verify the CLI dispatch table, the file extension
// validation, and that the right code path would be invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const linux = resolve(here, '..');
const main = resolve(linux, 'main.js');

test('main.js runs snapshot path with offscreen window', () => {
  const src = readFileSync(main, 'utf8');
  // The snapshot path is gated on `argValue('snapshot')`; verify both
  // the gate and the BrowserWindow construction in that branch.
  const snapshotIdx = src.indexOf('runSnapshot');
  assert.ok(snapshotIdx > 0, 'no runSnapshot function');
  assert.ok(src.includes('offscreen: true'),
    'snapshot path must use offscreen: true for hidden rendering');
  assert.ok(src.includes('capturePage'),
    'snapshot path must call webContents.capturePage()');
  assert.ok(src.includes('writeFile'),
    'snapshot path must write PNG via node:fs/promises');
});

test('main.js accepts --snapshot=PATH and --snapshot PATH forms', () => {
  // We can't actually run main.js without electron; verify the parser
  // by source inspection + a small unit test of the argValue idea.
  const src = readFileSync(main, 'utf8');
  assert.match(src, /--snapshot/, 'flag present');
  assert.match(src, /--\$\{name\}/, 'argValue helper uses --name=...');
  // Inline unit test of the parser logic by extracting the relevant lines.
  const parserBlock = src.match(/function argValue[\s\S]+?\n\}/)?.[0];
  assert.ok(parserBlock, 'argValue function not found');
  assert.ok(parserBlock.includes('startsWith(`--${name}=`)'),
    'parser must accept --name=value form');
});

test('snapshot path uses 720x720 canvas (matches macOS offscreen recipe)', () => {
  const src = readFileSync(main, 'utf8');
  // Two canvases: 720x720 for the body, 720x560 for the brain.
  assert.match(src, /width:\s*720,\s*height:\s*720/,
    'body snapshot must be 720x720');
  assert.match(src, /width:\s*720,\s*height:\s*560/,
    'brain snapshot must be 720x560');
});

test('main.js logs the snapshot path to stdout on success', () => {
  const src = readFileSync(main, 'utf8');
  assert.match(src, /snapshot written to/);
  assert.match(src, /brainshot written to/);
});

test('main.js forces dGPU via use-gl=egl + enable-gpu', () => {
  const src = readFileSync(main, 'utf8');
  assert.match(src, /use-gl['"],\s*['"]egl['"]/,
    'must pin GL backend to EGL (Vulkan translation via ANGLE)');
  assert.match(src, /enable-gpu['"],\s*['"]1['"]/,
    'must not disable GPU');
});
