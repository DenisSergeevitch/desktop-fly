// The only bridge between main and the renderer. Exposes two subscriptions and
// nothing else — the renderer never gets `require` or direct ipcRenderer access.
import { contextBridge, ipcRenderer } from 'electron';

// The brain window's bridge. Kept separate from the overlay's so neither window
// can reach the other's channels.
contextBridge.exposeInMainWorld('desktopflyBrain', {
  getCircuit: () => ipcRenderer.invoke('circuit'),
  getPoints: () => ipcRenderer.invoke('points'),
  onSpikes: (cb: (s: unknown) => void) => {
    ipcRenderer.on('spikes', (_e, s) => cb(s));
  },
  stimulate: (indices: number[], strength: number, durationMs: number) => {
    ipcRenderer.send('stimulate', { indices, strength, durationMs });
  },
});

contextBridge.exposeInMainWorld('desktopfly', {
  // The renderer loads over file://, where Chromium blocks fetch(), so the
  // circuit comes from main (which does have filesystem access).
  //
  // PULL, not push: main used to send this on did-finish-load, but the renderer
  // script only subscribes after that event has already fired, so the message
  // arrived before anyone was listening and the overlay hung forever awaiting
  // it — no frames, no logs, and capturePage() never resolving. invoke/handle
  // has no such race.
  getCircuit: () => ipcRenderer.invoke('circuit'),
  getArena: () => ipcRenderer.invoke('arena'),
  onArena: (cb: (a: unknown) => void) => {
    ipcRenderer.on('arena', (_e, a) => cb(a));
  },
  sendSpikes: (batch: unknown) => {
    ipcRenderer.send('spikes', batch);
  },
  onStimulate: (cb: (s: unknown) => void) => {
    ipcRenderer.on('stimulate', (_e, s) => cb(s));
  },
  onSenses: (cb: (s: unknown) => void) => {
    ipcRenderer.on('senses', (_e, s) => cb(s));
  },
  onCommand: (cb: (c: string) => void) => {
    ipcRenderer.on('command', (_e, c) => cb(c));
  },
});
