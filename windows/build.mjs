// Bundles the three Electron entry points to dist/. esbuild only — no framework,
// matching the macOS build's "bare compiler, no project file" spirit.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2023' };

// EXPECTED WARNING: the cjs builds report `"import.meta" is not available with
// the "cjs" output format and will be empty`. That is exactly the case
// core/data.ts guards for — it falls back to __dirname when import.meta.url is
// absent, so the same file works under Node ESM (tests, CLIs) and inside this
// CommonJS bundle. Not a bug; do not "fix" it by switching the format, which
// Electron's main process cannot load.

await mkdir('dist', { recursive: true });


await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: ['src/renderer/preload.ts'],
  outfile: 'dist/preload.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

// The renderer bundles three; it is the only place a WebGLRenderer exists.
await build({
  ...common,
  entryPoints: ['src/renderer/overlay.ts'],
  outfile: 'dist/overlay.js',
  platform: 'browser',
  format: 'iife',
});

await build({
  ...common,
  entryPoints: ['src/cli/snapshotWindow.ts'],
  outfile: 'dist/snapshotWindow.js',
  platform: 'browser',
  format: 'iife',
});

await build({
  ...common,
  entryPoints: ['src/cli/snapshot.ts'],
  outfile: 'dist/snapshot.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

for (const f of ['index.html', 'snapshot.html']) {
  await copyFile(`src/renderer/${f}`, `dist/${f}`);
}
console.log('bundled to dist/');
