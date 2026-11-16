import { parseWav } from './wav.js';
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

// Raw samples at the file's native rate, for analysis (never resampled).
let analysisPCM = null;
let analysisRate = 0;

const endedListeners = new Set();

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

export async function decodeFile(file) {
  const ctx = getContext();
  stop(); // never leave a previous file playing
  stopPreview();
  audioBuffer = null;
  analysisPCM = null;

  const arrayBuffer = await file.arrayBuffer();
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
  if (!buffer) buffer = await ctx.decodeAudioData(arrayBuffer);

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
  };
}

function startSource(offset) {
  const ctx = getContext();
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(gainNode);
  sourceNode.onended = () => {
    playing = false;
    pauseOffset = 0;
    sourceNode = null;
    endedListeners.forEach((cb) => cb());
  };
  sourceNode.start(0, offset);
  startTime = ctx.currentTime - offset;
  playing = true;
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
  pauseOffset = Math.min(audioContext.currentTime - startTime, audioBuffer.duration);
  killSource();
  playing = false;
}

export function stop() {
  killSource();
  pauseOffset = 0;
  playing = false;
}

export function seek(seconds) {
  if (!audioBuffer) return;
  const t = Math.max(0, Math.min(seconds, audioBuffer.duration));
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
  return Math.min(audioContext.currentTime - startTime, audioBuffer.duration);
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
