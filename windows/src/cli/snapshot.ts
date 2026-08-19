// Offscreen fly render — the port of `./DesktopFly --snapshot out.png`.
//
// Runs under the electron binary, not plain Node: rendering needs a GL context,
// and the only headless Node option (headless-gl) requires a native build that
// this machine's missing MSVC toolchain cannot produce.
import { app, BrowserWindow, ipcMain } from 'electron';
import { loadBrainData } from '../core/data.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const out = outArg ?? 'fly.png';
// --brain renders the brain scene instead of the fly: the parity item for
// `./DesktopFly --brainshot` (main.swift:111-123).
const brain = process.argv.includes('--brain');

app.whenReady().then(async () => {
  if (brain) {
    ipcMain.handle('circuit', () => loadBrainData()?.circuit ?? null);
    ipcMain.handle('points', () => loadBrainData()?.points ?? null);
  }
  const win = new BrowserWindow({
    width: brain ? 720 : 720,
    height: brain ? 560 : 720,
    // useContentSize + frameless: without these the 720x720 canvas overflows a
    // smaller content area and the capture comes out non-square and cropped.
    useContentSize: true,
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: brain ? join(__dirname, 'preload.cjs') : undefined,
    },
  });
  await (brain
    ? win.loadFile(join(__dirname, 'brain.html'), { search: 'shot=1' })
    : win.loadFile(join(__dirname, 'snapshot.html')));
  // long enough to build the cloud; the brain also gets a burst of synthetic
  // spikes so the flashes appear, as the Swift preview does
  if (brain) {
    await new Promise((r) => setTimeout(r, 1200));
    const fake = Array.from({ length: 40 },
      () => ({ neuron: Math.floor(Math.random() * 660), isGF: false }));
    fake.push({ neuron: 0, isGF: true });
    win.webContents.send('spikes', fake);
    await new Promise((r) => setTimeout(r, 150));
  } else {
    await new Promise((r) => setTimeout(r, 400));
  }
  const img = await win.webContents.capturePage();
  await writeFile(out, img.toPNG());
  console.log(`snapshot written to ${out}`);
  app.quit();
}).catch((e: unknown) => {
  console.error('snapshot failed:', e);
  app.exit(1);
});
