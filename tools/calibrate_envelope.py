#!/usr/bin/env python3
"""Per-layer envelope calibration against real recordings.

    python3 tools/calibrate_envelope.py instrument.json out.json recordings_dir [--jobs 12]

For every key and velocity layer with a usable recording, four numbers are fitted so the engine's envelope follows the
recording's: a scale on the direct T60s (sd), a scale on the remanent T60s (sr), a remanent level offset in dB (rem) and a
frequency tilt of both T60s (g, T60 ~ ratio^-g). tools/calibrate_to_recordings.py fits one set per key from the mezzo layer;
here every layer has its own, since a soft note and a loud note of one key decay differently.

The score is the mean |render - recording| in dB of the 100 ms RMS at 10 times between 0.1 and 4 s, both relative to the note's
own loudest 50 ms in its first 0.4 s (a quiet key's onset detector can fire on the key thump, before the tone), both clipped at
the recording's noise floor (a tail hidden below the floor is not an error). Candidates are tried on all layers at once, in
parallel on `--jobs` processes, and each layer keeps its own best. Finish with tools/calibrate_levels.py.
"""
import sys, os, json, glob, math, argparse, subprocess, tempfile, importlib.util
import numpy as np, soundfile as sf, scipy.signal as ss
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('ai', os.path.join(HERE, 'analyze_instrument.py')); ai = importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
SR = 48000; TIMES = [0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 20.0]; SMAX = 20.5; CLAMP = (0.1, 8.0)
PARAMS = '{"hammerNoise":0.8,"globalRes":1,"sympRes":1,"keyNoise":0}'

def rms(x, a, b):
    s = x[int(a * SR):int(b * SR)]
    return 20 * np.log10(np.sqrt(np.mean(s ** 2)) + 1e-12) if len(s) else -240.0

def feats(x, ref=False):
    """(peak dB, [envelope dB relative to the peak at TIMES, nan where the recording had ended], noise floor rel. to peak)"""
    if np.abs(x).max() < 1e-7: return None
    o = ai.onset(x, SR); x = x[o:]
    pk = max(rms(x, t, t + 0.05) for t in np.arange(0, 0.4, 0.01))
    limit = len(x) / SR; fl = -200.0
    if ref:
        rel = ai.release_time(x, SR); limit = rel if rel else len(x) / SR
        if not rel and len(x) / SR > 4: fl = float(np.median([rms(x, t, t + 0.1) for t in np.arange(len(x) / SR - 1.5, len(x) / SR - 0.1, 0.1)]) - pk)
    return pk, np.array([rms(x, t, t + 0.1) - pk if t + 0.1 <= limit - 0.05 else np.nan for t in TIMES]), fl

def score_env(r, o, fl):
    ok = ~np.isnan(r) & (np.maximum(r, o) > -55)
    if ok.sum() < 3: return None
    return float(np.mean(np.minimum(np.abs(np.maximum(o[ok], fl) - np.maximum(r[ok], fl)), 40.0)))

def load_refs(rec):
    refs = {}
    for f in sorted(glob.glob(os.path.join(rec, '*.*'))):
        m, v = ai.parse_name(f)
        if m is None: continue
        try: x, sr = sf.read(f)
        except Exception: continue
        x = x.mean(1) if x.ndim > 1 else x
        if sr != SR: x = ss.resample_poly(x, SR, sr)
        r = feats(x[:int(21.7 * SR)], ref=True)
        if r is not None and r[0] > -80 and (~np.isnan(r[1])).sum() >= 3: refs[(m, v)] = r
    return refs

def render(doc, jobs, nproc):
    """render jobs in parallel; returns one float array per job"""
    with tempfile.TemporaryDirectory() as d:
        json.dump(doc, open(d + '/i.json', 'w')); chunks = [jobs[i::nproc] for i in range(nproc)]; procs = []
        for i, c in enumerate(chunks):
            if not c: continue
            json.dump(c, open(f'{d}/j{i}.json', 'w'))
            procs.append((i, subprocess.Popen(['node', os.path.join(ROOT, 'test/render_batch.mjs'), d + '/i.json', f'{d}/j{i}.json', f'{d}/o{i}.f32'])))
        for i, p in procs:
            if p.wait(): raise RuntimeError('render failed')
        out = [None] * len(jobs)
        for i, _ in procs:
            y = np.fromfile(f'{d}/o{i}.f32', 'f4').astype(float); p = 0
            for j, job in enumerate(chunks[i]):
                n = int(math.ceil(job['secs'] * SR / 128) * 128); out[i + j * nproc] = y[p:p + n]; p += n
    return out

def apply(doc, P, Dt=None):
    out = json.loads(json.dumps(doc))
    for k in out['keys']:
        if Dt and k['note'] in Dt: k['detune_cents'] = [round(c, 3) for c in Dt[k['note']]]
        for L in k['layers']:
            q = P.get((k['note'], L['velocity']))
            if not q: continue
            for p in L['partials']:
                tilt = max(p[0], 1.0) ** (-q['g']); sd = min(max(q['sd'], CLAMP[0]), CLAMP[1]); sr = min(max(q['sr'], CLAMP[0]), CLAMP[1])
                td = p[2] * sd * tilt; tr = max(p[3] * sr * tilt, td * 1.05)
                p[2] = round(td, 4); p[3] = round(tr, 4); p[4] = round(min(max(p[4] + q['rem'], -100.0), 0.0), 1)
    return out

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('instrument'); ap.add_argument('out'); ap.add_argument('recordings'); ap.add_argument('--jobs', type=int, default=12)
    ap.add_argument('--rounds', type=int, default=3)
    ap.add_argument('--detune', action='store_true', help='also search unison detunes (beating) for notes 48 and up')
    a = ap.parse_args()
    doc = json.load(open(a.instrument)); refs = load_refs(a.recordings)
    have = {(k['note'], L['velocity']) for k in doc['keys'] for L in k['layers']}
    layers = sorted(l for l in refs if l in have)
    print(f'{len(layers)} layers with a usable recording', file=sys.stderr)
    def need(l):                                     # render only as long as the recording has something to compare with
        ok = np.where(~np.isnan(refs[l][1]))[0]; return min(SMAX, TIMES[ok[-1]] + 0.2)
    jobs = [{'note': m, 'vel': v, 'secs': need((m, v)), 'params': json.loads(PARAMS)} for m, v in layers]
    P = {l: dict(sd=1.0, sr=1.0, rem=0.0, g=0.0) for l in layers}; best = {}
    Dt = {k['note']: k['detune_cents'] for k in doc['keys'] if k.get('detune_cents')}
    def evaluate(cand, dt=None):
        ys = render(apply(doc, cand, Dt if dt is None else dt), jobs, a.jobs); sc = {}
        for l, y in zip(layers, ys):
            f = feats(y)
            s = None if f is None else score_env(refs[l][1], f[1], refs[l][2])
            sc[l] = 99.0 if s is None else s
        return sc
    best = evaluate(P); print(f'start: mean env err {np.mean(list(best.values())):.3f} dB', file=sys.stderr)
    def trial(values, combine):
        for val in values:
            cand = {l: dict(P[l]) for l in layers}
            for l in layers: combine(cand[l], val)
            sc = evaluate(cand)
            for l in layers:
                if sc[l] < best[l] - 1e-9: best[l] = sc[l]; P[l] = cand[l]
    for it in range(a.rounds):
        wide = it == 0
        trial(np.geomspace(0.25, 4.0, 9) if wide else np.geomspace(0.7, 1.45, 5), lambda q, v: q.__setitem__('sd', min(max(q['sd'] * v, CLAMP[0]), CLAMP[1])))
        trial(np.geomspace(0.25, 4.0, 9) if wide else np.geomspace(0.7, 1.45, 5), lambda q, v: q.__setitem__('sr', min(max(q['sr'] * v, CLAMP[0]), CLAMP[1])))
        trial(np.linspace(-12, 12, 9) if wide else np.linspace(-4, 4, 5), lambda q, v: q.__setitem__('rem', q['rem'] + v))
        trial(np.linspace(-0.3, 0.3, 7) if wide else np.linspace(-0.1, 0.1, 5), lambda q, v: q.__setitem__('g', q['g'] + v))
        print(f'round {it}: mean env err {np.mean(list(best.values())):.3f} dB', file=sys.stderr, flush=True)
    if a.detune:
        tre = sorted({m for m, _ in layers if m >= 48}); g2 = np.geomspace(0.15, 3.5, 12); kb = {}
        def keyscore(sc): return {m: float(np.mean([sc[l] for l in layers if l[0] == m])) for m in tre}
        kb = keyscore(best)
        for x in g2:
            for y in g2:
                if y < x: continue
                cd = dict(Dt)
                for m in tre: cd[m] = [0, x, y] if m >= 42 else [0, y]
                ks = keyscore(evaluate(P, cd))
                for m in tre:
                    if ks[m] < kb[m] - 0.05: kb[m] = ks[m]; Dt[m] = cd[m]
            print(f'detune search: a={x:.2f}  mean key err {np.mean(list(kb.values())):.3f} dB, {len(Dt)} keys with detune', file=sys.stderr, flush=True)
        best = evaluate(P)
        for it in range(2):
            trial(np.geomspace(0.7, 1.45, 5), lambda q, v: q.__setitem__('sr', q['sr'] * v)); trial(np.linspace(-4, 4, 5), lambda q, v: q.__setitem__('rem', q['rem'] + v))
        print(f'after detune: mean env err {np.mean(list(best.values())):.3f} dB', file=sys.stderr, flush=True)
    json.dump({'P': {f'{m}_{v}': q for (m, v), q in P.items()}, 'Dt': {str(m): d for m, d in Dt.items()}}, open(a.out + '.params.json', 'w'))
    for q in P.values():
        for f in ('sd', 'sr'): q[f] = min(max(q[f], CLAMP[0]), CLAMP[1])
    res = apply(doc, P, Dt); dm = res.setdefault('decay_model', {})
    dm['note'] = (dm.get('note', '') + ' + per-layer envelope fit to the recordings (tools/calibrate_envelope.py)').lstrip(' +')
    json.dump(res, open(a.out, 'w'), indent=1); print('wrote', a.out, file=sys.stderr)

if __name__ == '__main__': sys.exit(main())
