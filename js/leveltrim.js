// Runs js/trim.worker.js on a freshly measured instrument. takes: [{ midi, velocity, result }] as given to assemble().
export function trimLevels(doc, takes) {
  const targets = takes.filter(t => t.result && t.result.level_db != null).map(t => ({ note: t.midi, velocity: t.velocity, level: t.result.level_db }));
  if (!targets.length || typeof Worker === 'undefined') return Promise.resolve({ doc, report: null });
  return new Promise(res => {
    let w; try { w = new Worker(new URL('./trim.worker.js', import.meta.url), { type: 'module' }); } catch { res({ doc, report: null }); return; }
    w.onmessage = e => { w.terminate(); res(e.data.doc ? { doc: e.data.doc, report: e.data.report } : { doc, report: null }); };
    w.onerror = () => { w.terminate(); res({ doc, report: null }); };
    w.postMessage({ id: 1, doc, targets });
  });
}
