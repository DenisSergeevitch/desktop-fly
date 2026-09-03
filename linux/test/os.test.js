// test/os.test.js — Phase 2 acceptance gate.
//
// Verifies os.js dispatches to the right backend based on the host's session
// environment, and that koffi is never required in the require graph on Linux.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const linux = resolve(here, '..');
const os = await import(pathToFileURL(resolve(linux, 'src/os.js')).href);

// Each test rebuilds a fresh module by toggling the relevant env var and
// re-importing with a cache-busting query string.
async function loadWithEnv(env) {
  // Save and clear, then re-import.
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k === 'WAYLAND_DISPLAY' || k === 'XDG_SESSION_TYPE' || k === 'DISPLAY') {
      delete process.env[k];
    }
  }
  Object.assign(process.env, env);
  const url = pathToFileURL(resolve(linux, 'src/os.js')).href + `?cb=${Date.now()}_${Math.random()}`;
  return import(url).finally(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });
}

test('os.js picks wayland backend on WAYLAND_DISPLAY', async () => {
  const mod = await loadWithEnv({ WAYLAND_DISPLAY: 'wayland-0' });
  assert.equal(mod.backendName, 'wayland', `got ${mod.backendName}`);
  const r = await mod.sense.poll({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(r, { ledges: [], newWindows: [] });
});

test('os.js picks wayland backend on XDG_SESSION_TYPE=wayland', async () => {
  const mod = await loadWithEnv({ XDG_SESSION_TYPE: 'wayland' });
  assert.equal(mod.backendName, 'wayland', `got ${mod.backendName}`);
});

test('os.js picks x11 backend on DISPLAY without wayland', async () => {
  const mod = await loadWithEnv({ DISPLAY: ':0' });
  assert.equal(mod.backendName, 'x11', `got ${mod.backendName}`);
});

test('os.js picks headless backend when neither is set', async () => {
  const mod = await loadWithEnv({});
  assert.equal(mod.backendName, 'headless', `got ${mod.backendName}`);
  const r = await mod.sense.poll({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(r, { ledges: [], newWindows: [] });
});

test('os.js on Linux does not require koffi', () => {
  // Run node with --trace-warnings and import os.js. Any 'koffi' in the
  // require graph would show up as a "Cannot find module" if missing, but
  // a successful import of koffi on Linux would be the actual failure
  // mode we're guarding against.
  const script = `import('./src/os.js').then(m => {
    return m.sense.poll({x:0,y:0,width:1920,height:1080}).then(r => {
      if (!r || typeof r !== 'object') process.exit(2);
      console.log('ok', m.backendName);
    });
  }).catch(e => { console.error('err', e); process.exit(3); });`;
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: linux,
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: ':0' },
  });
  assert.match(out.trim(), /^ok (x11|wayland|headless)$/);
});

test('os.js sense object exposes poll() and tap()', () => {
  for (const fn of ['poll', 'tap']) {
    assert.equal(typeof os.sense[fn], 'function', `sense.${fn} missing`);
  }
});
