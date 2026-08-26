// win32.js — the Windows half of Environment.swift.
//
// macOS reads the window terrain with CGWindowListCopyWindowInfo and mouse
// button state through NSEvent global monitors. Neither exists here, so this
// module talks to user32/dwmapi through koffi:
//
//   CGWindowListCopyWindowInfo  ->  EnumWindows + DwmGetWindowAttribute
//   NSEvent global mouse monitor ->  GetAsyncKeyState(VK_LBUTTON/VK_RBUTTON)
//   CGEventSource idle           ->  Electron powerMonitor (see main.js)
//
// Everything here is poll-only and permission-free: it reads window geometry
// and whether a mouse button went down — never keystrokes, never window
// contents. Keyboard activity is inferred in main.js from the system idle
// timer, so no key is ever polled individually.

// koffi is CommonJS, and it is loaded lazily through createRequire so this
// module still imports (and simply reports "unavailable") on a machine where
// the native binding is missing or the platform is not Windows.
import { createRequire } from 'node:module';

const GW_OWNER = 4;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const DWMWA_CLOAKED = 14;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;

let api = null;

export function win32Available() { return loadApi() !== null; }

function loadApi() {
  if (api !== null) return api || null;
  if (process.platform !== 'win32') { api = false; return null; }
  try {
    const require = createRequire(import.meta.url);
    const koffi = require('koffi');

    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');

    const RECT = koffi.struct('RECT', {
      left: 'int32', top: 'int32', right: 'int32', bottom: 'int32',
    });
    koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr lParam)');

    api = {
      koffi,
      RECT,
      EnumWindows: user32.func(
        'bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
      GetWindowRect: user32.func(
        'bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)'),
      GetWindowLongPtrW: user32.func(
        'intptr __stdcall GetWindowLongPtrW(void *hwnd, int index)'),
      GetWindow: user32.func('void* __stdcall GetWindow(void *hwnd, unsigned int cmd)'),
      GetWindowThreadProcessId: user32.func(
        'unsigned int __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ unsigned int *pid)'),
      GetAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vKey)'),
      // one symbol, two output shapes — koffi needs a prototype per shape
      DwmCloaked: dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32',
        ['void *', 'uint32', koffi.out(koffi.pointer('int32')), 'uint32']),
      DwmFrameBounds: dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32',
        ['void *', 'uint32', koffi.out(koffi.pointer(RECT)), 'uint32']),
    };
    return api;
  } catch (e) {
    process.stderr.write(`win32: native window sensing unavailable (${e.message})\n`);
    api = false;
    return null;
  }
}

// Alt-tab-visible top-level windows with their on-screen frames, in physical
// pixels. Mirrors the CGWindowList filter: normal layer, not our own process,
// visible, at least 160x60.
export function listWindows(ownPid) {
  const a = loadApi();
  if (!a) return [];
  const out = [];
  const pidBox = [0];
  const cloakBox = [0];

  a.EnumWindows((hwnd) => {
    try {
      if (!a.IsWindowVisible(hwnd) || a.IsIconic(hwnd)) return true;
      if (a.GetWindowTextLengthW(hwnd) === 0) return true;
      if (a.GetWindow(hwnd, GW_OWNER)) return true;          // owned popup, not a real window
      const ex = Number(a.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      if (ex & WS_EX_TOOLWINDOW) return true;

      a.GetWindowThreadProcessId(hwnd, pidBox);
      if (pidBox[0] === ownPid) return true;                 // our own overlay / brain window

      // UWP keeps invisible "cloaked" ghost windows around; skip them
      if (a.DwmCloaked(hwnd, DWMWA_CLOAKED, cloakBox, 4) === 0 && cloakBox[0] !== 0) return true;

      // GetWindowRect includes the invisible resize border on Win10+, which
      // would float the walkable edge above the visible title bar.
      const rect = {};
      if (a.DwmFrameBounds(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) !== 0) {
        if (!a.GetWindowRect(hwnd, rect)) return true;
      }
      const w = rect.right - rect.left, h = rect.bottom - rect.top;
      if (w < 160 || h < 60) return true;

      out.push({
        id: Number(a.koffi.address(hwnd) & 0xffffffffn),
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      });
    } catch {
      // a window can die mid-enumeration; just skip it
    }
    return true;
  }, 0);
  return out;
}

// Mouse-button edges since the previous call. GetAsyncKeyState's low bit is
// "was pressed since you last asked", so a 30 Hz poll catches every click.
export function pollMouseButtons() {
  const a = loadApi();
  if (!a) return { left: false, right: false };
  return {
    left: (a.GetAsyncKeyState(VK_LBUTTON) & 1) !== 0,
    right: (a.GetAsyncKeyState(VK_RBUTTON) & 1) !== 0,
  };
}
