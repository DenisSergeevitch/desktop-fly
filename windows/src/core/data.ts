import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BrainPointsFile {
  classes: string[];
  points: number[][];      // [x, y, z, classIndex]
}

export interface CircuitNeuron {
  id: string;
  type: string;            // FlyWire primary_type, or super_class for partners
  role: string;            // lc4 | lplc2 | gf | dna01 | dna02 | dnp09 |
                           // dng11 | mdn | escw | other
  side: string;            // left | right | center
  pos: number[];           // normalized [x, y, z]
}

export interface CircuitFile {
  neurons: CircuitNeuron[];
  edges: number[][];       // [preIdx, postIdx, signedSynCount]
}

// Equivalent of Sim.swift:38-47. The Windows build reads the repo's shared
// data/ in place — it is CC BY-NC 4.0 and is never copied into windows/.
// This module runs in two module systems: ESM under Node (tests and the
// diagnostic CLIs, via type stripping) and CommonJS inside the esbuild bundle
// that Electron's main process loads. `import.meta.url` is undefined in the CJS
// output, so resolve the directory defensively — otherwise fileURLToPath throws
// ERR_INVALID_ARG_TYPE and the overlay starts with no brain.
function moduleDir(): string {
  const url: unknown = typeof import.meta === 'object' ? import.meta.url : undefined;
  if (typeof url === 'string' && url.length > 0) return dirname(fileURLToPath(url));
  if (typeof __dirname === 'string') return __dirname;
  return process.cwd();
}

export function findDataDir(): string | null {
  const here = moduleDir();
  // A packaged app has no repo above it: the shared data/ is carried in as an
  // extra resource next to the app bundle. process.resourcesPath only exists
  // under Electron, so it is probed defensively — this module also runs under
  // plain Node for the test suites.
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resources === undefined ? [] : [join(resources, 'data')]),
    join(here, 'data'),                        // dist/data, if ever copied
    resolve(here, '..', '..', 'data'),         // windows/data
    resolve(here, '..', '..', '..', 'data'),   // repo root data/ (from src/core)
    resolve(here, '..', 'data'),               // windows/data (from dist/)
    resolve(here, '..', '..', 'data'),         // repo root data/ (from dist/)
    join(process.cwd(), 'data'),
    resolve(process.cwd(), '..', 'data'),
  ];
  return candidates.find((d) => existsSync(join(d, 'circuit.json'))) ?? null;
}

export function loadBrainData():
  { points: BrainPointsFile; circuit: CircuitFile } | null {
  const dir = findDataDir();
  if (dir === null) return null;
  try {
    const points = JSON.parse(
      readFileSync(join(dir, 'brain_points.json'), 'utf8')) as BrainPointsFile;
    const circuit = JSON.parse(
      readFileSync(join(dir, 'circuit.json'), 'utf8')) as CircuitFile;
    return { points, circuit };
  } catch {
    return null;
  }
}

