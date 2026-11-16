// Synthetic heart-sound generator with known beat times, for tests.
export function synthHeart({
  sampleRate = 4000, bpm = 72, seconds = 20, s1Amp = 1, s2Amp = 0.6,
  systole = 0.32, jitter = 0.02, noise = 0.02, seed = 1, lead = 0.4,
} = {}) {
  let state = seed;
  const rand = () => { // deterministic LCG
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

  const n = Math.round(seconds * sampleRate);
  const x = new Float32Array(n);
  const burst = (t0, amp, freq, len) => {
    const start = Math.round(t0 * sampleRate);
    const count = Math.round(len * sampleRate);
    for (let i = 0; i < count && start + i < n; i++) {
      const t = i / sampleRate;
      const w = Math.sin((Math.PI * i) / count) ** 2;
      x[start + i] += amp * w * Math.sin(2 * Math.PI * freq * t);
    }
  };
  const period = 60 / bpm;
  const s1 = [];
  let t = lead;
  while (t + period < seconds) {
    s1.push(t);
    burst(t, s1Amp, 55, 0.11);
    burst(t + systole, s2Amp, 80, 0.08);
    t += period * (1 + jitter * gauss());
  }
  for (let i = 0; i < n; i++) x[i] += noise * gauss();
  return { pcm: x, sampleRate, s1, bpm };
}
