#!/usr/bin/env python3
"""Measure a real instrument from single-note recordings -> resonance-instrument/1 JSON.

    python3 analyze_instrument.py --name "My piano" --out my_piano.json recordings/*.wav

File names must contain the note and the dynamic / velocity, e.g.
    C4_v64.wav   A0-v100.flac   Piano.mf.Eb3.aiff   Gb5_ff.wav
Notes: C4 = MIDI 60, sharps as C#4 or Db4. Dynamics: ppp pp p mp mf f ff fff, or v<velocity>.

Per recording: onset -> f0 and inharmonicity B fitted to the partial peaks -> each partial
demodulated to an amplitude envelope -> two-stage (direct + remanent) decay fitted in dB.
Requires numpy, scipy, soundfile (aiff/wav/flac).
"""
import argparse, json, math, re, sys, os
import numpy as np, soundfile as sf

VERSION = 9   # bump when the analysis changes (invalidates the per-file cache)
from scipy.optimize import least_squares

NOTE = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
DYN = {'ppp': 16, 'pp': 32, 'p': 48, 'mp': 56, 'mf': 72, 'f': 88, 'ff': 104, 'fff': 120}


def parse_name(path):
    base = os.path.basename(path)
    m = re.search(r'(?<![A-Za-z])([A-G])([#b]?)(-?\d)(?!\d)', base)
    if not m: return None, None
    midi = 12 * (int(m.group(3)) + 1) + NOTE[m.group(1)] + (1 if m.group(2) == '#' else -1 if m.group(2) == 'b' else 0)
    v = re.search(r'(?:^|[^A-Za-z])v(\d{1,3})(?!\d)', base)
    if v: return midi, int(v.group(1))
    for tok in re.split(r'[^A-Za-z]+', base.replace(m.group(0), ' ')):
        if tok.lower() in DYN: return midi, DYN[tok.lower()]
    return midi, 64


def load(path):
    x, sr = sf.read(path, always_2d=True)
    return x.mean(axis=1).astype(np.float64), sr


def onset(x, sr):
    e = np.convolve(x * x, np.ones(int(0.002 * sr)) / int(0.002 * sr), 'same')
    pk = e.max()
    return int(np.argmax(e > pk * 0.01))


def fit_f0_B(x, sr, midi, a4):
    f_nom = a4 * 2 ** ((midi - 69) / 12)
    seg = x[int(0.05 * sr):int(0.05 * sr) + int(min(1.5, len(x) / sr - 0.1) * sr)]
    N = 1 << int(math.ceil(math.log2(max(len(seg), 1) * 4)))
    X = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), N)); F = np.fft.rfftfreq(N, 1 / sr)
    ref = 20 * np.log10(X.max() + 1e-12)
    B, f0, pts = 1e-4 * (1 if midi > 40 else 3), f_nom, []
    for it in range(3):
        pts = []
        for n in range(1, 60):
            fg = n * f0 * math.sqrt(1 + B * n * n)
            if fg > min(0.45 * sr, 9000): break
            lo, hi = np.searchsorted(F, fg * 0.985), np.searchsorted(F, fg * 1.015)
            if hi - lo < 3: continue
            k = lo + int(np.argmax(X[lo:hi]))
            if 0 < k < len(X) - 1 and 20 * math.log10(X[k] + 1e-12) > ref - 55:
                a, b, c = np.log(X[k - 1:k + 2] + 1e-12); den = a - 2 * b + c
                d = 0.5 * (a - c) / den if abs(den) > 1e-9 else 0.0
                if abs(d) <= 1: pts.append((n, F[k] + d * (F[1] - F[0])))
        if len(pts) >= 4:
            n2 = np.array([p[0] ** 2 for p in pts], float); y = np.array([(p[1] / p[0]) ** 2 for p in pts])
            s, c0 = np.polyfit(n2, y, 1)
            if c0 > 0: f0 = math.sqrt(c0); B = max(0.0, s / c0)
        elif pts:
            f0 = pts[0][1] / pts[0][0]
    return f0, B, dict(pts)


def envelope(x, sr, f, hop):
    t = np.arange(len(x)) / sr
    z = x * np.exp(-2j * np.pi * f * t)
    w = max(int(0.02 * sr), int(2.5 * sr / max(f, 20)))
    # Hann-weighted frames: a moving average (rectangular window) leaks the loud low partials into every
    # high-partial slot at about -45 dB, which read as fictitious 30 s tails; Hann sidelobes fall 18 dB/oct
    h = np.hanning(w + 2)[1:-1]
    nfr = (len(z) - w) // hop + 1
    if nfr < 1: return np.array([]), np.array([])
    fr = np.lib.stride_tricks.as_strided(z, shape=(nfr, w), strides=(z.strides[0] * hop, z.strides[0]))
    a = 2 * np.abs(fr @ h) / h.sum()
    return np.arange(nfr) * hop / sr + w / (2 * sr), a


def fit_decay(t, db):
    """two-stage fit of a partial envelope (dB) -> (level_dB at t=0, t60d, t60r, remanent_dB).
    Coarse grid over (direct, remanent) rates with the two amplitudes solved by weighted linear
    least squares (weights ~ 1/amplitude, i.e. relative/log error), then least-squares refinement in dB."""
    if len(t) < 6: return None
    a = 10 ** (db / 20)
    best = None
    for kd in np.geomspace(0.08, 60, 22):
        for kr in np.geomspace(0.002, 8, 22):
            if kr >= kd * 0.85: continue
            X = np.stack([np.exp(-kd * t), np.exp(-kr * t)], 1) / a[:, None]
            coef, *_ = np.linalg.lstsq(X, np.ones_like(a), rcond=None)
            Ad, Ar = max(coef[0], 1e-9), max(coef[1], 1e-12)
            m = 20 * np.log10(Ad * np.exp(-kd * t) + Ar * np.exp(-kr * t))
            err = np.mean((m - db) ** 2)
            if best is None or err < best[0]: best = (err, Ad, Ar, kd, kr)
    _, Ad, Ar, kd, kr = best
    def model(p, t):
        ad, ar, kd, kr = p
        return 20 * np.log10(np.exp(ad - kd * t) + np.exp(ar - kr * t) + 1e-15)
    p0 = [math.log(Ad), math.log(Ar), kd, kr]
    try:
        r = least_squares(lambda p: model(p, t) - db, p0,
                          bounds=([p0[0] - 12, p0[1] - 20, 0.02, 0.001], [p0[0] + 6, p0[1] + 6, 300, 60]))
        ad, ar, kd, kr = r.x
        if kr > kd: ad, ar, kd, kr = ar, ad, kr, kd
        Ad, Ar = math.exp(ad), math.exp(ar)
    except Exception:
        pass
    lvl = 20 * math.log10(Ad + Ar)
    return lvl, 6.908 / kd, 6.908 / kr, 20 * math.log10(Ar / (Ad + Ar) + 1e-12)


def release_time(x, sr):
    """time (s after onset) where the note is released: the overall level suddenly falls much faster
    than it was decaying (dampers). None if the note was held until it died."""
    hop = int(0.01 * sr); w = int(0.03 * sr)
    e = np.array([np.sqrt(np.mean(x[i:i + w] ** 2)) + 1e-12 for i in range(0, max(1, len(x) - w), hop)])
    db = 20 * np.log10(e); db = np.convolve(db, np.ones(5) / 5, 'same')
    sl = np.gradient(db) / 0.01                          # dB/s
    for i in range(100, len(sl) - 20):                   # not in the first second
        before = np.median(sl[max(0, i - 100):i])
        if sl[i] < -40 and np.median(sl[i:i + 15]) < min(-40, before * 4) and db[i] > db.max() - 60:
            return (i - 3) * 0.01
    return None


def free_peaks(x, sr, midi, a4, max_peaks=24):
    """Non-harmonic instruments (bars, bells, tines): the strongest spectral peaks and their true
    frequencies. f0 = the peak nearest the nominal pitch."""
    f_nom = a4 * 2 ** ((midi - 69) / 12)
    seg = x[int(0.02 * sr):int(0.02 * sr) + int(min(1.0, len(x) / sr - 0.05) * sr)]
    N = 1 << int(math.ceil(math.log2(max(len(seg), 1) * 4)))
    X = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), N)); F = np.fft.rfftfreq(N, 1 / sr)
    dB = 20 * np.log10(X + 1e-12); ref = dB.max()
    lo = np.searchsorted(F, f_nom * 0.45)
    cand = [k for k in range(max(lo, 1), len(X) - 1) if X[k] > X[k - 1] and X[k] >= X[k + 1] and dB[k] > ref - 50 and F[k] < min(0.45 * sr, 16000)]
    cand.sort(key=lambda k: -X[k])
    picked = []
    for k in cand:
        if all(abs(F[k] - F[j]) > F[j] * 0.03 for j in picked): picked.append(k)
        if len(picked) >= max_peaks: break
    freqs = sorted(F[k] for k in picked)
    if not freqs: return f_nom, []
    f0 = min(freqs, key=lambda f: abs(math.log(f / f_nom)))
    return f0, freqs


def harmonic_share(x, sr, f0, B, peaks):
    """fraction of spectral energy (above 0.45*f0) sitting within 2% of the fitted harmonic series"""
    seg = x[int(0.05 * sr):int(0.05 * sr) + int(min(1.0, len(x) / sr - 0.1) * sr)]
    X = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2; F = np.fft.rfftfreq(len(seg), 1 / sr)
    band = F > 0.45 * f0; tot = X[band].sum() + 1e-20; hit = 0.0
    for n in range(1, 80):
        fn = n * f0 * math.sqrt(1 + B * n * n)
        if fn > F[-1]: break
        m = (F > fn * 0.98) & (F < fn * 1.02); hit += X[m].sum()
    return hit / tot


def analyze(path, midi, a4=440.0, max_partials=64, verbose=False, inharmonic=None):
    x, sr = load(path)
    if np.abs(x).max() < 1e-5: return None          # silent file (e.g. a key that didn't sound)
    o = onset(x, sr); pre = x[max(0, o - int(0.01 * sr) - int(0.5 * sr)):max(0, o - int(0.01 * sr))]; x = x[o:]
    rel = release_time(x, sr)
    if rel: x = x[:int(rel * sr)]                      # analyse the held part only
    f0, B, peaks = fit_f0_B(x, sr, midi, a4)
    if inharmonic is None:
        share = harmonic_share(x, sr, f0, B, peaks)
        if share < 0.5:          # weak fundamentals / a poor B fit: search B before calling it a bell
            for Bc in np.geomspace(1e-6, 5e-3, 40):
                sc = harmonic_share(x, sr, f0, Bc, peaks)
                if sc > share: share, B = sc, Bc
        inharmonic = share < 0.5
    freqs = None
    if inharmonic:
        f0, freqs = free_peaks(x, sr, midi, a4, min(24, max_partials)); B = 0.0
    hop = int(0.01 * sr)
    parts = []
    tail = x[-int(0.3 * sr):] if len(x) > sr else x[-int(0.1 * sr):]
    for n in range(1, (len(freqs) if freqs else max_partials) + 1):
        fn = freqs[n - 1] if freqs else (peaks.get(n) or n * f0 * math.sqrt(1 + B * n * n))
        if not math.isfinite(fn) or fn <= 0: continue
        if fn > min(0.45 * sr, 12000): break
        t, a = envelope(x, sr, fn, hop)
        # unison beating puts deep notches in a partial's envelope; the decay is a property of its
        # energy, so fit the power envelope smoothed over ~0.25 s
        pw = np.convolve(a * a, np.ones(25), 'same') / np.convolve(np.ones_like(a), np.ones(25), 'same')   # edge-normalised
        db = 10 * np.log10(pw + 1e-24)
        # noise floor: the recording's own silence before the attack (demodulated at this partial);
        # digital renders have none -> 100 dB below this partial's peak
        if len(pre) > int(0.02 * sr) and np.abs(pre).max() > 0:
            _, pf = envelope(pre, sr, fn, max(1, hop // 4))
            floor = 20 * math.log10(np.median(pf) + 1e-12)
        else:
            floor = db.max() - 100
        t0 = int(0.03 / 0.01)
        valid = np.where(db > floor + 6)[0]
        end = valid[-1] if len(valid) else t0
        pk = t0 + int(np.argmax(db[t0:min(end, t0 + 150)])) if end > t0 else t0   # peak within the first 1.5 s
        # log-spaced sample points: every decade of time weighs the same (else a long tail swamps the
        # fast direct decay of the first half second)
        span = end - pk
        if span < 8: continue
        idx = np.unique(np.clip(np.round(np.geomspace(1, span, 150)).astype(int) - 1 + pk, pk, end - 1))
        tt, dd = t[idx], db[idx]
        # stop at the first point after which the envelope never comes back above floor+8 dB
        if len(tt) < 8:
            continue
        r = fit_decay(tt - tt[0], dd)
        if not r: continue
        lvl, t60d, t60r, rem = r
        parts.append([round(fn / f0, 4), lvl, round(t60d, 3), round(t60r, 3), round(rem, 1)])
    if not parts: return None
    top = max(p[1] for p in parts)
    for p in parts: p[1] = round(p[1] - top, 1)
    parts = [p for p in parts if p[1] > -70]
    if verbose: print(f'{os.path.basename(path)}: midi {midi} f0 {f0:.2f} B {B:.2e} partials {len(parts)}{" (inharmonic peaks)" if inharmonic else ""}', file=sys.stderr)
    return {'f0_hz': round(f0, 3), 'B': float(f'{B:.3e}'), 'partials': parts, 'peak_db': round(top, 1)}


def regularize(doc):
    """Replace per-partial decay fits (noisy on real recordings) by a smooth instrument-wide decay law,
    keeping the measured spectra:
        rate_direct(m, n, f) = r1(m) * (1 + a*(n-1)) * (1 + (f/fc)^q)       r1: piecewise-linear in log over keys
        rate_remanent = rate_direct / K(m)                                    K: smooth keyboard curve
    (fitted on the direct/early decay: good SNR; remanent tails of weak partials run into the noise)
        remanent level = smooth keyboard curve
    Fit: grid over (a, fc, q) with log r1 breakpoints solved by linear least squares, 2 passes with
    outlier trimming. Decays are pooled over velocity layers."""
    keys = doc['keys']
    if len(keys) < 3: return doc
    lo, hi = keys[0]['note'], keys[-1]['note']
    # key curve follows the data (scatter is between partials of one note, not between keys)
    bps = np.array(sorted({k['note'] for k in keys})[::2] + [hi], float); bps = np.unique(bps)
    pts = []                                              # (m, n, f, log rateR, log K, rem)
    for k in keys:
        m = k['note']; f0 = k.get('f0_hz') or 440 * 2 ** ((m - 69) / 12)
        for L in k['layers']:
            for (r, lvl, td, tr, rem) in L['partials']:
                if lvl < -40 or tr > 500 or td <= 0 or tr <= 0 or tr < td: continue
                pts.append((m, max(1, round(r)), r * f0, math.log(6.908 / td), math.log(tr / td), rem))
    if len(pts) < 20: return doc
    P = np.array(pts); M, N, F, Y = P[:, 0], P[:, 1], P[:, 2], P[:, 3]
    def hat(mv):                                          # piecewise-linear basis over breakpoints
        H = np.zeros((len(mv), len(bps)))
        for i, mm in enumerate(mv):
            j = np.searchsorted(bps, mm, 'right') - 1; j = min(max(j, 0), len(bps) - 2)
            t = (mm - bps[j]) / (bps[j + 1] - bps[j]); H[i, j] += 1 - t; H[i, j + 1] += t
        return H
    H = hat(M); keep = np.ones(len(Y), bool); best = None
    for _ in range(2):
        best = None
        for a in (0, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25):
            for fc in np.geomspace(800, 12000, 12):
                for q in (0.8, 1.2, 1.6, 2.0, 2.5, 3.0, 4.0):
                    g = np.log(1 + a * (N - 1)) + np.log(1 + (F / fc) ** q)
                    c, *_ = np.linalg.lstsq(H[keep], (Y - g)[keep], rcond=None)
                    res = Y - g - H @ c; e = np.median(np.abs(res[keep]))
                    if best is None or e < best[0]: best = (e, a, fc, q, c, res)
        e, a, fc, q, c, res = best
        keep = np.abs(res) < max(2.5 * 1.4826 * e, 0.15)
    e, a, fc, q, c, _ = best
    # K (direct/remanent speed ratio) and remanent level: medians per key, smoothed over keys
    per = {}
    for (m, n, f, y, lk, rem) in pts: per.setdefault(m, []).append((lk, rem))
    km = sorted(per); Kc = np.array([np.median([v[0] for v in per[m]]) for m in km]); Rc = np.array([np.median([v[1] for v in per[m]]) for m in km])
    sm = lambda v: np.convolve(np.pad(v, 2, mode='edge'), np.ones(5) / 5, 'valid')
    Kc, Rc = np.clip(sm(Kc), math.log(1.3), math.log(8)), np.clip(sm(Rc), -40, -8)
    for k in keys:
        m = k['note']; f0 = k.get('f0_hz') or 440 * 2 ** ((m - 69) / 12)
        lr1 = float(hat(np.array([m])) @ c); K = math.exp(np.interp(m, km, Kc)); R = float(np.interp(m, km, Rc))
        for L in k['layers']:
            rems = [p[4] for p in L['partials'] if p[1] > -40 and p[4] > -100]
            rmed = float(np.median(rems)) if rems else R
            for p in L['partials']:
                n = max(1, round(p[0])); rd = math.exp(lr1) * (1 + a * (n - 1)) * (1 + (p[0] * f0 / fc) ** q)
                md, mr = math.log(6.908 / rd), math.log(6.908 * K / rd)            # law: log T60 direct / remanent
                # shrink each measured value halfway toward the law; outliers (> 2.5 MAD, "endless" tails,
                # impossible orders) are replaced by the law
                def shrink(raw, law):
                    if not (raw > 0) or raw > 500: return law
                    d = math.log(raw) - law
                    return law if abs(d) > 2.5 * 1.4826 * e + 0.2 else law + 0.5 * d
                td = math.exp(shrink(p[2], md)); tr = math.exp(shrink(p[3], mr))
                p[2] = round(td, 3); p[3] = round(max(tr, td * 1.2), 3)
                p[4] = round(min(max(p[4], rmed - 8, -60), rmed + 8), 1)
    doc['decay_model'] = {'a': a, 'fc_hz': round(float(fc), 1), 'q': q, 'fit_mad_log': round(float(e), 3), 'note': 'per-partial decays shrunk toward this law by regularize()'}
    return doc


def _analyze_job(p, midi, a4, partials, inh):
    return analyze(p, midi, a4, partials, verbose=True, inharmonic=inh)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='+'); ap.add_argument('--out', required=True)
    ap.add_argument('--name', default='Measured instrument'); ap.add_argument('--author', default='')
    ap.add_argument('--license', default=''); ap.add_argument('--source', default='')
    ap.add_argument('--a4', type=float, default=440.0); ap.add_argument('--partials', type=int, default=100)
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--inharmonic', dest='inh', action='store_true', default=None, help='force peak-picking (bars, bells, tines)')
    g.add_argument('--harmonic', dest='inh', action='store_false', help='force the string (harmonic + B) model')
    ap.add_argument('--body', help='case/soundboard resonance measured from the low-passed (<250 Hz) attack of treble notes: hz,level_db,t60 e.g. 110,-21,1.1')
    ap.add_argument('--raw', action='store_true', help='keep per-partial decay fits (no smooth decay law)')
    ap.add_argument('--jobs', type=int, default=6, help='parallel processes for the per-file analysis (6 = physical cores of this machine)')
    args = ap.parse_args()
    keys = {}
    cache_dir = os.path.join(os.path.expanduser('~'), '.cache', 'resonance-analyzer'); os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, os.path.basename(args.out) + '.cache.json')
    try: cache = json.load(open(cache_path))
    except Exception: cache = {}
    ckey = lambda p: f'v{VERSION}|{os.path.abspath(p)}|{os.path.getmtime(p)}|{args.partials}|{args.inh}|{args.a4}'
    todo = [(p, parse_name(p)[0]) for p in args.files if parse_name(p)[0] is not None and ckey(p) not in cache]
    if args.jobs > 1 and len(todo) > 1:        # per-file analysis is independent: fill the cache in parallel, then assemble below
        import multiprocessing as mp
        with mp.Pool(args.jobs) as pool:
            for (p, _), r in zip(todo, pool.starmap(_analyze_job, [(p, m, args.a4, args.partials, args.inh) for p, m in todo], chunksize=1)):
                cache[ckey(p)] = r
        json.dump(cache, open(cache_path, 'w'))
    for p in args.files:
        midi, vel = parse_name(p)
        if midi is None: print('skip (no note in name):', p, file=sys.stderr); continue
        ck = ckey(p)
        r = cache.get(ck)
        if r is None:
            r = analyze(p, midi, args.a4, args.partials, verbose=True, inharmonic=args.inh)
            cache[ck] = r; json.dump(cache, open(cache_path, 'w'))
        if not r: print('skip (no partials found):', p, file=sys.stderr); continue
        k = keys.setdefault(midi, {'note': midi, 'layers': []})
        k.setdefault('_f0', []).append(r['f0_hz']); k.setdefault('_B', []).append(r['B'])
        k['layers'].append({'velocity': vel, 'peak_db': r['peak_db'], 'partials': r['partials']})
    out = []
    for m in sorted(keys):
        k = keys[m]; k['layers'].sort(key=lambda l: l['velocity'])
        k['f0_hz'] = round(float(np.median(k.pop('_f0'))), 3); k['B'] = float(f"{np.median(k.pop('_B')):.3e}")
        # level of each key relative to the loudest layer across the instrument (keeps the keyboard's balance)
        out.append(k)
    ref = max(l['peak_db'] for k in out for l in k['layers'])
    for k in out:
        lp = max(k['layers'], key=lambda l: l['velocity'])['peak_db']
        k['level_db'] = round(lp - ref, 1)
        for l in k['layers']:                 # loudness of each velocity layer relative to this key's loudest
            l['gain_db'] = round(l.pop('peak_db') - lp, 1)
    doc = {'format': 'resonance-instrument/1', 'name': args.name, 'author': args.author, 'license': args.license,
           'source': args.source, 'a4_hz': args.a4, 'keys': out}
    if args.body:
        hz, lv, t60 = (float(v) for v in args.body.split(','))
        doc['body'] = {'hz': hz, 'level_db': lv, 't60': t60}
    if not args.raw: doc = regularize(doc)
    json.dump(doc, open(args.out, 'w'), indent=1)
    print(f'wrote {args.out}: {len(out)} keys, {sum(len(k["layers"]) for k in out)} layers', file=sys.stderr)


if __name__ == '__main__':
    main()
