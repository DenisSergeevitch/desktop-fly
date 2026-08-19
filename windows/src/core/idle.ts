// core/idle.ts — user idleness, sleep, and typing "vibration".
// From main.swift:766-776 and Environment.swift:82-88.
//
// SUBSTITUTION: macOS asks CGEventSource for KEYBOARD-ONLY idleness. Windows'
// GetLastInputInfo reports combined input, so keyboard activity is inferred as
// "the last-input tick advanced while the cursor did not move". This keeps the
// macOS build's privacy property exactly intact: we learn WHEN input happened,
// never which key it was.

const TYPING_EMA = 0.15;        // main.swift:768
const NIGHT_IDLE_SECONDS = 600;
const ANYTIME_IDLE_SECONDS = 1800;

// main.swift:774
export function isSleepy(idleSeconds: number, hour: number): boolean {
  return (idleSeconds > NIGHT_IDLE_SECONDS && (hour >= 22 || hour < 6))
    || idleSeconds > ANYTIME_IDLE_SECONDS;
}

export interface InputSample {
  idleSeconds: number;
  keyboardActive: boolean;
  typing: number;
}

export class InputSense {
  typing = 0;
  private prevInputTick: number | null = null;
  private prevCursor: { x: number; y: number } | null = null;

  sample(lastInputTick: number, nowTick: number,
         cursor: { x: number; y: number }): InputSample {
    const idleSeconds = Math.max(0, (nowTick - lastInputTick) / 1000);

    const inputAdvanced = this.prevInputTick !== null
      && lastInputTick > this.prevInputTick;
    const cursorMoved = this.prevCursor !== null
      && (cursor.x !== this.prevCursor.x || cursor.y !== this.prevCursor.y);
    const keyboardActive = inputAdvanced && !cursorMoved;

    this.prevInputTick = lastInputTick;
    this.prevCursor = { x: cursor.x, y: cursor.y };

    this.typing += ((keyboardActive ? 1 : 0) - this.typing) * TYPING_EMA;
    return { idleSeconds, keyboardActive, typing: this.typing };
  }
}
