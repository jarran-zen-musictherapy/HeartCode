// Standard MIDI file (format 0) of the gridded heartbeat: S1 on every beat,
// S2 at its natural offset. Drop it on a drum or instrument track in a DAW.

const PPQ = 480;
const S1_NOTE = 36; // C1 (kick in General MIDI)
const S2_NOTE = 38; // D1 (snare in General MIDI)
const NOTE_TICKS = 60;

function varLen(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7) > 0) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

/**
 * @param {{ bpm: number, beats: { velocity: number, s2Offset: number|null }[] }} loop
 *   velocity 0..1 (relative loudness of S1); s2Offset in seconds after S1, or null
 * @returns {Uint8Array}
 */
export function makeMidi({ bpm, beats }) {
  const ticksPerSecond = (PPQ * bpm) / 60;
  const total = beats.length * PPQ;
  const events = []; // { tick, bytes }
  beats.forEach((b, k) => {
    const on = k * PPQ;
    const vel = Math.max(1, Math.min(127, Math.round(40 + 87 * b.velocity)));
    events.push({ tick: on, bytes: [0x90, S1_NOTE, vel] });
    events.push({ tick: on + NOTE_TICKS, bytes: [0x80, S1_NOTE, 0] });
    if (b.s2Offset !== null) {
      const t2 = on + Math.round(b.s2Offset * ticksPerSecond);
      if (t2 + NOTE_TICKS <= total) {
        events.push({ tick: t2, bytes: [0x90, S2_NOTE, Math.max(1, Math.round(vel * 0.7))] });
        events.push({ tick: t2 + NOTE_TICKS, bytes: [0x80, S2_NOTE, 0] });
      }
    }
  });
  events.sort((a, b) => a.tick - b.tick || a.bytes[0] - b.bytes[0]); // note-offs before note-ons

  const usPerBeat = Math.round(60e6 / bpm);
  const track = [
    0x00, 0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff,
    0x00, 0xff, 0x58, 0x04, 4, 2, 24, 8, // 4/4
  ];
  let now = 0;
  for (const e of events) {
    track.push(...varLen(e.tick - now), ...e.bytes);
    now = e.tick;
  }
  track.push(...varLen(total - now), 0xff, 0x2f, 0x00); // end of track exactly at the loop end

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff, (track.length >> 16) & 0xff, (track.length >> 8) & 0xff, track.length & 0xff,
  ];
  return Uint8Array.from([...header, ...track]);
}
