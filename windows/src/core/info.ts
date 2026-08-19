// core/info.ts — the one-line data summary the tray menu shows.
// main.swift:725 builds the same string for the macOS status item.
//
// The numbers come from the loaded files, never from literals: this line is what
// a user reads to confirm the real connectome is loaded, so it must not be able
// to claim 23,210 somas when something else was loaded.

import type { BrainPointsFile, CircuitFile } from './data.ts';

export function dataInfoLine(points: BrainPointsFile | null,
                             circuit: CircuitFile | null): string {
  if (points === null || circuit === null) return 'no data — run etl.py first';
  const somas = points.points.length.toLocaleString('en-US');
  const n = circuit.neurons.length.toLocaleString('en-US');
  const e = circuit.edges.length.toLocaleString('en-US');
  return `FlyWire v783 · ${somas} somas · circuit ${n}n/${e}e`;
}
