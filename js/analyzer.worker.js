// Worker wrapper: analyse recordings off the audio/UI thread.
import { analyzeNote } from './analyzer.js';
self.onmessage = e => {
  const { id, samples, sr, midi, opts } = e.data;
  try { self.postMessage({ id, result: analyzeNote(samples, sr, midi, opts || {}) }); }
  catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
