#!/usr/bin/env python3
"""How closely does the engine play a measured sustained instrument like its recordings?

    python3 tools/fidelity_sustained.py instrument.json recording.wav [recording.wav ...] [--params '{...}']

Each recording's note is rendered through the shipped engine (held 3.5 s) and compared with the recording over its steady part:
  shape err  |dB| between the two 1/3-octave band spectra (200 Hz - 8 kHz) after removing each one's overall level: the timbre
  level err  dB, ours - recording, of the steady RMS (before the instrument-wide level is trimmed, so read the spread, not the mean)
  attack     10-90 % rise time of both (ms)
  vibrato    depth in cents of both (0 = none)
"""
import sys, os, json, math, argparse, subprocess, tempfile, importlib.util
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('as_', os.path.join(HERE, 'analyze_sustained.py')); A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
SR = 48000; SHORT = False
EDGES = [200 * 2 ** (i / 3) for i in range(0, 16)]; EDGES = [e for e in EDGES if e < 8000]

def bands(x, sr, a, b):
    F, P = A.spec(x, sr, a, b); return np.array([10 * math.log10(P[(F >= lo) & (F < hi)].sum() + 1e-20) for lo, hi in zip(EDGES[:-1], EDGES[1:])])

def true_key(x, sr, m, a4):
    """the key a recording plays (its name may be an octave off: tools/analyze_sustained.py resolve_key)"""
    sg = A.segment(x, sr, SHORT)
    if sg is None: return m
    o, s0, s1, att, _ = sg; F, P = A.spec(x, sr, s0, s1)
    return A.resolve_key(F, P, m, a4, A.yin_pitch(x, sr, int(o * sr) + int(0.03 * sr)))[0]

def measure(x, sr, m, a4):
    sg = A.segment(x, sr, SHORT)
    if sg is None: return None
    o, s0, s1, att, _ = sg; F, P = A.spec(x, sr, s0, s1); f0 = A.refine_f0(F, P, a4 * 2 ** ((m - 69) / 12))
    rate, depth, delay = A.vibrato(x, sr, f0, s0, s1)
    return dict(b=bands(x, sr, s0, s1), lvl=10 * math.log10(np.mean(x[int(s0 * sr):int(s1 * sr)] ** 2) + 1e-20), att=att, depth=depth)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('instrument'); ap.add_argument('files', nargs='+'); ap.add_argument('--params', default='{"globalRes":0.35,"keyNoise":0,"hammerNoise":0.8}')
    ap.add_argument('--short', action='store_true', help='staccato notes')
    a = ap.parse_args(); global SHORT; SHORT = a.short; doc = json.load(open(a.instrument)); a4 = doc.get('a4_hz', 440.0); jobs, meta = [], []
    for f in a.files:
        m = A.key_of(f)
        if m is None or os.path.basename(f).startswith('.'): continue
        x, sr = A.load(f); m = true_key(x, sr, m, a4); ref = measure(x, sr, m, a4)
        if ref: jobs.append({'note': m, 'vel': 80, 'secs': 3.5, 'params': json.loads(a.params)}); meta.append((f, m, ref))
    with tempfile.TemporaryDirectory() as d:
        json.dump(jobs, open(d + '/j.json', 'w'))
        subprocess.run(['node', os.path.join(ROOT, 'test/render_batch.mjs'), a.instrument, d + '/j.json', d + '/o.f32'], check=True)
        y = np.fromfile(d + '/o.f32', 'f4').astype(float)
    n = int(math.ceil(3.5 * SR / 128) * 128); rows = []
    for i, (f, m, ref) in enumerate(meta):
        r = measure(y[i * n:(i + 1) * n], SR, m, a4)
        if not r: continue
        sh = np.abs((r['b'] - r['lvl']) - (ref['b'] - ref['lvl'])); ok = (ref['b'] - ref['lvl']) > -60
        rows.append((os.path.basename(f), float(np.mean(sh[ok])), r['lvl'] - ref['lvl'], r['att'] * 1000, ref['att'] * 1000, r['depth'], ref['depth']))
        print(f'{rows[-1][0]:30s} shape {rows[-1][1]:5.1f} dB  level {rows[-1][2]:+5.1f}  attack {r["att"] * 1000:4.0f}/{ref["att"] * 1000:4.0f} ms  vibrato {r["depth"]:3.0f}/{ref["depth"]:3.0f} c')
    R = np.array([r[1:] for r in rows]); print(f'MEAN shape err {R[:, 0].mean():.2f} dB   level spread (std) {R[:, 1].std():.2f} dB   attack ours/rec median {np.median(R[:, 2]):.0f}/{np.median(R[:, 3]):.0f} ms   vibrato median {np.median(R[:, 4]):.0f}/{np.median(R[:, 5]):.0f} c')

if __name__ == '__main__': sys.exit(main())
