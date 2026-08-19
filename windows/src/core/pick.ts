// core/pick.ts — turning a click in the brain window into a set of neurons to
// stimulate, and a human-readable name for what was hit.
// Transliterated from BrainView.swift:264-322, minus the SceneKit unprojection:
// the renderer supplies the ray, this module does the geometry.
//
// Positions are the flat Float32Array LIFSim already exposes (3 floats/neuron).

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Nearest neuron to the click ray by PERPENDICULAR distance, not by distance to
// the camera — so a neuron sitting behind another along the same line of sight is
// still reachable, and clicking "through" the cloud works.
export function nearestToRay(positions: Float32Array, n: number,
                             origin: Vec3, dir: Vec3): number {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len === 0 || n <= 0) return -1;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;

  let best = -1;
  let bestPerp = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = positions[3 * i] - origin.x;
    const ay = positions[3 * i + 1] - origin.y;
    const az = positions[3 * i + 2] - origin.z;
    const along = ax * dx + ay * dy + az * dz;
    const px = ax - along * dx;
    const py = ay - along * dy;
    const pz = az - along * dz;
    const perp = px * px + py * py + pz * pz;
    if (perp < bestPerp) {
      bestPerp = perp;
      best = i;
    }
  }
  return best;
}

const CLUSTER_RADIUS = 2.2;
const MIN_PICKED = 4;
const FALLBACK_PICKED = 6;
const MAX_PICKED = 60;

function distanceTo(positions: Float32Array, i: number, anchor: number): number {
  const dx = positions[3 * i] - positions[3 * anchor];
  const dy = positions[3 * i + 1] - positions[3 * anchor + 1];
  const dz = positions[3 * i + 2] - positions[3 * anchor + 2];
  return Math.hypot(dx, dy, dz);
}

// Everything within 2.2 units of the anchor — the "region" that got clicked.
// Two guards from BrainView.swift:284-292: a sparse anchor still returns the 6
// nearest, so clicking a thin area does something rather than nothing; and a
// dense one is capped at 60 nearest, so a click in the middle of the optic lobe
// does not stimulate half the circuit.
export function pickCluster(positions: Float32Array, n: number,
                            anchor: number): number[] {
  if (anchor < 0 || n <= 0) return [];
  const all = Array.from({ length: n }, (_, i) => i);
  let picked = all.filter((i) => distanceTo(positions, i, anchor) < CLUSTER_RADIUS);
  if (picked.length < MIN_PICKED) {
    picked = all
      .sort((a, b) => distanceTo(positions, a, anchor) - distanceTo(positions, b, anchor))
      .slice(0, FALLBACK_PICKED);
  } else if (picked.length > MAX_PICKED) {
    picked = picked
      .sort((a, b) => distanceTo(positions, a, anchor) - distanceTo(positions, b, anchor))
      .slice(0, MAX_PICKED);
  }
  return picked;
}

// BrainView.swift:300-322
export function regionName(roles: string[], types: string[],
                           positions: Float32Array, picked: number[]): string {
  if (picked.length === 0) return '⚡ nothing';
  const counts = new Map<string, number>();
  for (const i of picked) counts.set(roles[i], (counts.get(roles[i]) ?? 0) + 1);
  let major = roles[picked[0]];
  let majorCount = -1;
  for (const [role, c] of counts) {
    if (c > majorCount) {
      majorCount = c;
      major = role;
    }
  }

  // Which hemisphere dominates, if either. x < 0 is the fly's left.
  const sideSuffix = (role: string): string => {
    const ofRole = picked.filter((i) => roles[i] === role);
    const l = ofRole.filter((i) => positions[3 * i] < 0).length;
    const r = ofRole.length - l;
    if (l === r) return '';
    return l > r ? ' · left' : ' · right';
  };

  switch (major) {
    case 'lc4':
    case 'lplc2':
      return `⚡ Looming detectors (LC4/LPLC2)${sideSuffix(major)}`;
    case 'gf':
      return '⚡ Giant Fiber (DNp01) — escape!';
    case 'dna01':
    case 'dna02':
      return `⚡ Steering neurons (DNa01/02)${sideSuffix(major)}`;
    case 'dnp09':
      return '⚡ Walking command (DNp09)';
    case 'dng11':
      return '⚡ Grooming command (DNg11)';
    case 'escw':
      return '⚡ Escape-wing DNs (DNp02/04/11)';
    case 'mdn':
      return '⚡ Moonwalker neurons (MDN)';
    default: {
      const partner = picked.find((i) => roles[i] === 'other') ?? picked[0];
      let t = types[partner];
      if (t === undefined || t === '' || t === '?') t = 'central';
      return `⚡ ${t} neurons`;
    }
  }
}
