import { loadBrainData } from '../core/data.ts';

const data = loadBrainData();
if (data === null) {
  console.error('no data/ — run etl.py first');
  process.exit(1);
}

const { circuit, points } = data;
const census: Record<string, number> = {};
for (const n of circuit.neurons) census[n.role] = (census[n.role] ?? 0) + 1;
const syn = circuit.edges.reduce((s, e) => s + Math.abs(e[2]), 0);

console.log(`circuit: ${circuit.neurons.length} neurons, `
  + `${circuit.edges.length} edges, ${Math.round(syn)} synapses`);
console.log(`brain cloud: ${points.points.length} points, `
  + `${points.classes.length} super-classes`);
console.log('roles:', JSON.stringify(census));

const checks: Array<[string, boolean]> = [
  ['668 neurons', circuit.neurons.length === 668],
  ['18968 edges', circuit.edges.length === 18968],
  ['23210 brain points', points.points.length === 23210],
  ['2 giant fibers', census.gf === 2],
  ['314 looming detectors', census.lc4 + census.lplc2 === 314],
  ['330 partners', census.other === 330],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(failed.length === 0
  ? 'ALL DATA CHECKS PASS'
  : `${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
