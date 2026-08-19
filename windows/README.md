# DesktopFly for Windows

Windows port of DesktopFly. The brain is the same: the same `data/` files, the
same 668-neuron FlyWire v783 circuit, the same 1 kHz LIF dynamics.

**Status: M1 — core sim, headless.** No window and no fly yet; the simulation
and its diagnostics run under Node.

## Requirements

Node >= 24 (for native TypeScript type stripping). No dependencies.

## Commands

```sh
cd windows
node --test               # unit tests (30)
npm run datatest          # data invariants (668 neurons / 18,968 edges / 23,210 points)
npm run simtest           # circuit diagnostics, Swift-parity exit conditions
npm run simtest:strict    # also asserts the ranges the Swift suite only prints
```

`--seed=N` picks the RNG seed for either simtest variant (default 1).

## Verified against the macOS build's documented invariants

- Giant fiber silent across 4 s of rest.
- Giant fiber fires **4 ms** after an abrupt loom — at every seed tested (1-8),
  matching the ~4 ms the root README claims.
- Siesta (`activityScale` 0.84) slows the fly without silencing it.
- Population rate ~5-7 Hz/neuron at rest.

## Differences from the macOS build

- **Seeded RNG.** `LIFSim` takes a seed so the suites are reproducible; the
  Swift build uses a non-deterministic system RNG.
- **`groomDrive` is clamped** to 0..1.3 like its five siblings. Behaviorally
  inert: it is only compared against the 0.5/0.3 hysteresis thresholds.
- **No locks.** `SpikeBus` and the stimulation queue need none — a JS context is
  single-threaded, where macOS steps the sim on the SceneKit render thread.
- Parity with the macOS build is behavioral and statistical, never
  spike-for-spike.

One finding worth recording: **walk-drive duty is seed-dependent**, spanning
17-43% (mean 32%) across seeds 1-8, because the circuit's 330 partner neurons
draw random baselines that set the drive onto DNp09. `CLAUDE.md` describes it as
"20-50%", which is a typical run rather than a bound — the Swift build has the
same spread, reshuffled every run by its system RNG. The 20-50% claim is
asserted here as a mean across seeds (`dynamics.test.ts`); the per-run gate in
`--simtest --strict` is 10-60%.

See `docs/superpowers/specs/2026-08-19-windows-port-design.md` for the full
design, including the Win32 sensing substitutions planned for M3.
