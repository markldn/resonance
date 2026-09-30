#!/usr/bin/env python3
"""Fit the unison beating of every key to the recordings.

    python3 tools/fit_beating.py instrument.json out.json recordings_dir [--jobs 12]

The strings of one note are slightly out of tune with each other, so the note's envelope ripples (beats). The engine reproduces it
from `detune_cents` (per key: [0, a, b] cents for three strings, [0, b] for two). For every key from note 31 up, all detune
pairs on a log grid are rendered and scored by how well the ripple of the envelope matches the recording's: 20 ms RMS in dB over the
first 3 s from the loudest attack, minus its own 0.4 s median (the slow decay), compared window by window. A key keeps a detune only
if it beats the same key played as a smooth unison by a clear margin; a ripple that is merely out of phase scores worse than smooth.
Run tools/calibrate_levels.py afterwards.
"""
import sys, os, json, argparse, importlib.util
import numpy as np, scipy.signal as ss
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ce', os.path.join(HERE, 'calibrate_envelope.py')); ce = importlib.util.module_from_spec(spec); spec.loader.exec_module(ce)
import soundfile as sf, glob
SR = ce.SR; W = 0.02; N = 150; SECS = 3.3

def ripple(x, ref=False):
    """(ripple of the 20 ms envelope in dB, mask of windows worth scoring) or None"""
    if np.abs(x).max() < 1e-7: return None
    o = ce.ai.onset(x, SR); x = x[o:]
    pk = max(range(40), key=lambda i: ce.rms(x, i * 0.01, i * 0.01 + 0.05)); x = x[int(pk * 0.01 * SR):]
    n = int(W * SR); m = min(N, len(x) // n)
    if m < 60: return None
    e = np.array([20 * np.log10(np.sqrt(np.mean(x[i * n:(i + 1) * n] ** 2)) + 1e-9) for i in range(m)])
    r = e - ss.medfilt(e, 21)
    lim = m
    if ref:
        rel = ce.ai.release_time(x, SR)
        if rel: lim = min(m, int((rel - 0.05) / W))
    ok = np.zeros(m, bool); ok[10:lim] = e[10:lim] > e.max() - 45
    return r, ok

def load_refs(rec):
    refs = {}
    for f in sorted(glob.glob(os.path.join(rec, '*.*'))):
        m, v = ce.ai.parse_name(f)
        if m is None or m < 31: continue
        try: x, sr = sf.read(f)
        except Exception: continue
        x = x.mean(1) if x.ndim > 1 else x
        if sr != SR: x = ss.resample_poly(x, SR, sr)
        r = ripple(x[:int(4 * SR)], ref=True)
        if r is not None and r[1].sum() > 30: refs[(m, v)] = r
    return refs

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('instrument'); ap.add_argument('out'); ap.add_argument('recordings'); ap.add_argument('--jobs', type=int, default=12)
    ap.add_argument('--margin', type=float, default=0.25, help='dB a detune must gain over smooth unison to be kept')
    a = ap.parse_args()
    doc = json.load(open(a.instrument)); refs = load_refs(a.recordings)
    have = {(k['note'], L['velocity']) for k in doc['keys'] for L in k['layers']}
    layers = sorted(l for l in refs if l in have); notes = sorted({m for m, _ in layers})
    print(f'{len(layers)} layers on {len(notes)} keys', file=sys.stderr)
    jobs = [{'note': m, 'vel': v, 'secs': SECS, 'params': json.loads(ce.PARAMS)} for m, v in layers]
    def evaluate(Dt):
        d = json.loads(json.dumps(doc))
        for k in d['keys']:
            k.pop('detune_cents', None)
            if k['note'] in Dt: k['detune_cents'] = Dt[k['note']]
        ys = ce.render(d, jobs, a.jobs); per = {}
        for l, y in zip(layers, ys):
            o = ripple(y); r, ok = refs[l]
            if o is None: s = 99.0
            else:
                n = min(len(r), len(o[0])); mk = ok[:n]
                s = float(np.mean(np.abs(o[0][:n][mk] - r[:n][mk]))) if mk.sum() > 20 else np.nan
            if not np.isnan(s): per.setdefault(l[0], []).append(s)
        return {m: float(np.mean(v)) for m, v in per.items()}
    smooth = evaluate({}); best = dict(smooth); Dt = {}
    old = {k['note']: k['detune_cents'] for k in doc['keys'] if k.get('detune_cents') and k['note'] in notes}      # the detunes the table already has compete too
    if old:
        sc = evaluate(old)
        for m in old:
            if m in sc and sc[m] < best[m]: best[m] = sc[m]; Dt[m] = old[m]
        print(f'existing detunes: {len(old)} keys, {sum(1 for m in old if m in Dt and best[m] < smooth[m] - a.margin)} beat smooth unison', file=sys.stderr)
    print(f'smooth unison: mean ripple error {np.mean(list(smooth.values())):.3f} dB', file=sys.stderr)
    grid = np.geomspace(0.1, 4.0, 14)
    for x in grid:
        for y in grid:
            if y < x: continue
            cand = {m: ([0, round(x, 3), round(y, 3)] if m >= 42 else [0, round(y, 3)]) for m in notes}
            sc = evaluate(cand)
            for m in notes:
                if m in sc and sc[m] < best[m] - 1e-9 and (m >= 42 or x == grid[0]): best[m] = sc[m]; Dt[m] = cand[m]
        print(f'a={x:.2f}: keys with a better detune {sum(1 for m in Dt if best[m] < smooth[m] - a.margin)}', file=sys.stderr, flush=True)
    keep = {m: d for m, d in Dt.items() if best[m] < smooth[m] - a.margin}
    print(f'kept {len(keep)} of {len(notes)} keys; mean ripple error {np.mean([keep.get(m) and best[m] or smooth[m] for m in notes]):.3f} dB (smooth {np.mean(list(smooth.values())):.3f})', file=sys.stderr)
    for k in doc['keys']:
        k.pop('detune_cents', None)
        if k['note'] in keep: k['detune_cents'] = keep[k['note']]
    dm = doc.setdefault('decay_model', {}); dm['note'] = (dm.get('note', '') + ' + unison beating fitted (tools/fit_beating.py)').lstrip(' +')
    json.dump(doc, open(a.out, 'w'), indent=1); print('wrote', a.out, file=sys.stderr)

if __name__ == '__main__': sys.exit(main())
