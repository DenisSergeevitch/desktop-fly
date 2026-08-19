// Bundles the three Electron entry points to dist/. esbuild only — no framework,
// matching the macOS build's "bare compiler, no project file" spirit.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2023' };

// core/data.ts has to run under Node ESM (tests, CLIs) and inside these
// CommonJS bundles, so it probes `import.meta.url` and falls back to __dirname.
// esbuild cannot express import.meta in cjs output and warns about it on every
// build; substituting an empty object resolves the probe at build time, keeping
// the fallback behaviour and silencing the noise. Do NOT "fix" this by emitting
// esm instead — Electron's main process cannot load an ESM entry point.
const cjs = { format: 'cjs', platform: 'node', define: { 'import.meta': '{}' } };

await mkdir('dist', { recursive: true });


await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main.cjs',
  ...cjs,
  // koffi is a NATIVE module: it must be required at runtime, never bundled.
  // Bundling it also exposed a sharp edge — the import.meta define above rewrote
  // koffi's own createRequire(import.meta.url) to createRequire(undefined),
  // which threw at load and hung the app before its first frame.
  external: ['electron', 'koffi'],
});

await build({
  ...common,
  entryPoints: ['src/renderer/preload.ts'],
  outfile: 'dist/preload.cjs',
  ...cjs,
  // koffi is a NATIVE module: it must be required at runtime, never bundled.
  // Bundling it also exposed a sharp edge — the import.meta define above rewrote
  // koffi's own createRequire(import.meta.url) to createRequire(undefined),
  // which threw at load and hung the app before its first frame.
  external: ['electron', 'koffi'],
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
  entryPoints: ['src/renderer/brain.ts'],
  outfile: 'dist/brain.js',
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
  ...cjs,
  // koffi is a NATIVE module: it must be required at runtime, never bundled.
  // Bundling it also exposed a sharp edge — the import.meta define above rewrote
  // koffi's own createRequire(import.meta.url) to createRequire(undefined),
  // which threw at load and hung the app before its first frame.
  external: ['electron', 'koffi'],
});

for (const f of ['index.html', 'snapshot.html', 'brain.html']) {
  await copyFile(`src/renderer/${f}`, `dist/${f}`);
}
console.log('bundled to dist/');
