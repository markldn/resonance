// Level trim in a worker (see js/trimcore.js): the engine renders every layer, gain_db is corrected, the document comes back.
import { loadEngine, trimCore } from './trimcore.js';
let P = null;
self.onmessage = async e => {
  const { id, doc, targets } = e.data;
  try {
    P ||= loadEngine(await (await fetch(new URL('./engine.worklet.js', import.meta.url))).text());
    self.postMessage({ id, doc, report: trimCore(P, doc, targets) });
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
