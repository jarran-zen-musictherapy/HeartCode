import { createHandler } from './handler.js';

const handle = createHandler();

self.onmessage = (e) => {
  const { id, msg } = e.data;
  try {
    self.postMessage({ id, result: handle(msg) });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
