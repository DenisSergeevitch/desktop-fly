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
  // --size=WxH reproduces a specific viewport. The live brain window is 340x280,
  // and point-cloud brightness depends on viewport size, so a 720x560 render is
  // not evidence about what the user actually sees.
  const sizeArg = process.argv.find((a) => a.startsWith('--size='));
  const [sw, sh] = sizeArg === undefined
    ? [brain ? 720 : 720, brain ? 560 : 720]
    : sizeArg.slice('--size='.length).split('x').map(Number);
  const win = new BrowserWindow({
    width: sw,
    height: sh,
    // useContentSize + frameless: without these the 720x720 canvas overflows a
    // smaller content area and the capture comes out non-square and cropped.
    useContentSize: true,
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: brain ? join(__dirname, 'preload.cjs') : undefined,
      // Without this a HIDDEN window's requestAnimationFrame is throttled, so the
      // captured frame can predate anything injected after load — which made two
      // renders with and without spikes come out byte-identical.
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    console.log(`[page ${e.level}] ${e.message}`);
  });
  await (brain
    ? win.loadFile(join(__dirname, 'brain.html'), { search: 'shot=1' })
    : win.loadFile(join(__dirname, 'snapshot.html')));
  // long enough to build the cloud; the brain also gets a burst of synthetic
  // spikes so the flashes appear, as the Swift preview does
  if (brain) {
    await new Promise((r) => setTimeout(r, 1200));
    // --nospikes renders the same frozen view without any flashes, so the two
    // images can be diffed to prove the flashes actually reach the screen.
    if (!process.argv.includes('--nospikes')) {
      const fake = Array.from({ length: 40 }, (_, i) => ({
        neuron: i * 13 % 660,   // deterministic, so the diff is reproducible
        isGF: false,
      }));
      fake.push({ neuron: 0, isGF: true });
      win.webContents.send('spikes', fake);
    }
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
