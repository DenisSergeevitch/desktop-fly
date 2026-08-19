// Prints what the Windows senses actually see on this machine. There is no unit
// test for the FFI layer, so this is its verification: run it, read the numbers,
// compare them with what is on screen.

import os from 'node:os';
import { WindowTerrain } from '../core/windowTerrain.ts';
import { InputSense, isSleepy } from '../core/idle.ts';
import { CpuSampler, tempoFromLoad } from '../core/tempo.ts';
import { circadianActivity } from '../core/circadian.ts';
import { unionBounds } from '../core/arena.ts';
import {
  enumerateWindows, lastInputTick, leftButtonClicked, monitorWorkAreas,
  tickCount, win32Available,
} from '../main/win32.ts';

// The arena the app actually uses: the union of every display's work area, read
// from the OS. This CLI runs under plain Node, which has no Electron `screen`
// module, so the rectangles come from EnumDisplayMonitors via the same koffi
// binding. Hardcoding a size here would make this diagnostic report ledges for a
// monitor that does not exist.
const areas = monitorWorkAreas();
const box = unionBounds(areas);
console.log(`win32 available: ${win32Available()}`);
console.log(`displays: ${areas.length} -> arena box ${box.width}x${box.height}`);
for (const a of areas) {
  console.log(`  display ${a.width}x${a.height} at ${a.x},${a.y}`);
}
console.log('NOTE: plain Node is not per-monitor DPI aware, so these rectangles '
  + 'are in a virtualized coordinate space and can differ from the running app, '
  + 'which declares awareness and converts every rect via screen.screenToDipRect.'
  + ' Counts and filtering are comparable; absolute coordinates are not.');
if (!win32Available()) process.exit(1);

const terrain = new WindowTerrain();
const input = new InputSense();
const cpu = new CpuSampler();
cpu.sample(os.cpus());

const raw = enumerateWindows();
const snap = terrain.poll(raw, box);
console.log(`windows enumerated: ${raw.length}`);
const usable = raw.filter((w) => w.visible && !w.cloaked && !w.toolWindow
  && w.hasTitle && !w.ownProcess);
console.log(`visible, titled, not cloaked: ${usable.length}`);
console.log(`ledges across the real arena: ${snap.ledges.length}`);
for (const L of snap.ledges.slice(0, 6)) {
  console.log(`  ledge y=${L.y} x=${L.x0}..${L.x1} (span ${L.x1 - L.x0}) id=${L.id}`);
}

// ids must be stable across polls or every window looks newly appeared
const second = terrain.poll(enumerateWindows(), box);
console.log(`second poll: ${second.ledges.length} ledges, `
  + `${second.newWindows.length} reported new (should be 0 if nothing opened)`);

const hour = new Date().getHours() + new Date().getMinutes() / 60;
console.log(`hour ${hour.toFixed(2)}, circadian activity `
  + `${circadianActivity(hour).toFixed(2)}`);

let clicks = 0;
let ticks = 0;
const timer = setInterval(() => {
  ticks++;
  if (leftButtonClicked()) clicks++;
  const s = input.sample(lastInputTick(), tickCount(), { x: 0, y: 0 });
  if (ticks % 30 === 0) {
    const busy = cpu.sample(os.cpus());
    console.log(`idle ${s.idleSeconds.toFixed(1)}s | typing ${s.typing.toFixed(2)}`
      + ` | clicks ${clicks} | cpu ${(busy * 100).toFixed(0)}%`
      + ` -> tempo ${tempoFromLoad(busy).toFixed(2)}`
      + ` | sleepy ${isSleepy(s.idleSeconds, hour)}`);
  }
  if (ticks >= 120) {
    clearInterval(timer);
    console.log('SENSETEST DONE');
  }
}, 1000 / 30);
