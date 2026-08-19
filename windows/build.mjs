// Bundles the three Electron entry points to dist/. esbuild only — no framework,
// matching the macOS build's "bare compiler, no project file" spirit.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2023' };

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
