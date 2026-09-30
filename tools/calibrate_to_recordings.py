#!/usr/bin/env python3
"""Analysis-by-synthesis calibration: make the engine's rendering of a measured instrument match the
recordings it was measured from, in level and in decay, key by key.

    python3 tools/calibrate_to_recordings.py instrument.json out.json recordings/*.aiff

Why: analyze_instrument.py fits a smooth decay law over the whole keyboard and takes levels from
demodulated partials. Both are good in the bass and wrong in the top octaves (few partials, noise floor),
which is audible. Here the real engine renders every key and its 50 ms RMS envelope is compared with the
recording's:
  1. per key (mezzo layer): grid-search a direct-decay scale and a remanent-decay scale (applied to the
     T60s of every layer of that key);
  2. per key and layer: level offset so the first 0.5 s match (gain_db / level_db);
  3. inharmonicity B where the analyzer had to fall back to its 1e-4 default (< 4 partials in range).
Requires numpy, scipy, soundfile, node.
"""
import sys, os, json, math, subprocess, tempfile, importlib.util
import numpy as np, soundfile as sf, scipy.signal as ss
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('ai', os.path.join(HERE, 'analyze_instrument.py')); ai = importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
SR, WIN = 48000, 0.05

def rec_env(path):
    x, sr = ai.load(path)
    if sr != SR: x = ss.resample_poly(x, SR, sr)
    o = ai.onset(x, SR); pre = x[max(0, o - int(0.5 * SR)):max(0, o - 480)]; x = x[o:]
    rel = ai.release_time(x, SR)
    if rel: x = x[:int(rel * SR)]
    floor = 20 * np.log10(np.sqrt(np.mean(pre ** 2)) + 1e-9) if len(pre) > 2400 else -100
    e = env(x)
    if len(e) > 60: floor = max(floor, float(np.median(e[-20:])))    # a note that never dies into silence: its tail IS the floor
    return e, floor

def env(x):
    n = int(WIN * SR); m = len(x) // n
    return 20 * np.log10(np.sqrt((x[:m * n].reshape(m, n) ** 2).mean(1)) + 1e-9)

def render(instfile, jobs):
    with tempfile.TemporaryDirectory() as d:
        json.dump(jobs, open(d + '/j.json', 'w'))
        subprocess.run(['node', os.path.join(ROOT, 'test/render_batch.mjs'), instfile, d + '/j.json', d + '/o.f32'], check=True)
        y = np.fromfile(d + '/o.f32', 'f4'); out = []; p = 0
        for j in jobs:
            n = int(math.ceil(j['secs'] * SR / 128) * 128); out.append(env(y[p:p + n].astype(float))); p += n
    return out

def valid_len(e, floor, tmax=8.0):
    """number of windows (from the start) where the recording is >= 12 dB above its noise floor"""
    lim = max(floor + 12, e[:4].max() - 90); n = 0
    for i in range(1, min(len(e), int(tmax / WIN))):
        if e[i] < lim and e[min(i + 2, len(e) - 1)] < lim: break
        n = i
    return n + 1

def score(re_, se, n, fl=None):
    """envelope mismatch (mean abs dB) after matching the start (first 0.5 s, or half of a short note); robust to
    unison-beating notches. With the recording's noise floor `fl`, both signals are clipped at it and the tail up
    to 6 s is scored too: a tail that rings on above the floor where the recording has died is an error, one
    hidden below the floor is not. (Summed over the tail, divided by the usable length: a long dead tail does not
    dilute the score.)"""
    n = min(n, len(se), len(re_))
    if n < 3: return 99.0, 0.0
    k = min(int(0.5 / WIN), max(2, n // 2))
    off = np.mean(re_[:k] - se[:k])
    if fl is None: return float(np.mean(np.abs(re_[:n] - se[:n] - off))), float(off)
    N = min(len(se), len(re_), int(6.0 / WIN))
    er = np.maximum(re_[:N], fl); es = np.maximum(se[:N] + off, fl)
    return float(np.sum(np.abs(er - es)) / max(n, 10)), float(off)


def apply_params(doc, Pk):
    """copy of doc with each key's decay model (sd, sr, g, rem) applied to every layer's partials"""
    out = json.loads(json.dumps(doc))
    for k in out['keys']:
        q = Pk.get(k['note'])
        if not q: continue
        if q.get('dt') and k['note'] >= 31:                              # unison beating: string detunes in cents (fitted to the beat notches)
            k['detune_cents'] = [0, round(q['dt'][0], 3), round(q['dt'][1], 3)] if k['note'] >= 42 else [0, round(q['dt'][1], 3)]
        else: k.pop('detune_cents', None)
        for L in k['layers']:
            for p in L['partials']:
                tilt = max(p[0], 1.0) ** (-q['g'])
                td = p[2] * q['sd'] * tilt; tr = max(p[3] * q['sr'] * tilt, td * 1.05)
                p[2] = round(td, 4); p[3] = round(tr, 4); p[4] = round(min(max(p[4] + q['rem'], -100.0), 0.0), 1)
    return out


def drop_silent_keys(doc):
    """A key whose recording was silent (a muted key, a dead sample) got a fitted level far below its neighbours and
    would drag every note interpolated next to it down: drop it, the neighbours interpolate across the gap."""
    ks = doc['keys']; keep = []
    for k in ks:
        near = [j['level_db'] for j in ks if j is not k and abs(j['note'] - k['note']) <= 6 and 'level_db' in j]
        if near and k.get('level_db', 0) < float(np.median(near)) - 25:
            print(f"dropped key {k['note']}: level {k['level_db']:.1f} dB vs neighbours {np.median(near):.1f} dB (silent recording)", file=sys.stderr); continue
        keep.append(k)
    return dict(doc, keys=keep)


def rescue_noisy_layers(doc, get):
    """Layers whose recording is mostly noise (quiet notes in the top octaves) hold fitted noise, not a note.
    Rebuild them from the loudest clean layer of the same key: partial levels shifted by the median level
    difference between the same two layers on the nearest clean keys (per partial order), decays kept."""
    def clean(m, L):
        r = get(m, L['velocity']); return bool(r) and valid_len(*r) >= 6
    keys = {k['note']: k for k in doc['keys']}; fixed = 0
    for m, k in sorted(keys.items()):
        good = [L for L in k['layers'] if clean(m, L)]
        bad = [L for L in k['layers'] if not clean(m, L)]
        if not bad or not good: continue
        src = max(good, key=lambda L: L['velocity'])
        for L in bad:
            diffs, gains = [], []
            for m2, k2 in keys.items():
                if abs(m2 - m) > 8 or m2 == m: continue
                a = next((x for x in k2['layers'] if x['velocity'] == L['velocity'] and clean(m2, x)), None)
                b = next((x for x in k2['layers'] if x['velocity'] == src['velocity'] and clean(m2, x)), None)
                if a and b:
                    diffs.append([pa[1] - pb[1] for pa, pb in zip(a['partials'], b['partials'])]); gains.append(a['gain_db'] - b['gain_db'])
            n = len(src['partials'])
            cols = [np.median([d[i] for d in diffs if i < len(d)] or [0.0]) for i in range(max(len(d) for d in diffs))] if diffs else [0.0]
            dl = [cols[min(i, len(cols) - 1)] for i in range(n)]
            # level: what the (noisy) recording itself shows relative to the clean loud layer, but never above its own
            # noise floor (a note that is only noise is at most that loud)
            (e_b, fl_b), (e_s, _) = get(m, L['velocity']), get(m, src['velocity'])
            pk_b, pk_s = float(e_b[:4].max()), float(e_s[:4].max())
            dg = (pk_b - pk_s) if pk_b > fl_b + 3 else (fl_b - 3 - pk_s)
            dg = min(dg, 0.0)
            L['partials'] = [[p[0], round(max(p[1] + dl[i], -90), 1), p[2], p[3], p[4]] for i, p in enumerate(src['partials'])]
            L['gain_db'] = round(src['gain_db'] + dg, 1); L['_rescued'] = True; fixed += 1
    print(f'rescued {fixed} noise-limited layers from the loudest clean layer of their key', file=sys.stderr)
    return doc


def main():
    inst, out, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    doc = json.load(open(inst)); recs = {}
    for f in files:
        m, v = ai.parse_name(f)
        if m is not None: recs[(m, v)] = f
    cache = {}
    def get(m, v):
        if (m, v) not in cache:
            f = recs.get((m, v)); cache[(m, v)] = rec_env(f) if f else None
        return cache[(m, v)]
    keys = {k['note']: k for k in doc['keys']}
    doc = drop_silent_keys(doc)
    doc = rescue_noisy_layers(doc, get)
    keys = {k['note']: k for k in doc['keys']}
    work = json.loads(json.dumps(doc))                      # calibrated copy
    wk = {k['note']: k for k in work['keys']}
    tmp = tempfile.mktemp(suffix='.json')
    grid = np.geomspace(0.04, 4.0, 25)
    # ---- 1. per-key decay model, mezzo layer, coordinate descent ---------------------------
    # Per key: sd / sr = multipliers of the direct / remanent T60s, g = frequency tilt of both (T60 ~ ratio^-g),
    # rem = remanent level offset (dB). Every key renders independently of the others, so one candidate value is
    # tried on all keys at once and each key keeps its own best.
    sel = []                                                            # (note, velocity, recording) for every clean layer
    for m, k in sorted(keys.items()):
        for l in k['layers']:
            if l.get('_rescued'): continue
            r = get(m, l['velocity'])
            if r and valid_len(*r) >= 4: sel.append((m, l['velocity'], r))   # need a few windows above the noise to fit a decay
    print(f'{len(sel)} recorded layers on {len({m for m, _, _ in sel})} keys', file=sys.stderr)
    Pk = {m: dict(sd=1.0, sr=1.0, g=0.0, rem=0.0, dt=None) for m in keys}
    bs = {}                                                            # best score per key
    def trial(param, values, combine, only=None):
        rows = [r for r in sel if only is None or r[0] in only]
        for val in values:
            cand = {m: dict(Pk[m]) for m in Pk}
            for m in {m for m, _, _ in rows}: combine(cand[m], val)
            json.dump(apply_params(doc, cand), open(tmp, 'w'))
            jobs = []
            for m, v, (re_, fl) in rows:
                n = valid_len(re_, fl); jobs.append({'note': m, 'vel': v, 'secs': min(6.0, len(re_) * WIN)})
            tot = {}                                                    # mean mismatch over the key's layers
            for (m, v, (re_, fl)), se in zip(rows, render(tmp, jobs)):
                sc, _ = score(re_, se, valid_len(re_, fl), fl); tot.setdefault(m, []).append(sc)
            for m, l in tot.items():
                sc = float(np.mean(l))
                if m not in bs or sc < bs[m] - 1e-9: bs[m] = sc; Pk[m] = cand[m]
    def both(q, v): q['sd'] = v; q['sr'] = v
    trial('both', np.geomspace(0.04, 4.0, 25), both)
    for it in range(3):
        wide = it == 0                                                  # first pass: wide searches (real tails can sit 20 dB up)
        trial('sd', np.geomspace(0.3, 3.3, 9) if wide else np.geomspace(0.6, 1.7, 5), lambda q, v: q.__setitem__('sd', q['sd'] * v))
        trial('sr', np.geomspace(0.2, 5.0, 11) if wide else np.geomspace(0.6, 1.7, 5), lambda q, v: q.__setitem__('sr', q['sr'] * v))
        trial('rem', np.linspace(-24, 24, 13) if wide else np.linspace(-6, 6, 7), lambda q, v: q.__setitem__('rem', q['rem'] + v))
        trial('g', np.linspace(-0.3, 0.3, 7) if wide else np.linspace(-0.1, 0.1, 5), lambda q, v: q.__setitem__('g', q['g'] + v))
    # unison beating: the notches of a treble note's envelope come from its strings' detunes. Search the two detunes
    # (cents) on a fine log grid, all layers of a key at once; a key keeps smooth unison unless a detune pair wins
    tre = {m for m, _, _ in sel if m >= 60}
    g2 = np.geomspace(0.15, 3.5, 12)
    trial('dt', [(a, b) for a in g2 for b in g2 if b >= a], lambda q, v: q.__setitem__('dt', v), only=tre)
    for it in range(2):
        trial('sr', np.geomspace(0.7, 1.4, 5), lambda q, v: q.__setitem__('sr', q['sr'] * v))
        trial('rem', np.linspace(-4, 4, 5), lambda q, v: q.__setitem__('rem', q['rem'] + v))
    # noisy recordings (< 60 dB above their own floor): the fit follows noise, so a key takes the median of its
    # +-3 noisy neighbours; clean references (renders, quiet rooms) keep their own per-key fit
    nv, snr = {}, {}
    for m, v, r in sel:                                                 # the loudest layer characterises the key
        if m not in snr or r[0][:4].max() - r[1] > snr[m]: snr[m] = float(r[0][:4].max() - r[1]); nv[m] = valid_len(r[0], r[1])
    noisy = [m for m in bs if snr[m] < 60 and nv[m] >= 10]
    for m in noisy:
        nb = [j for j in noisy if abs(j - m) <= 3]
        for f in ('sd', 'sr'): Pk[m][f] = math.exp(float(np.median([math.log(Pk[j][f]) for j in nb])))
        for f in ('g', 'rem'): Pk[m][f] = float(np.median([Pk[j][f] for j in nb]))
    ms = sorted(bs)
    for m in Pk:
        if m in bs or not ms: continue                                  # no usable recording: interpolate from neighbours
        for f in ('sd', 'sr'): Pk[m][f] = math.exp(float(np.interp(m, ms, [math.log(Pk[x][f]) for x in ms])))
        for f in ('g', 'rem'): Pk[m][f] = float(np.interp(m, ms, [Pk[x][f] for x in ms]))
    for m in Pk: Pk[m]['sd'] = min(max(Pk[m]['sd'], 0.04), 8); Pk[m]['sr'] = min(max(Pk[m]['sr'], 0.04), 8)
    work = apply_params(doc, Pk); wk = {k['note']: k for k in work['keys']}
    ld = {m: math.log(Pk[m]['sd']) for m in bs}; lr = {m: math.log(Pk[m]['sr']) for m in bs}; best = {m: (bs[m],) for m in bs}; bestd = best
    # ---- 2. level offsets per key and layer -------------------------------------------------
    json.dump(work, open(tmp, 'w'))
    jobs = []; idx = []
    for m, k in sorted(wk.items()):
        for L in k['layers']:
            r = None if L.get('_rescued') else get(m, L['velocity'])      # derived layers keep their derived level
            if r: jobs.append({'note': m, 'vel': L['velocity'], 'secs': 0.6}); idx.append((m, L['velocity']))
    ses = render(tmp, jobs); offs = {}
    for (m, v), se in zip(idx, ses):
        re_, fl = get(m, v); q = min(int(0.5 / WIN), max(2, valid_len(re_, fl) // 2), len(se)); offs[(m, v)] = float(np.mean(re_[:q] - se[:q]))
    for m, k in wk.items():
        lay = [offs.get((m, L['velocity'])) for L in k['layers']]
        if all(o is None for o in lay): continue
        ref = next(o for o in reversed(lay) if o is not None)          # loudest recorded layer sets the key level
        k['level_db'] = round(k.get('level_db', 0) + ref, 1)
        for L, o in zip(k['layers'], lay):
            if o is not None: L['gain_db'] = round(L['gain_db'] + (o - ref), 1)
    # ---- 3. inharmonicity where the analyzer fell back -------------------------------------
    good = {}
    for m, k in wk.items():
        bs = []
        for L in k['layers']:
            for r, lvl, *_ in L['partials']:
                n = round(r)
                if 2 <= n <= 6 and lvl > -45 and abs(r - n) < 0.2 * n:
                    q = (r / n) ** 2; b = (q - 1) / (n * n - q)
                    if 1e-5 < b < 0.05: bs.append(b)
        if bs: good[m] = float(np.median(bs))
    for m, k in wk.items():
        if abs(k.get('B', 0) - 1e-4) < 1e-9 and m in good: k['B'] = float(f'{good[m]:.3e}')
    for k in work['keys']:
        for L in k['layers']: L.pop('_rescued', None)
    work['decay_model']['note'] = (work['decay_model'].get('note', '') + ' + per-key analysis-by-synthesis calibration').strip()
    json.dump(work, open(out, 'w'), indent=1)
    for m in sorted(best)[::6]: print(f'key {m}: T60 scale {math.exp(ld[m]):.2f} (direct) {math.exp(lr[m]):.2f} (remanent), usable {nv[m]*WIN:.1f} s, env err {bestd[m][0]:.1f} dB', file=sys.stderr)

if __name__ == '__main__': main()
