#!/usr/bin/env python3
"""Per-band calibration of a measured instrument against real recordings.

    python3 tools/calibrate_bands.py instrument.json out.json recordings_dir [--rounds 4] [--jobs 12]

tools/calibrate_envelope.py scores the broadband 100 ms RMS, which the loudest low partials dominate: a layer whose partials
above 800 Hz are 15 dB too quiet, or die twice too fast, still scores well, and it plays as a dull "plock": the thump of the
low partials without the bright ring of the real note. This tool scores the level of five bands (200-400, 400-800, 800-1600,
1600-3200, 3200-6400 Hz) in four windows (30-150 ms, 0.2-0.6 s, 1-2 s, 3-5 s) of every layer and corrects the partials in each band:

  level of the band's partials    <- the error in the first window (ours - recording, dB)
  direct T60                      <- the change of the error between the first and second window (an error that grows = a decay rate that is wrong)
  remanent T60                    <- the change between the second and third (and fourth) window

The corrections are interpolated along log frequency between band centres, smoothed over neighbouring keys of the same layer
(one note's band levels scatter by a few dB from its own beating), damped, and clipped; then the instrument is rendered again and
the loop repeats. Bands where the layer has no partial, or where the recording is within 6 dB of its own noise floor, are left alone.
Finish with tools/calibrate_levels.py (the broadband attack level).
"""
import sys, os, json, glob, math, argparse, subprocess, tempfile, importlib.util
import numpy as np, soundfile as sf, scipy.signal as ss
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('ce', os.path.join(HERE, 'calibrate_envelope.py')); ce = importlib.util.module_from_spec(spec); spec.loader.exec_module(ce)
ai = ce.ai; SR = 48000
EDGES = [200, 400, 800, 1600, 3200, 6400]; CENTRES = np.sqrt(np.array(EDGES[:-1]) * np.array(EDGES[1:]))
WINS = [(0.03, 0.15), (0.2, 0.6), (1.0, 2.0), (3.0, 5.0)]; MID = np.array([np.mean(w) for w in WINS])
SECS = 5.2

def bands(x):
    """dB level of each band in each window: array [window][band], nan where the signal is too short"""
    x = x[max(0, ai.onset(x, SR) - 96):]; out = np.full((len(WINS), len(CENTRES)), np.nan)
    for i, (a, b) in enumerate(WINS):
        s = x[int(a * SR):int(b * SR)]
        if len(s) < int((b - a) * SR * 0.9): continue
        w = np.hanning(len(s)); X = np.abs(np.fft.rfft(s * w)) ** 2 / np.sum(w ** 2); F = np.fft.rfftfreq(len(s), 1 / SR)
        out[i] = [10 * np.log10(X[(F >= lo) & (F < hi)].sum() + 1e-14) for lo, hi in zip(EDGES[:-1], EDGES[1:])]
    return out

def bands_of(seg):
    """dB level of each band over a whole segment (a noise floor); a Hann window, as in bands()"""
    w = np.hanning(len(seg)); X = np.abs(np.fft.rfft(seg * w)) ** 2 / np.sum(w ** 2); F = np.fft.rfftfreq(len(seg), 1 / SR)
    return np.array([10 * np.log10(X[(F >= lo) & (F < hi)].sum() * (WINS[0][1] - WINS[0][0]) / (len(seg) / SR) + 1e-14) for lo, hi in zip(EDGES[:-1], EDGES[1:])])

def load_refs(rec):
    refs = {}
    for f in sorted(glob.glob(os.path.join(rec, '*.*'))):
        m, v = ai.parse_name(f)
        if m is None: continue
        try: x, sr = sf.read(f)
        except Exception: continue
        x = x.mean(1) if x.ndim > 1 else x
        if sr != SR: x = ss.resample_poly(x, SR, sr)
        if np.abs(x).max() < 1e-4: continue
        rel = ai.release_time(x[ai.onset(x, SR):], SR); n = min(len(x), int(SECS * SR) + ai.onset(x, SR) + 96)
        ref = bands(x[:n]); fl = np.full(len(CENTRES), -200.0)
        if len(x) > 8 * SR and not rel: fl = np.maximum(fl, bands_of(x[-SR:]))          # a note that rang to the end: the last second is the room
        o = ai.onset(x, SR) - 96
        if o >= int(0.06 * SR): fl = np.maximum(fl, bands_of(x[max(0, o - int(0.3 * SR)):o]))   # the silence before the strike
        if rel:                                                 # a held key released: windows after the release are damper noise, not the piano
            for i, (a, b) in enumerate(WINS):
                if b > rel - 0.05: ref[i] = np.nan
        ref = np.where(ref < fl[None, :] + 6, np.nan, ref)     # below its own noise floor there is nothing to match
        if (~np.isnan(ref)).sum() >= 4: refs[(m, v)] = ref
    return refs

def render(doc, jobs, nproc): return ce.render(doc, jobs, nproc)

def correction(ref, ours):
    """per band: (level dB, direct rate change dB/s, remanent rate change dB/s), nan where not measurable"""
    e = ours - ref; lev = np.full(len(CENTRES), np.nan); rd = lev.copy(); rr = lev.copy()
    for b in range(len(CENTRES)):
        c = e[:, b]
        if not np.isnan(c[0]): lev[b] = -c[0]
        if not np.isnan(c[0]) and not np.isnan(c[1]): rd[b] = (c[1] - c[0]) / (MID[1] - MID[0])
        sl = [(c[i + 1] - c[i]) / (MID[i + 1] - MID[i]) for i in (1, 2) if not np.isnan(c[i]) and not np.isnan(c[i + 1])]
        if sl: rr[b] = float(np.mean(sl))
    return lev, rd, rr

def interp(vals, f):
    """value at frequency f, interpolated along log f between the bands that have one; nan-free (holds the nearest)"""
    ok = ~np.isnan(vals)
    if not ok.any(): return 0.0
    return float(np.interp(math.log(f), np.log(CENTRES[ok]), vals[ok]))

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('instrument'); ap.add_argument('out'); ap.add_argument('recordings')
    ap.add_argument('--rounds', type=int, default=4); ap.add_argument('--jobs', type=int, default=12); ap.add_argument('--damp', type=float, default=0.8); ap.add_argument('--span', type=int, default=1, help='keys each side in the smoothing kernel'); ap.add_argument('--hide', type=int, default=0, help='drop every Nth key first (to judge the fit on keys it never saw)')
    a = ap.parse_args()
    doc = json.load(open(a.instrument)); refs = load_refs(a.recordings)
    if a.hide: ks = doc['keys']; doc['keys'] = [k for i, k in enumerate(ks) if i % a.hide or i == 0 or i == len(ks) - 1]
    have = {(k['note'], L['velocity']) for k in doc['keys'] for L in k['layers']}
    layers = sorted(l for l in refs if l in have); print(f'{len(layers)} layers with a usable recording', file=sys.stderr)
    jobs = [{'note': m, 'vel': v, 'secs': SECS, 'params': json.loads(ce.PARAMS)} for m, v in layers]
    byk = {k['note']: k for k in doc['keys']}
    orig = {(k['note'], L['velocity']): [list(p) for p in L['partials']] for k in doc['keys'] for L in k['layers']}   # the caps below are relative to the input
    for rnd in range(a.rounds):
        ys = render(doc, jobs, a.jobs); cor = {}; errs = []
        for l, y in zip(layers, ys):
            o = bands(y); r = refs[l]; cor[l] = correction(r, o)
            d = (o - r)[~np.isnan(r)]; errs.append(np.sqrt(np.mean(d ** 2)) if d.size else np.nan)
        print(f'round {rnd}: band-level rms error {np.nanmean(errs):.2f} dB over {len(layers)} layers', file=sys.stderr, flush=True)
        # smooth over the neighbouring measured keys of the same layer velocity: a triangular kernel over `--span` keys each side
        # (one note's band levels scatter by several dB from its own beating; the keyboard's true trend is smooth)
        for v in sorted({v for _, v in layers}):
            ks = sorted(m for m, vv in layers if vv == v); sm = {}
            for i, m in enumerate(ks):
                nb = [(1.0 - abs(j - i) / (a.span + 1), cor[(ks[j], v)]) for j in range(max(0, i - a.span), min(len(ks), i + a.span + 1))]
                sm[m] = tuple(np.array([sum(w * c[q][b] for w, c in nb if not np.isnan(c[q][b])) / sum(w for w, c in nb if not np.isnan(c[q][b])) if any(not np.isnan(c[q][b]) for _, c in nb) else np.nan for b in range(len(CENTRES))]) for q in range(3))
            for m in ks: cor[(m, v)] = sm[m]
        for (m, v), (lev, rd, rr) in cor.items():
            f0 = byk[m]['f0_hz']; L = next(L for L in byk[m]['layers'] if L['velocity'] == v)
            for p in L['partials']:
                f = p[0] * f0
                if f < EDGES[0] * 0.7 or f > EDGES[-1] * 1.3: continue
                q0 = orig[(m, v)][L['partials'].index(p)]
                dl = float(np.clip(a.damp * interp(lev, f), -10, 10)); p[1] = round(float(np.clip(p[1] + dl, q0[1] - 18, q0[1] + 18)), 2)
                for idx, ch in ((2, interp(rd, f)), (3, interp(rr, f))):
                    ro = 60.0 / max(p[idx], 0.01); rn = float(np.clip(ro + a.damp * ch, ro * 0.6, ro * 1.5)); p[idx] = round(float(np.clip(60.0 / max(rn, 0.05), q0[idx] / 3, q0[idx] * 3)), 4)
                p[3] = round(max(p[3], p[2] * 1.05), 4)
    ys = render(doc, jobs, a.jobs); errs = [np.sqrt(np.mean(((bands(y) - refs[l])[~np.isnan(refs[l])]) ** 2)) for l, y in zip(layers, ys)]
    print(f'final: band-level rms error {np.nanmean(errs):.2f} dB', file=sys.stderr)
    dm = doc.setdefault('decay_model', {}); dm['note'] = (dm.get('note', '') + ' + per-band level and decay fit to the recordings (tools/calibrate_bands.py)').lstrip(' +')
    json.dump(doc, open(a.out, 'w'), indent=1); print('wrote', a.out, file=sys.stderr)

if __name__ == '__main__': sys.exit(main())
