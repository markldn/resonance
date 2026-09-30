#!/usr/bin/env python3
"""Pull outlier decay times of a measured instrument back toward their neighbouring keys.

    python3 tools/regularize_decays.py in.json out.json [--cap 0.5] [--window 3] [--max-gain 4]

Per-key fits of a real recording carry noise: a key whose tail sits just above the recording's noise floor can come
out several times longer than its neighbours. A real piano's decay time changes smoothly along the keyboard, with only
modest key-to-key scatter. For each velocity layer this measures the time its envelope takes to fall 20 dB, compares its log with the median of
the same layer on the keys within +-window, and if it lies more than `cap` (natural-log units, 0.5 = x1.65) away,
scales that layer's T60s (direct and remanent) so it sits exactly `cap` from the median. Layers within the cap are
untouched. The layer's gain is then corrected so its average level over the first 0.5 s is unchanged: only the decay
shape moves, not the loudness of the attack. A layer that would need more than `max_gain` dB of correction (its 20 dB
fall happens inside that 0.5 s window, common in the top octave) is left alone and reported.

Needs no recordings, so it can be applied to an instrument whose source audio is gone. It cannot tell a fitting
artefact from a real quirk of that piano, which is why `cap` is generous and every changed key is printed.
"""
import sys, json, math, argparse
import numpy as np

T = np.linspace(0, 30, 3001)

def envelope_db(partials):
    tot = np.zeros_like(T)
    for _r, lvl, td, tr, rm in partials:
        w = min(10 ** (rm / 20), 0.99)
        e = (1 - w) * np.exp(-6.908 * T / td) + w * np.exp(-6.908 * T / tr)
        tot += (10 ** (lvl / 20) * e) ** 2
    return 10 * np.log10(tot + 1e-20)

def t20(partials):
    e = envelope_db(partials); e = e - e[0]
    return float(T[np.argmax(e < -20)]) if e[-1] < -20 else float(T[-1])

def early_db(partials):
    return float(np.mean(envelope_db(partials)[T <= 0.5]))

def regularize(doc, cap=0.5, window=3, max_gain=4.0):
    """each velocity layer is compared with the same layer of the neighbouring keys and corrected on its own"""
    keys = sorted(doc['keys'], key=lambda k: k['note']); changed = []; skipped = []
    for vel in sorted({l['velocity'] for k in keys for l in k['layers']}):
        ks = [(k, l) for k in keys for l in k['layers'] if l['velocity'] == vel]
        lt = np.array([math.log(max(t20(l['partials']), 0.05)) for _, l in ks])
        for i, (k, L) in enumerate(ks):
            med = float(np.median(lt[max(0, i - window):i + window + 1])); dev = lt[i] - med
            if abs(dev) <= cap: continue
            f = math.exp(math.copysign(cap, dev) - dev)                 # new t20 ~ f * old t20, |new dev| = cap
            before = early_db(L['partials']); old = [p[:] for p in L['partials']]
            for p in L['partials']:
                p[2] = round(p[2] * f, 4); p[3] = round(max(p[3] * f, p[2] * 1.05), 4)
            sh = before - early_db(L['partials'])
            if abs(sh) > max_gain:                                      # the 20 dB fall sits inside the 0.5 s level window: leave it
                L['partials'] = old; skipped.append((k['note'], vel, sh)); continue
            L['gain_db'] = round(L.get('gain_db', 0.0) + sh, 1)
            changed.append((k['note'], vel, math.exp(lt[i]), math.exp(lt[i] + math.log(f)), f, sh))
    return doc, changed, skipped

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--cap', type=float, default=0.5); ap.add_argument('--window', type=int, default=3); ap.add_argument('--max-gain', type=float, default=4.0)
    a = ap.parse_args()
    doc = json.load(open(a.inp)); doc, changed, skipped = regularize(doc, a.cap, a.window, a.max_gain)
    doc.setdefault('decay_model', {})['note'] = (doc.get('decay_model', {}).get('note', '') + f' + decay outliers pulled to within x{math.exp(a.cap):.2f} of neighbours (regularize_decays.py)').strip()
    json.dump(doc, open(a.out, 'w'), indent=1)
    print(f'{len(changed)} layers changed on {len({c[0] for c in changed})} of {len(doc["keys"])} keys (cap {a.cap}, window +-{a.window}):')
    for n, v, sh in skipped: print(f'  skipped key {n} v{v}: fixing it would need a {sh:+.1f} dB level correction (limit {a.max_gain})')
    for n, v, o, nw, f, sh in changed: print(f'  key {n:3d} v{v:<3d}: t-20dB {o:6.2f} s -> {nw:6.2f} s (x{f:.2f}), gain {sh:+.1f} dB')

if __name__ == '__main__': main()
