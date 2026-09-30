#!/usr/bin/env python3
"""Pull outlier brightness of a measured instrument back toward its neighbouring keys.

    python3 tools/regularize_brightness.py in.json out.json [--cap 1.5] [--window 3]

Per-key fits of a real recording leave some keys clearly brighter or duller than their neighbours (on the Iowa Grand, D4
was 4 dB brighter than the trend, C4 3.6 dB duller). A real piano is voiced to change smoothly along the keyboard.

For each velocity layer this computes the spectral centroid of the first 250 ms (mean log2 of the partial ratio, weighted by
the energy each partial has in that time, decay included) and compares it with the median of the same layer on the keys within
+-window. The difference is expressed in dB-equivalent (6.02 dB per octave of centroid). Beyond `cap` the layer's partial levels
get a tilt, `level += slope * log2(ratio)`, chosen so the centroid lands exactly `cap` from that median. The fundamental is
untouched, and since the engine normalises each note by its total energy, loudness does not change. The layer is renormalised
so its loudest partial is 0 dB, as the format asks.

Needs no recordings. It cannot tell a fitting artefact from a real quirk of that piano, so `cap` is generous and every changed
layer is printed.
"""
import sys, json, math, argparse
import numpy as np

T = np.linspace(0, 0.25, 26)

def centroid(partials):
    """energy-weighted mean log2(ratio) over the first 250 ms"""
    num = den = 0.0
    for r, lvl, td, tr, rm in partials:
        w = min(10 ** (rm / 20), 0.99)
        env = (1 - w) * np.exp(-6.908 * T / td) + w * np.exp(-6.908 * T / tr)
        e = (10 ** (lvl / 20)) ** 2 * float(np.mean(env ** 2))
        num += e * math.log2(max(r, 1e-3)); den += e
    return num / den if den > 0 else 0.0

def tilted(partials, slope):
    out = [[p[0], p[1] + slope * math.log2(max(p[0], 1e-3))] + list(p[2:]) for p in partials]
    top = max(p[1] for p in out)
    return [[p[0], round(p[1] - top, 1)] + list(p[2:]) for p in out]

def solve_slope(partials, target):
    lo, hi = -12.0, 12.0                                             # dB per octave; the centroid rises with the slope
    for _ in range(40):
        mid = (lo + hi) / 2
        if centroid(tilted(partials, mid)) < target: lo = mid
        else: hi = mid
    return (lo + hi) / 2

def regularize(doc, cap=1.5, window=3):
    keys = sorted(doc['keys'], key=lambda k: k['note']); changed = []
    for vel in sorted({l['velocity'] for k in keys for l in k['layers']}):
        ks = [(k, l) for k in keys for l in k['layers'] if l['velocity'] == vel]
        c = np.array([centroid(l['partials']) for _, l in ks])
        for i, (k, L) in enumerate(ks):
            med = float(np.median(c[max(0, i - window):i + window + 1])); dev = (c[i] - med) * 6.02
            if abs(dev) <= cap: continue
            target = med + math.copysign(cap, dev) / 6.02
            s = solve_slope(L['partials'], target)
            L['partials'] = tilted(L['partials'], s)
            changed.append((k['note'], vel, dev, s))
    return doc, changed

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--cap', type=float, default=1.5); ap.add_argument('--window', type=int, default=3)
    a = ap.parse_args()
    doc = json.load(open(a.inp)); doc, changed = regularize(doc, a.cap, a.window)
    dm = doc.setdefault('decay_model', {}); dm['note'] = (dm.get('note', '') + f' + brightness outliers pulled to within {a.cap} dB-equivalent of neighbours (regularize_brightness.py)').strip()
    json.dump(doc, open(a.out, 'w'), indent=1)
    print(f'{len(changed)} layers changed on {len({c[0] for c in changed})} of {len(doc["keys"])} keys (cap {a.cap} dB-equivalent, window +-{a.window}):')
    for n, v, dev, s in changed: print(f'  key {n:3d} v{v:<3d}: {dev:+5.1f} dB from the local trend -> tilt {s:+.2f} dB/octave')

if __name__ == '__main__': main()
