let audioContext = null;
let analyserNode = null;
let gainNode = null;
let sourceNode = null;
let audioBuffer = null;
let isPlaying = false;
let startTime = 0;
let pauseOffset = 0;

function getContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    gainNode = audioContext.createGain();
    gainNode.connect(analyserNode);
    analyserNode.connect(audioContext.destination);
  }
  return audioContext;
}

export async function decodeFile(file) {
  const ctx = getContext();
  const arrayBuffer = await file.arrayBuffer();
  audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  pauseOffset = 0;
  return {
    sampleRate: audioBuffer.sampleRate,
    duration: audioBuffer.duration,
    numberOfChannels: audioBuffer.numberOfChannels,
  };
}

export function play() {
  if (!audioBuffer || isPlaying) return;
  const ctx = getContext();
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(gainNode);
  sourceNode.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      pauseOffset = 0;
    }
  };
  sourceNode.start(0, pauseOffset);
  startTime = ctx.currentTime - pauseOffset;
  isPlaying = true;
}

export function pause() {
  if (!isPlaying || !sourceNode) return;
  sourceNode.onended = null;
  sourceNode.stop();
  sourceNode.disconnect();
  sourceNode = null;
  pauseOffset = audioContext.currentTime - startTime;
  isPlaying = false;
}

export function stop() {
  if (sourceNode) {
    sourceNode.onended = null;
    sourceNode.stop();
    sourceNode.disconnect();
    sourceNode = null;
  }
  pauseOffset = 0;
  isPlaying = false;
}

export function getPCMData() {
  if (!audioBuffer) return null;
  return audioBuffer.getChannelData(0);
}

export function getAnalyserData() {
  if (!analyserNode) return null;
  const data = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(data);
  return data;
}

export function getIsPlaying() {
  return isPlaying;
}
