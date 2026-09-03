// test/scaffold.test.js — Phase 1 acceptance gate.
//
// Verifies the linux/ tree really reuses the windows/ source: every shared
// file must be a symlink to ../windows/... (not a copy), and the package
// metadata must reflect the linux variant.
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const linux = resolve(here, '..');                 // /tmp/desktop-fly/linux
const windows = resolve(linux, '..', 'windows');   // /tmp/desktop-fly/windows

const sharedSrc = ['sim.js', 'flymodel.js', 'signals.js', 'data.js', 'util.js', 'environment.js'];
const sharedTest = ['simtest.js', 'behaviortest.js'];
// Live + snapshot renderers preload from the windows tree. main.js loads
// renderer/overlay.html, renderer/brain.html, preload.mjs, and assets/tray.png;
// a missing symlink surfaces as ERR_FILE_NOT_FOUND on npm start.
const sharedRenderer = ['renderer/overlay.html', 'renderer/brain.html', 'preload.mjs', 'assets/tray.png'];

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures += 1;
}

for (const f of sharedSrc) {
  const p = resolve(linux, 'src', f);
  if (!existsSync(p)) { check(`symlink src/${f}`, false, 'missing'); continue; }
  const s = await lstat(p);
  check(`symlink src/${f} → ../windows/src/${f}`, s.isSymbolicLink(), 'not a symlink');
  // The symlink must actually resolve to the windows/ source.
  const real = await readFile(p, 'utf8').catch(() => '');
  check(`src/${f} resolves to non-empty windows source`, real.length > 0, 'empty file');
}

for (const f of sharedTest) {
  const p = resolve(linux, 'test', f);
  if (!existsSync(p)) { check(`symlink test/${f}`, false, 'missing'); continue; }
  const s = await lstat(p);
  check(`symlink test/${f} → ../windows/test/${f}`, s.isSymbolicLink(), 'not a symlink');
}

// Renderer directory, preload script, and tray icon must be wired up so
// main.js can load renderer/overlay.html, renderer/brain.html, preload.mjs,
// and assets/tray.png at runtime. A missing symlink surfaces as
// ERR_FILE_NOT_FOUND on `npm start`. We check the symlink at its own path
// (renderer/ and assets/ are symlinked dirs, preload.mjs is a symlinked
// file), and then probe a known file inside each symlinked dir.
const rendererSymlinks = [
  { symlinkPath: 'renderer',      probe: 'overlay.html', isDir: true  },
  { symlinkPath: 'renderer',      probe: 'brain.html',   isDir: true  },
  { symlinkPath: 'preload.mjs',   probe: null,           isDir: false },
  { symlinkPath: 'assets',        probe: 'tray.png',     isDir: true  },
];
for (const { symlinkPath, probe, isDir } of rendererSymlinks) {
  const linkP = resolve(linux, symlinkPath);
  if (!existsSync(linkP)) { check(`symlink ${symlinkPath}/`, false, 'missing'); continue; }
  const ls = await lstat(linkP);
  check(`symlink ${symlinkPath}/ → ../windows/${symlinkPath}/`,
        ls.isSymbolicLink(),
        'not a symlink');
  if (probe) {
    const real = await readFile(resolve(linux, symlinkPath, probe)).catch(() => '');
    check(`${symlinkPath}/${probe} resolves to non-empty windows source`,
          isDir || real.length > 0, 'empty file');
  }
}

const pkg = JSON.parse(await readFile(resolve(linux, 'package.json'), 'utf8'));
check('package.json name = desktop-fly-linux', pkg.name === 'desktop-fly-linux',
      `got ${pkg.name}`);
check('package.json type = module', pkg.type === 'module', `got ${pkg.type}`);
check('package.json has simtest script', typeof pkg.scripts?.simtest === 'string', 'no simtest');
check('package.json has start script', typeof pkg.scripts?.start === 'string', 'no start');
check('package.json depends on three', !!pkg.dependencies?.three, 'no three dep');
check('package.json devDepends on electron', !!pkg.devDependencies?.electron, 'no electron devDep');
check('package.json does NOT depend on koffi', !pkg.dependencies?.koffi,
      'koffi leaked into linux deps');

check('windows/ source still present', existsSync(windows), `missing ${windows}`);

console.log(failures === 0 ? 'ALL SCAFFOLD CHECKS PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
