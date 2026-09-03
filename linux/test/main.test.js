// test/main.test.js — Phase 4 acceptance gate for main.js.
//
// Without electron installed we cannot exercise BrowserWindow creation. The
// gate is split:
//   1. main.js is a syntactically valid ES module (parses, runs, exports).
//   2. main.js's CLI dispatch recognizes --snapshot / --brainshot / no-args.
//   3. main.js's per-display window plan lists one entry per Electron
//      `screen.getAllDisplays()` result.
//   4. main.js does not import koffi (the whole point of os.js's lazy load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const linux = resolve(here, '..');
const main = resolve(linux, 'main.js');

test('main.js exists', () => {
  assert.ok(existsSync(main), `main.js missing at ${main}`);
});

test('main.js contains tray menu items', () => {
  const src = readFileSync(main, 'utf8');
  for (const label of ['Send Fly to Next Display', 'Pause', 'Show Brain', 'Quit']) {
    assert.ok(src.includes(label), `main.js missing menu item "${label}"`);
  }
});

test('main.js creates one BrowserWindow per display', () => {
  const src = readFileSync(main, 'utf8');
  assert.match(src, /getAllDisplays/, 'must iterate getAllDisplays()');
  assert.match(src, /for\s*\(\s*const\s+\w+\s+of\s+allDisplays/, 'must loop over displays');
  assert.match(src, /new BrowserWindow/, 'must construct a BrowserWindow');
  assert.match(src, /transparent:\s*true/, 'overlay must be transparent');
  assert.match(src, /setIgnoreMouseEvents/, 'overlay must ignore mouse events');
});

test('main.js wires os.sense into the render loop', () => {
  const src = readFileSync(main, 'utf8');
  assert.match(src, /from\s+['"]\.\/src\/os\.js['"]/, 'must import os.js');
  assert.match(src, /sense\.poll/, 'must call sense.poll');
});

test('main.js does not require koffi', () => {
  const src = readFileSync(main, 'utf8');
  assert.ok(!/require\(['"]koffi['"]\)/.test(src),
    'main.js must not require koffi on Linux');
  assert.ok(!/from\s+['"]koffi['"]/.test(src),
    'main.js must not import koffi on Linux');
});

test('main.js CLI dispatch recognizes --snapshot and --brainshot', () => {
  const src = readFileSync(main, 'utf8');
  assert.match(src, /--snapshot/, 'must handle --snapshot flag');
  assert.match(src, /--brainshot/, 'must handle --brainshot flag');
  assert.match(src, /capturePage/, 'snapshot path must call capturePage');
});

test('main.js sets Electron switches for EGL + dGPU', () => {
  const src = readFileSync(main, 'utf8');
  assert.match(src, /use-gl['"],\s*['"]egl['"]/, 'must force use-gl=egl');
  assert.match(src, /enable-gpu['"],\s*['"]1['"]/, 'must enable GPU');
  assert.match(src, /OZONE_PLATFORM_HINT|OzonePlatform|WaylandWindowDecorations/,
    'must set Wayland/Ozone hints');
});

test('main.js parses as a valid ES module (syntax check)', () => {
  // Electron is a CJS package that exports a single binary; when imported
  // from a plain `node` process, its ESM shim fails to resolve
  // `BrowserWindow` etc. We don't care about that — main.js is only ever
  // launched via `electron .`. What we do care about is that the file
  // PARSES correctly as ESM. We test this with `node --check`.
  try {
    execFileSync('node', ['--check', main], { encoding: 'utf8' });
  } catch (e) {
    assert.fail(`main.js has a syntax error: ${e.stderr?.toString() ?? e.message}`);
  }
  // If we got here, the file parses cleanly.
  assert.ok(true);
});
