import { parseWav, wavLayout } from './wav.js';
import { resample } from '../analysis/resample.js';

let audioContext = null;
let analyserNode = null;
let gainNode = null;
let sourceNode = null;
let audioBuffer = null;
let playing = false;
let startTime = 0;
let pauseOffset = 0;
let analyserBins = null;
let loopRegion = null; // { start, end } in seconds: when set, Play loops this part of the file

// Raw samples at the file's native rate, for analysis (never resampled).
let analysisPCM = null;
let analysisRate = 0;

const endedListeners = new Set();

// Heartbeat work needs seconds, not hours. Longer files are loaded in part so the
// browser does not run out of memory.
export const MAX_SECONDS = 300;

// Separate looping source for auditioning the grid-warped result.
let previewNode = null;
const previewListeners = new Set();

function getContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyserNode = audioContext.createAnalyser();
    // 8192 gives ~6 Hz bins at 48 kHz: enough to resolve heart sounds (20-200 Hz).
    analyserNode.fftSize = 8192;
    analyserNode.smoothingTimeConstant = 0.6;
    analyserBins = new Uint8Array(analyserNode.frequencyBinCount);
    gainNode = audioContext.createGain();
    gainNode.connect(analyserNode);
    analyserNode.connect(audioContext.destination);
  }
  return audioContext;
}

function killSource() {
  if (!sourceNode) return;
  sourceNode.onended = null;
  try { sourceNode.stop(); } catch { /* already stopped */ }
  sourceNode.disconnect();
  sourceNode = null;
}

/** Read a file into an AudioBuffer (plus the WAV details when it is one). Touches no playback state. */
async function readAudio(file) {
  const ctx = getContext();
  // For a long WAV, read only the first MAX_SECONDS from disk.
  let arrayBuffer = null;
  let fullDuration = null;
  const layout = wavLayout(await file.slice(0, 65536).arrayBuffer());
  if (layout) {
    const bytesPerSecond = layout.sampleRate * layout.blockAlign;
    const total = Math.min(layout.dataBytes, file.size - layout.dataOffset) / bytesPerSecond;
    if (total > MAX_SECONDS) {
      fullDuration = total;
      arrayBuffer = await file.slice(0, layout.dataOffset + MAX_SECONDS * bytesPerSecond).arrayBuffer();
    }
  }
  if (!arrayBuffer) arrayBuffer = await file.arrayBuffer();
  const wav = parseWav(arrayBuffer);

  let buffer = null;
  if (wav) {
    try {
      // Some browsers refuse very low rates (e.g. 4000 Hz); fall through if so.
      buffer = ctx.createBuffer(wav.channelData.length, wav.frames, wav.sampleRate);
      wav.channelData.forEach((d, c) => buffer.copyToChannel(d, c));
    } catch {
      buffer = null;
    }
  }
  if (!buffer) {
    buffer = await ctx.decodeAudioData(arrayBuffer);
    if (!wav && buffer.duration > MAX_SECONDS) {
      // Compressed formats have to be decoded whole; keep only the first part.
      fullDuration = buffer.duration;
      const keep = Math.round(MAX_SECONDS * buffer.sampleRate);
      const short = ctx.createBuffer(buffer.numberOfChannels, keep, buffer.sampleRate);
      for (let c = 0; c < buffer.numberOfChannels; c++) short.copyToChannel(buffer.getChannelData(c).subarray(0, keep), c);
      buffer = short;
    }
  }
  return { wav, buffer, fullDuration };
}

/**
 * Just the samples of a file, for batch work: nothing is loaded into the player.
 * @returns {Promise<{ pcm: Float32Array, sampleRate: number, duration: number }>}
 */
export async function decodePcm(file) {
  const { wav, buffer } = await readAudio(file);
  return wav
    ? { pcm: wav.mono, sampleRate: wav.sampleRate, duration: buffer.duration }
    : { pcm: buffer.getChannelData(0), sampleRate: buffer.sampleRate, duration: buffer.duration };
}

export async function decodeFile(file) {
  getContext();
  loopRegion = null;
  stop(); // never leave a previous file playing
  stopPreview();
  audioBuffer = null;
  analysisPCM = null;

  const { wav, buffer, fullDuration } = await readAudio(file);

  audioBuffer = buffer;
  if (wav) {
    analysisPCM = wav.mono;
    analysisRate = wav.sampleRate;
  } else {
    analysisPCM = buffer.getChannelData(0);
    analysisRate = buffer.sampleRate;
  }

  return {
    sampleRate: analysisRate,
    duration: buffer.duration,
    numberOfChannels: wav ? wav.channels : buffer.numberOfChannels,
    bitDepth: wav ? wav.bitDepth : null,
    nativeRate: Boolean(wav), // false = rate shown is the browser's resampled rate
    fullDuration, // set when only the first MAX_SECONDS of a longer file were loaded
  };
}

const inRegion = (t) => loopRegion && t >= loopRegion.start && t < loopRegion.end;

function startSource(offset) {
  const ctx = getContext();
  let from = offset;
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  if (loopRegion) {
    if (!inRegion(from)) from = loopRegion.start;
    sourceNode.loop = true;
    sourceNode.loopStart = loopRegion.start;
    sourceNode.loopEnd = loopRegion.end;
  }
  sourceNode.connect(gainNode);
  sourceNode.onended = () => {
    playing = false;
    pauseOffset = 0;
    sourceNode = null;
    endedListeners.forEach((cb) => cb());
  };
  sourceNode.start(0, from);
  startTime = ctx.currentTime - from;
  playing = true;
}

/**
 * Make Play loop one part of the recording (pass null to play the whole file again).
 * Takes effect at once if audio is playing.
 */
export function setLoopRegion(region) {
  const ok = region && audioBuffer && region.end - region.start >= 0.05;
  const at = getCurrentTime();
  loopRegion = ok
    ? { start: Math.max(0, region.start), end: Math.min(audioBuffer.duration, region.end) }
    : null;
  if (playing) {
    killSource();
    startSource(at);
  } else if (loopRegion && !inRegion(pauseOffset)) {
    pauseOffset = loopRegion.start;
  }
}

export function play() {
  if (!audioBuffer || playing) return;
  stopPreview();
  const ctx = getContext();
  if (ctx.state === 'suspended') ctx.resume();
  if (pauseOffset >= audioBuffer.duration) pauseOffset = 0;
  startSource(pauseOffset);
}

export function pause() {
  if (!playing) return;
  pauseOffset = getCurrentTime();
  killSource();
  playing = false;
}

export function stop() {
  killSource();
  pauseOffset = loopRegion ? loopRegion.start : 0;
  playing = false;
}

export function seek(seconds) {
  if (!audioBuffer) return;
  let t = Math.max(0, Math.min(seconds, audioBuffer.duration));
  if (loopRegion && !inRegion(t)) t = loopRegion.start; // while a loop is selected, playback stays inside it
  if (playing) {
    killSource();
    startSource(t);
  } else {
    pauseOffset = t;
  }
}

export function getCurrentTime() {
  if (!audioBuffer) return 0;
  if (!playing) return pauseOffset;
  let t = audioContext.currentTime - startTime;
  if (loopRegion && t >= loopRegion.end) {
    t = loopRegion.start + ((t - loopRegion.start) % (loopRegion.end - loopRegion.start));
  }
  return Math.min(t, audioBuffer.duration);
}

export function getDuration() {
  return audioBuffer ? audioBuffer.duration : 0;
}

/** Subscribe to natural end-of-playback. Returns an unsubscribe function. */
export function onEnded(cb) {
  endedListeners.add(cb);
  return () => endedListeners.delete(cb);
}

/** Raw mono samples at the native sample rate, for drawing and analysis. */
export function getAnalysisData() {
  if (!analysisPCM) return null;
  return { pcm: analysisPCM, sampleRate: analysisRate };
}

export function getAnalyserData() {
  if (!analyserNode) return null;
  analyserNode.getByteFrequencyData(analyserBins);
  return analyserBins;
}

export function getAnalyserBinHz() {
  if (!analyserNode) return 0;
  return audioContext.sampleRate / analyserNode.fftSize;
}

export function getIsPlaying() {
  return playing;
}

/** Loop a rendered buffer (e.g. the grid-warped heartbeat). Stops normal playback. */
export function startPreview(samples, sampleRate) {
  const ctx = getContext();
  if (ctx.state === 'suspended') ctx.resume();
  if (playing) {
    // Hand over from the transport, and let the UI know it stopped.
    stop();
    endedListeners.forEach((cb) => cb());
  }
  stopPreview();
  let buffer;
  try {
    buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
  } catch {
    // Browser refused this rate (e.g. 4000 Hz): convert to the context rate.
    const converted = resample(samples, sampleRate, ctx.sampleRate);
    buffer = ctx.createBuffer(1, converted.length, ctx.sampleRate);
    buffer.copyToChannel(converted, 0);
  }
  previewNode = ctx.createBufferSource();
  previewNode.buffer = buffer;
  previewNode.loop = true;
  previewNode.connect(gainNode);
  previewNode.start();
  previewListeners.forEach((cb) => cb(true));
}

export function stopPreview() {
  if (!previewNode) return;
  try { previewNode.stop(); } catch { /* already stopped */ }
  previewNode.disconnect();
  previewNode = null;
  previewListeners.forEach((cb) => cb(false));
}

/** Subscribe to preview start/stop. Returns an unsubscribe function. */
export function onPreviewChange(cb) {
  previewListeners.add(cb);
  return () => previewListeners.delete(cb);
}
