// Offscreen fly render — the port of `./DesktopFly --snapshot out.png`.
//
// Runs under the electron binary, not plain Node: rendering needs a GL context,
// and the only headless Node option (headless-gl) requires a native build that
// this machine's missing MSVC toolchain cannot produce.
import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const out = outArg ?? 'fly.png';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 720,
    height: 720,
    // useContentSize + frameless: without these the 720x720 canvas overflows a
    // smaller content area and the capture comes out non-square and cropped.
    useContentSize: true,
    frame: false,
    show: false,
    webPreferences: { contextIsolation: true },
  });
  await win.loadFile(join(__dirname, 'snapshot.html'));
  // one extra frame so the render lands before the capture
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  await writeFile(out, img.toPNG());
  console.log(`snapshot written to ${out}`);
  app.quit();
}).catch((e: unknown) => {
  console.error('snapshot failed:', e);
  app.exit(1);
});
