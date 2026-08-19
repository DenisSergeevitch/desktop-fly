// core/windowTerrain.ts — window rectangles become walkable ledges, and newly
// appeared windows become looming objects. Transliterated from
// Environment.swift:16-68 (WindowSense).
//
// Pure: takes already-gathered rectangles and returns scene-space terrain. The
// Win32 enumeration that produces those rectangles lives in main/win32.ts, so
// every rule here is testable on any machine.

import type { Ledge } from './types.ts';

export interface RawWindow {
  id: number;          // HWND, as a number
  x: number;           // screen DIPs, origin top-left of the primary display
  y: number;           // y DOWN
  width: number;
  height: number;
  visible: boolean;
  toolWindow: boolean;  // WS_EX_TOOLWINDOW: palettes, not real windows
  cloaked: boolean;     // DWMWA_CLOAKED: suspended UWP apps, other desktops
  hasTitle: boolean;
  ownProcess: boolean;  // our own overlay must never be terrain
}

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerrainSnapshot {
  ledges: Ledge[];
  newWindows: Array<{ center: { x: number; y: number }; size: number }>;
}

const MIN_WIDTH = 160;
const MIN_HEIGHT = 60;
const EDGE_INSET = 15;      // keep ledges off the very screen edge
const BAND_MARGIN = 8;      // ignore edges hugging the top or bottom
const MIN_SPAN = 100;       // narrower than this is not worth walking
const MAX_LEDGES = 12;

export class WindowTerrain {
  private knownIds = new Set<number>();
  private first = true;

  poll(windows: RawWindow[], display: DisplayRect): TerrainSnapshot {
    const W = display.width;
    const H = display.height;
    const centerX = display.x + W / 2;
    const centerY = display.y + H / 2;

    const ledges: Ledge[] = [];
    const newWindows: TerrainSnapshot['newWindows'] = [];
    const ids = new Set<number>();

    for (const w of windows) {
      // Visibility filters: these decide whether the window exists at all, for
      // both terrain and looming.
      if (!w.visible || w.toolWindow || w.cloaked || !w.hasTitle || w.ownProcess) {
        continue;
      }
      // only windows overlapping the fly's current display
      const offDisplay = w.x + w.width <= display.x || w.x >= display.x + W
        || w.y + w.height <= display.y || w.y >= display.y + H;
      if (offDisplay) continue;

      ids.add(w.id);

      // A window that just appeared looms even if it is far too small to stand
      // on, so this check comes before the walkability filters.
      if (!this.first && !this.knownIds.has(w.id)) {
        newWindows.push({
          center: { x: w.x + w.width / 2 - centerX, y: centerY - (w.y + w.height / 2) },
          size: Math.max(w.width, w.height),
        });
      }

      if (w.width < MIN_WIDTH || w.height < MIN_HEIGHT) continue;

      // scene coords: centred on this display, y up
      const topY = centerY - w.y;
      const x0 = Math.max(w.x - centerX, -W / 2 + EDGE_INSET);
      const x1 = Math.min(w.x + w.width - centerX, W / 2 - EDGE_INSET);
      if (topY < H / 2 - BAND_MARGIN && topY > -H / 2 + BAND_MARGIN
          && x1 - x0 > MIN_SPAN && ledges.length < MAX_LEDGES) {
        ledges.push({ y: topY, x0, x1, id: w.id });
      }
    }

    this.knownIds = ids;
    this.first = false;
    return { ledges, newWindows };
  }
}
