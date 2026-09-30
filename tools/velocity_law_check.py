#!/usr/bin/env python3
"""Test the engine's velocity law against real recordings.

    python3 tools/velocity_law_check.py instrument.json recordings_dir [--k 1.0 --halve 48] [--grid]

Builds the instrument with only its mezzo layer, plays every key at the soft and loud layer velocities, and compares the
render with the real soft and loud recordings of the same key. The engine has to get from mezzo to soft/loud with its velocity
law alone (spectral tilt: amplitude ~ velocity^(kappa * f / 1 kHz), kappa = k * 2^(-(note-60)/halve)), so the error measures
the law. Reported per key, first 250 ms after the onset, in the share of the energy above 1, 2 and 4 kHz:
  shape err   rms dB of (render - recording) over those three crossovers, i.e. spectral colour
  level err   render - recording total level (this is the 'dynamics' setting, not the law)
--grid scores a set of (k, halve) pairs; keys are split even/odd so a pair fitted on one half is scored on the other.
"""
import sys, os, json, glob, math, argparse, subprocess, tempfile, importlib.util
import numpy as np, soundfile as sf, scipy.signal as ss
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('ai', os.path.join(HERE, 'analyze_instrument.py')); ai = importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
SR = 48000; EDGES = 200 * 2 ** (0.5 * np.arange(0, 12))            # 200 Hz .. 8 kHz
LO, MID, HI = 32, 72, 104

XO = (1000, 2000, 4000)

def bands(x, f0, floor=None):
    """(total level dB, [share of the energy above each crossover in dB]) over the first 250 ms. The recording's noise
    floor (spectral density above 9 kHz) is added to both sides, so a partial the recording has buried does not count."""
    o = ai.onset(x, SR); s = x[o:o + int(0.25 * SR)]
    if len(s) < 4000: return None
    F, P = ss.periodogram(s, SR, window='hann', nfft=16384); df = F[1] - F[0]
    dens = float(P[(F > 9000) & (F < 12000)].mean()) if floor is None else floor
    lim = F < 12000; tot = P[lim & (F > f0 * 0.9)].sum() + dens * (12000 - f0 * 0.9) / df
    hf = [10 * np.log10((P[lim & (F >= c)].sum() + dens * (12000 - c) / df) / tot) for c in XO]
    return 10 * np.log10(P[lim].sum() + 1e-20), np.array(hf), dens

def load_refs(rec):
    refs = {}
    for f in sorted(glob.glob(os.path.join(rec, '*.*'))):
        m, v = ai.parse_name(f)
        if m is None or v not in (LO, MID, HI): continue
        x, sr = sf.read(f); x = x.mean(1) if x.ndim > 1 else x
        if sr != SR: x = ss.resample_poly(x, SR, sr)
        refs[(m, v)] = x[:int(3 * SR)]
    return refs

def render(doc, jobs):
    with tempfile.TemporaryDirectory() as d:
        json.dump(doc, open(d + '/i.json', 'w')); json.dump(jobs, open(d + '/j.json', 'w'))
        subprocess.run(['node', os.path.join(ROOT, 'test/render_batch.mjs'), d + '/i.json', d + '/j.json', d + '/o.f32'], check=True)
        y = np.fromfile(d + '/o.f32', 'f4').astype(float)
    n = int(math.ceil(0.8 * SR / 128) * 128)
    return [y[i * n:(i + 1) * n] for i in range(len(jobs))]

def score(doc, refs, k, halve, notes):
    """{(note, v): (shape err, level err)} for the given notes"""
    keys = {kk['note']: kk for kk in doc['keys']}
    jobs, idx = [], []
    for m in notes:
        for v in (LO, HI):
            if (m, v) in refs and (m, MID) in refs and m in keys:
                jobs.append({'note': m, 'vel': v, 'secs': 0.8, 'params': {'velK': k, 'velHalve': halve, 'hammerNoise': 0.8, 'globalRes': 0, 'sympRes': 0, 'keyNoise': 0}}); idx.append((m, v))
    ys = render(doc, jobs); res = {}
    for (m, v), y in zip(idx, ys):
        f0 = 440 * 2 ** ((m - 69) / 12); b = bands(refs[(m, v)], f0)
        a = bands(y, f0, b[2] if b else None)
        if a is None or b is None or b[0] < -95: continue
        d = a[1] - b[1]; res[(m, v)] = (float(np.sqrt(np.mean(d ** 2))), float(a[0] - b[0]))
    return res

def mezzo_only(doc):
    out = json.loads(json.dumps(doc))
    for kk in out['keys']: kk['layers'] = [L for L in kk['layers'] if L['velocity'] == MID]
    out['keys'] = [kk for kk in out['keys'] if kk['layers']]            # a key without a mezzo layer would widen the velocity range
    return out

def summary(res, sel=lambda m: True):
    r = [v for (m, _), v in res.items() if sel(m)]
    return (np.mean([x[0] for x in r]), np.mean([x[1] for x in r]), len(r)) if r else (float('nan'),) * 3

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('instrument'); ap.add_argument('recordings'); ap.add_argument('--k', type=float, default=1.0); ap.add_argument('--halve', type=float, default=48)
    ap.add_argument('--grid', action='store_true'); a = ap.parse_args()
    doc = mezzo_only(json.load(open(a.instrument))); refs = load_refs(a.recordings); notes = sorted({m for m, _ in refs})
    if not a.grid:
        res = score(doc, refs, a.k, a.halve, notes)
        for lo, hi in [(21, 40), (41, 60), (61, 76), (77, 108)]:
            s = summary(res, lambda m: lo <= m <= hi); print(f'notes {lo}-{hi}: shape err {s[0]:.2f} dB  level err {s[1]:+.2f} dB  (n={s[2]})')
        s = summary(res); print(f'ALL: shape err {s[0]:.2f} dB  level err {s[1]:+.2f} dB  (n={s[2]})'); return 0
    rows = []
    for k in (0.0, 0.6, 0.8, 1.0, 1.2, 1.5, 1.9):
        for h in (32, 48, 64, 96):
            if k == 0 and h != 48: continue
            res = score(doc, refs, k, h, notes); e = summary(res, lambda m: m % 2 == 0)[0]; o = summary(res, lambda m: m % 2 == 1)[0]; al = summary(res)[0]
            rows.append((al, k, h, e, o)); print(f'k={k:.1f} halve={h:3d}: shape err all {al:.2f}  even {e:.2f}  odd {o:.2f}', flush=True)
    b = min(rows); print('best:', b)
    return 0

if __name__ == '__main__': sys.exit(main())
