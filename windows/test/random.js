// Repeatable test stimuli for the intentionally stochastic FlyWire network and
// spontaneous behavior. Production continues to use the platform RNG.
export function resetRandom(label = 'desktop-fly-tests') {
  let state = 2166136261;
  for (const ch of label) state = Math.imul(state ^ ch.charCodeAt(0), 16777619) >>> 0;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
resetRandom();
