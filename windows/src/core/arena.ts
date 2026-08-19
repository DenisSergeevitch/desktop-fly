// core/arena.ts — the region the fly may occupy.
//
// macOS keeps the fly on ONE display and offers a "Move to Next Display" menu
// item. On Windows the desktop is one continuous space, so the overlay spans
// every display instead. That raises a problem the macOS build never has: a
// window must be rectangular, but two monitors of different sizes or vertical
// offsets do not tile a rectangle. The bounding box therefore contains regions
// that are on no display at all, and a fly walking there would simply vanish.
//
// So the overlay window uses the bounding box while the FLY is constrained to
// the union of the real display rectangles.

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Scene space: origin at the centre of the bounding box, y UP.
export interface SceneRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function unionBounds(rects: ScreenRect[]): ScreenRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function toSceneRects(rects: ScreenRect[]): SceneRect[] {
  const b = unionBounds(rects);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return rects.map((r) => ({
    x0: r.x - cx,
    x1: r.x + r.width - cx,
    y0: cy - (r.y + r.height),
    y1: cy - r.y,
  }));
}

export class Arena {
  readonly rects: SceneRect[];
  readonly width: number;
  readonly height: number;

  constructor(rects: SceneRect[]) {
    this.rects = rects;
    if (rects.length === 0) {
      this.width = 0;
      this.height = 0;
      return;
    }
    this.width = Math.max(...rects.map((r) => r.x1)) - Math.min(...rects.map((r) => r.x0));
    this.height = Math.max(...rects.map((r) => r.y1)) - Math.min(...rects.map((r) => r.y0));
  }

  contains(x: number, y: number, margin = 0): boolean {
    return this.rects.some((r) => x >= r.x0 + margin && x <= r.x1 - margin
      && y >= r.y0 + margin && y <= r.y1 - margin);
  }

  // Nearest point inside the union. Used when a walk step would carry the fly
  // into dead space: it slides along the display edge instead of vanishing.
  clamp(x: number, y: number, margin = 0): { x: number; y: number } {
    if (this.rects.length === 0) return { x, y };
    if (this.contains(x, y, margin)) return { x, y };
    let best = { x, y };
    let bestD = Infinity;
    for (const r of this.rects) {
      const cx = Math.min(Math.max(x, r.x0 + margin), r.x1 - margin);
      const cy = Math.min(Math.max(y, r.y0 + margin), r.y1 - margin);
      const d = (cx - x) ** 2 + (cy - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: cx, y: cy };
      }
    }
    return best;
  }

  // Area-weighted so a small second monitor is not picked as often as a big one.
  randomPoint(rnd: () => number, margin = 0): { x: number; y: number } {
    const usable = this.rects
      .map((r) => ({
        r,
        w: Math.max(0, r.x1 - r.x0 - 2 * margin),
        h: Math.max(0, r.y1 - r.y0 - 2 * margin),
      }))
      .filter((u) => u.w > 0 && u.h > 0);
    if (usable.length === 0) return { x: 0, y: 0 };
    const total = usable.reduce((s, u) => s + u.w * u.h, 0);
    let pick = rnd() * total;
    for (const u of usable) {
      pick -= u.w * u.h;
      if (pick <= 0) {
        return {
          x: u.r.x0 + margin + rnd() * u.w,
          y: u.r.y0 + margin + rnd() * u.h,
        };
      }
    }
    const last = usable[usable.length - 1];
    return {
      x: last.r.x0 + margin + rnd() * last.w,
      y: last.r.y0 + margin + rnd() * last.h,
    };
  }
}
