// Runs analysis and loop rendering off the main thread so the page stays
// responsive with long recordings. If a worker cannot be started (very old
// browser, locked-down hospital PC) the same code runs on the page instead.

import HcWorker from './hc.worker.js?worker&inline';
import { createHandler } from './handler.js';

let worker = null;
let local = null; // fallback handler
let seq = 0;
const waiting = new Map(); // id -> { resolve, reject, msg }
let lastAudio = null;
let lastAnalyse = null;

function fallBack() {
  if (worker) { worker.terminate(); worker = null; }
  local = createHandler();
  // Bring the fallback up to date, then redo whatever was in flight.
  if (lastAudio) local(lastAudio);
  const jobs = [...waiting.values()];
  waiting.clear();
  for (const job of jobs) {
    try { job.resolve(local(job.msg)); } catch (err) { job.reject(err); }
  }
}

function ensure() {
  if (worker || local) return;
  try {
    worker = new HcWorker();
    worker.onmessage = (e) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.result);
    };
    worker.onerror = (e) => { e.preventDefault(); fallBack(); };
  } catch {
    fallBack();
  }
}

function call(msg) {
  ensure();
  if (local) {
    // Yield first so the page can paint a "working" message.
    return new Promise((resolve, reject) => {
      setTimeout(() => { try { resolve(local(msg)); } catch (err) { reject(err); } }, 0);
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject, msg });
    worker.postMessage({ id, msg });
  });
}

/** Hand over a newly loaded recording. */
export function setAudio(pcm, sampleRate) {
  lastAudio = { type: 'audio', pcm, sampleRate };
  lastAnalyse = null;
  return call(lastAudio);
}

/** @returns {Promise<object>} the analysis (with an `id` that render requests must quote) */
export function analyse(opts, range = null) {
  lastAnalyse = { type: 'analyse', opts, range };
  return call(lastAnalyse);
}

// Only the newest render matters: while one is running, at most one more waits.
let running = false;
let queued = null;

function pump() {
  if (running || !queued) return;
  const job = queued;
  queued = null;
  running = true;
  call(job.msg)
    .then((r) => job.resolve(r && !r.stale ? r : null), () => job.resolve(null))
    .finally(() => { running = false; pump(); });
}

/**
 * @returns {Promise<null | { loop: object|null }>} null when this request was overtaken
 *   by a newer one (or by a new analysis); otherwise the loop, itself null if none can be built
 */
export function renderLoop(analysisId, settings) {
  return new Promise((resolve) => {
    if (queued) queued.resolve(null);
    queued = { msg: { type: 'render', analysisId, settings }, resolve };
    pump();
  });
}

export function oneShots(analysisId, settings, gain) {
  return call({ type: 'oneShots', analysisId, settings, gain });
}
