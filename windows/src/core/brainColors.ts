// core/brainColors.ts — the brain window's palettes, from BrainView.swift:39-49
// and :81-90. sRGB components in 0..1; convert with THREE.SRGBColorSpace at the
// point of use, or everything renders washed out (see M2b).

export type Rgb = [number, number, number];

// super_class palette, in the index order etl.py writes (etl.py:143).
// `optic` is the overwhelming majority of the 23,210 somas, so it is
// deliberately the dimmest: at equal brightness it drowns every other class and
// the cloud reads as undifferentiated fog.
export const SUPER_CLASS_COLORS: ReadonlyArray<Rgb> = [
  [0.16, 0.22, 0.34],   // optic — dim blue (majority, keep subtle)
  [0.45, 0.33, 0.16],   // central — amber
  [0.14, 0.36, 0.34],   // sensory — teal
  [0.10, 0.48, 0.62],   // visual_projection — cyan
  [0.38, 0.22, 0.55],   // visual_centrifugal — violet
  [0.62, 0.28, 0.10],   // descending — orange
  [0.20, 0.45, 0.18],   // ascending — green
  [0.55, 0.14, 0.14],   // motor — red
  [0.50, 0.25, 0.40],   // endocrine — pink
];

const UNKNOWN_CLASS: Rgb = [0.3, 0.3, 0.3];

export function superClassColor(index: number): Rgb {
  const c = SUPER_CLASS_COLORS[index];
  return c === undefined ? UNKNOWN_CLASS : c;
}

// The 668 simulated neurons are drawn brighter and larger on top of the cloud.
// LC4/LPLC2 share a colour (one looming population) and so do DNa01/DNa02 (one
// steering group); the giant fiber is the brightest thing in the circuit.
const ROLE_COLORS: Record<string, Rgb> = {
  lc4: [0.15, 0.85, 1.00],
  lplc2: [0.15, 0.85, 1.00],
  dna01: [1.00, 0.55, 0.10],
  dna02: [1.00, 0.55, 0.10],
  mdn: [1.00, 0.20, 0.80],
  dnp09: [0.25, 1.00, 0.35],
  dng11: [0.75, 0.55, 1.00],
  escw: [1.00, 0.35, 0.25],
  gf: [1.00, 0.95, 0.40],
  other: [0.45, 0.45, 0.50],
};

export function roleColor(role: string): Rgb {
  return ROLE_COLORS[role] ?? ROLE_COLORS.other;
}
