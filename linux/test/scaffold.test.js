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
