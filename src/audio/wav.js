// Minimal WAV reader. Gives us the file's TRUE sample rate and raw samples,
// which decodeAudioData hides by resampling to the AudioContext rate.
// Handles PCM 8/16/24/32-bit, float 32/64-bit, and WAVE_FORMAT_EXTENSIBLE.

function tag(view, off) {
  return String.fromCharCode(
    view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3),
  );
}

export function parseWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.byteLength < 44 || tag(v, 0) !== 'RIFF' || tag(v, 8) !== 'WAVE') return null;

  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let p = 12;
  while (p + 8 <= v.byteLength) {
    const id = tag(v, p);
    const size = v.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ' && body + 16 <= v.byteLength) {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = v.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, v.byteLength - body);
      break;
    }
    p = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0 || !fmt.channels || !fmt.sampleRate) return null;

  const { format, channels, bits } = fmt;
  const bytes = bits / 8;
  let read;
  if (format === 1 && bits === 8) read = (o) => (v.getUint8(o) - 128) / 128;
  else if (format === 1 && bits === 16) read = (o) => v.getInt16(o, true) / 32768;
  else if (format === 1 && bits === 24) {
    read = (o) => ((v.getInt8(o + 2) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o)) / 8388608;
  } else if (format === 1 && bits === 32) read = (o) => v.getInt32(o, true) / 2147483648;
  else if (format === 3 && bits === 32) read = (o) => v.getFloat32(o, true);
  else if (format === 3 && bits === 64) read = (o) => v.getFloat64(o, true);
  else return null;

  const frames = Math.floor(dataLen / (bytes * channels));
  if (frames < 1) return null;
  // Keep at most two channels (surround exports only need L/R here).
  const keep = Math.min(channels, 2);
  const channelData = [];
  for (let c = 0; c < keep; c++) channelData.push(new Float32Array(frames));
  const stride = bytes * channels;
  for (let i = 0; i < frames; i++) {
    const base = dataOff + i * stride;
    for (let c = 0; c < keep; c++) channelData[c][i] = read(base + c * bytes);
  }

  let mono = channelData[0];
  if (keep === 2) {
    mono = new Float32Array(frames);
    const [l, r] = channelData;
    for (let i = 0; i < frames; i++) mono[i] = 0.5 * (l[i] + r[i]);
  }

  return {
    sampleRate: fmt.sampleRate,
    channels,
    bitDepth: bits,
    frames,
    duration: frames / fmt.sampleRate,
    channelData,
    mono,
  };
}
