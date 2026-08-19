// main/win32.ts — the Win32 boundary, via koffi (prebuilt FFI, no compiler).
//
// Everything here is permission-free: no elevation, no installed hook, nothing
// that can observe WHICH key was pressed. EnumWindows/GetWindowRect for terrain,
// GetLastInputInfo for idleness, GetAsyncKeyState for clicks.
//
// Every entry point is wrapped. If koffi will not load, or any call throws, the
// module reports unavailable and returns empty/neutral values forever after —
// the fly keeps walking, exactly as macOS does when CGWindowListCopyWindowInfo
// returns nil (Environment.swift:27-30).

import koffiRaw from 'koffi';
import type { RawWindow } from '../core/windowTerrain.ts';

// koffi 3.1 ships an incomplete index.d.ts: `proto`, `register`, `unregister`
// and `address` all exist at runtime (verified against Object.keys) but are not
// declared. Declare exactly the slice this file uses instead of spreading `any`.
type KoffiFn = (...args: never[]) => unknown;
interface KoffiApi {
  load(path: string): {
    func(definition: string): KoffiFn;
    func(name: string, result: string, args: unknown[]): KoffiFn;
  };
  struct(name: string, def: Record<string, string>): unknown;
  proto(definition: string): unknown;
  pointer(ref: unknown): unknown;
  register(fn: (...args: never[]) => unknown, type: unknown): unknown;
  unregister(handle: unknown): void;
  address(ptr: unknown): number | bigint;
}
const koffi = koffiRaw as unknown as KoffiApi;

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const DWMWA_CLOAKED = 14;
const VK_LBUTTON = 0x01;

interface Bindings {
  EnumWindows: KoffiFn;
  IsWindowVisible: KoffiFn;
  GetWindowRect: KoffiFn;
  GetWindowTextLengthW: KoffiFn;
  GetWindowLongPtrW: KoffiFn;
  GetWindowThreadProcessId: KoffiFn;
  DwmGetWindowAttribute: KoffiFn;
  GetLastInputInfo: KoffiFn;
  GetAsyncKeyState: KoffiFn;
  GetTickCount: KoffiFn;
  EnumWindowsProc: unknown;
}

let bindings: Bindings | null = null;
let failed = false;
let reportedFailure = false;

function note(what: string, err: unknown): void {
  if (reportedFailure) return;
  reportedFailure = true;
  console.error(`win32 unavailable (${what}): ${String(err)}; `
    + 'the fly will run without desktop senses');
}

function load(): Bindings | null {
  if (bindings !== null) return bindings;
  if (failed) return null;
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const dwmapi = koffi.load('dwmapi.dll');

    koffi.struct('RECT', {
      left: 'long', top: 'long', right: 'long', bottom: 'long',
    });
    koffi.struct('LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });
    // koffi.register() wants a POINTER to the prototype; handing it the bare
    // proto fails with "expected <callback> * type". Verified both forms.
    const EnumWindowsProc = koffi.pointer(
      koffi.proto('bool EnumWindowsProc(void *hwnd, intptr lparam)'));

    bindings = {
      EnumWindows: user32.func('bool EnumWindows(EnumWindowsProc *cb, intptr lparam)'),
      IsWindowVisible: user32.func('bool IsWindowVisible(void *hwnd)'),
      GetWindowRect: user32.func('bool GetWindowRect(void *hwnd, _Out_ RECT *rect)'),
      GetWindowTextLengthW: user32.func('int GetWindowTextLengthW(void *hwnd)'),
      GetWindowLongPtrW: user32.func('intptr GetWindowLongPtrW(void *hwnd, int index)'),
      GetWindowThreadProcessId:
        user32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
      DwmGetWindowAttribute:
        dwmapi.func('int DwmGetWindowAttribute(void *hwnd, uint32 attr, _Out_ int32 *value, uint32 size)'),
      GetLastInputInfo: user32.func('bool GetLastInputInfo(_Inout_ LASTINPUTINFO *info)'),
      GetAsyncKeyState: user32.func('int16 GetAsyncKeyState(int key)'),
      GetTickCount: kernel32.func('uint32 GetTickCount()'),
      EnumWindowsProc,
    };
    return bindings;
  } catch (e) {
    failed = true;
    note('load', e);
    return null;
  }
}

export function win32Available(): boolean {
  return load() !== null;
}

export function tickCount(): number {
  const b = load();
  if (b === null) return Date.now();
  try {
    return (b.GetTickCount as () => number)();
  } catch (e) {
    note('GetTickCount', e);
    return Date.now();
  }
}

// Idle milliseconds are derived by the caller as tickCount() - lastInputTick().
export function lastInputTick(): number {
  const b = load();
  if (b === null) return tickCount();
  try {
    const info = { cbSize: 8, dwTime: 0 };
    if ((b.GetLastInputInfo as (i: unknown) => boolean)(info) !== true) return tickCount();
    return info.dwTime;
  } catch (e) {
    note('GetLastInputInfo', e);
    return tickCount();
  }
}

// True once per physical press: GetAsyncKeyState's 0x0001 bit means "pressed
// since the last call", so polling it turns one click into one tap.
export function leftButtonClicked(): boolean {
  const b = load();
  if (b === null) return false;
  try {
    const state = (b.GetAsyncKeyState as (k: number) => number)(VK_LBUTTON);
    return (state & 0x0001) !== 0;
  } catch (e) {
    note('GetAsyncKeyState', e);
    return false;
  }
}

// `scale` converts physical pixels (what Win32 reports) into DIPs (what the rest
// of the port works in). Pass the scale factor of the display being polled.
export function enumerateWindows(scale = 1): RawWindow[] {
  const b = load();
  if (b === null) return [];
  const out: RawWindow[] = [];
  const ownPid = process.pid;
  try {
    const cb = koffi.register((hwnd: unknown, _lparam: number): boolean => {
      try {
        const rect = {} as { left: number; top: number; right: number; bottom: number };
        const getRect = b.GetWindowRect as (h: unknown, r: unknown) => boolean;
        if (getRect(hwnd, rect) !== true) return true;

        const cloak = [0];
        let cloaked = false;
        const dwmGet = b.DwmGetWindowAttribute as
          (h: unknown, a: number, v: unknown, s: number) => number;
        if (dwmGet(hwnd, DWMWA_CLOAKED, cloak, 4) === 0) {
          cloaked = cloak[0] !== 0;
        }
        const pidOut = [0];
        (b.GetWindowThreadProcessId as (h: unknown, p: unknown) => number)(hwnd, pidOut);
        const exStyle = Number((b.GetWindowLongPtrW as
          (h: unknown, i: number) => number | bigint)(hwnd, GWL_EXSTYLE));

        out.push({
          // The HWND itself, so the id is STABLE across polls. An array index
          // would change as windows open and close, making every poll report
          // every window as newly appeared (and breaking ledge tracking, which
          // matches a walked-on ledge to its window by id).
          id: Number(koffi.address(hwnd)),
          x: Math.round(rect.left / scale),
          y: Math.round(rect.top / scale),
          width: Math.round((rect.right - rect.left) / scale),
          height: Math.round((rect.bottom - rect.top) / scale),
          visible: (b.IsWindowVisible as (h: unknown) => boolean)(hwnd) === true,
          toolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0,
          cloaked,
          hasTitle: (b.GetWindowTextLengthW as (h: unknown) => number)(hwnd) > 0,
          ownProcess: pidOut[0] === ownPid,
        });
      } catch {
        // one bad window must not abort the enumeration
      }
      return true;
    }, b.EnumWindowsProc);

    try {
      (b.EnumWindows as (c: unknown, l: number) => boolean)(cb, 0);
    } finally {
      koffi.unregister(cb);
    }
  } catch (e) {
    note('EnumWindows', e);
    return [];
  }
  return out;
}
