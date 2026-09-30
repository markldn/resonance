#!/usr/bin/env python3
"""Fidelity benchmark: how closely does the engine reproduce recordings of an instrument?

    python3 tools/fidelity.py instrument.json recordings_dir [--hide 2] [--params '{"hammerNoise":0.8}']

recordings_dir holds single-note files named like C4_v64.wav / A0-v100.flac / Piano.mf.Eb3.aiff (see
analyze_instrument.py). Each note is rendered offline through the shipped engine and compared with its recording:
  level err   50 ms RMS at the attack, dB (ours - recording)
  env err     |ours - recording| in dB of the 100 ms RMS at 0.1 0.5 1 2 4 s, each relative to the note's own attack,
              only where either signal is above -55 dB (below that nothing is audible), both clipped at the recording's own noise floor
--hide N drops every Nth measured key from the instrument first and scores only the notes it dropped: the engine's
accuracy on notes it was never given (interpolation between keys). Prints per register group and overall.
"""
import sys, os, json, math, glob, argparse, subprocess, tempfile, importlib.util
import numpy as np, soundfile as sf, scipy.signal as ss
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('ai', os.path.join(HERE, 'analyze_instrument.py')); ai = importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
SR = 48000; T = [0.1, 0.5, 1, 2, 4]; PEAK = True
GROUPS = [(21, 48, 'A0-C3'), (49, 72, 'C#3-C5'), (73, 96, 'C#5-C7'), (97, 108, 'C#7-C8')]

def rms(x, a, b):
    s = x[int(a * SR):int(b * SR)]
    return 20 * np.log10(np.sqrt(np.mean(s ** 2)) + 1e-12) if len(s) else -240.0

def feats(x, ref=False):
    """(attack level dB, envelope dB relative to the attack at each T, or nan where the recording had ended or the key was released)"""
    if np.abs(x).max() < 1e-7: return None
    o = ai.onset(x, SR); x = x[o:]
    if PEAK: x = x[int(max(range(40), key=lambda i: rms(x, i * 0.01, i * 0.01 + 0.05)) * 0.01 * SR):]   # the loudest 50 ms of the first 0.4 s is the attack: a soft key's onset detector can fire on the key thump before the tone
    pk = rms(x, 0, 0.05)
    rel = ai.release_time(x, SR) if ref else None                    # a recording of a held key: damper noise is not the piano
    limit = rel if rel else len(x) / SR
    fl = np.nan
    if ref and not rel and len(x) / SR > 4:                            # the recording's own hiss/room level: what a dead note settles at
        fl = float(np.median([rms(x, t, t + 0.1) for t in np.arange(len(x) / SR - 1.5, len(x) / SR - 0.1, 0.1)]) - pk)
    return pk, [rms(x, t, t + 0.1) - pk if t + 0.1 <= limit - 0.05 else np.nan for t in T], fl

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('instrument'); ap.add_argument('recordings')
    ap.add_argument('--hide', type=int, default=0, help='hide every Nth measured key, score only those notes')
    ap.add_argument('--params', default='{"hammerNoise":0.8,"globalRes":1,"sympRes":1,"keyNoise":0}')
    ap.add_argument('--json', help='write the per-note results here')
    ap.add_argument('--attack', choices=['peak', 'onset'], default='peak', help="reference point of the envelope: the loudest 50 ms of the first 0.4 s (default) or the first 50 ms after the detected onset")
    a = ap.parse_args(); global PEAK; PEAK = a.attack == 'peak'
    doc = json.load(open(a.instrument)); held = None
    if a.hide:
        ks = doc['keys']; keep = [k for i, k in enumerate(ks) if i % a.hide or i == 0 or i == len(ks) - 1]
        held = {k['note'] for k in ks} - {k['note'] for k in keep}; doc = dict(doc, keys=keep)
    files = sorted(glob.glob(os.path.join(a.recordings, '*.*')))
    jobs, meta = [], []
    for f in files:
        m, v = ai.parse_name(f)
        if m is None or (held is not None and m not in held): continue
        try: x, sr = sf.read(f)
        except Exception: continue
        x = x.mean(1) if x.ndim > 1 else x
        if sr != SR: x = ss.resample_poly(x, SR, sr)
        secs = min(len(x) / SR, 8.0 + ai.onset(x, SR) / SR); ref = feats(x[:int(secs * SR)], ref=True)
        secs = min(secs - ai.onset(x, SR) / SR, 8.0)
        if ref is None or ref[0] < -80: continue                    # silent reference (keys a trial build mutes): nothing to compare
        jobs.append({'note': m, 'vel': v, 'secs': secs, 'off': 7.5, 'params': json.loads(a.params)}); meta.append((m, v, ref, secs))
    with tempfile.TemporaryDirectory() as d:
        json.dump(doc, open(d + '/i.json', 'w')); json.dump(jobs, open(d + '/j.json', 'w'))
        subprocess.run(['node', os.path.join(ROOT, 'test/render_batch.mjs'), d + '/i.json', d + '/j.json', d + '/o.f32'], check=True)
        y = np.fromfile(d + '/o.f32', 'f4').astype(float)
    rows = []; p = 0
    for (m, v, ref, secs) in meta:
        n = int(math.ceil(secs * SR / 128) * 128); ours = feats(y[p:p + n]); p += n
        if ours is None: continue
        fl = ref[2] if not np.isnan(ref[2]) else -200.0
        env = [min(abs(max(b, fl) - max(r, fl)), 40.0) if (max(b, r) > -55 and not np.isnan(r)) else np.nan for r, b in zip(ref[1], ours[1])]   # one wrong tail counts at most 40 dB
        rows.append(dict(note=m, vel=v, level=ours[0] - ref[0], env=env))
    if not rows: print('no notes scored'); return 1
    print(f"{'group':8s} {'notes':>5s} {'level err mean':>15s} {'level std':>10s} {'env err |dB|':>13s}   by time {T}")
    for lo, hi, name in GROUPS:
        g = [r for r in rows if lo <= r['note'] <= hi]
        if not g: continue
        E = np.array([r['env'] for r in g], float)
        with np.errstate(all='ignore'): byt = np.nanmean(E, 0)
        print(f"{name:8s} {len(g):5d} {np.mean([r['level'] for r in g]):15.2f} {np.std([r['level'] for r in g]):10.2f} {np.nanmean(E):13.2f}   {np.round(byt, 1)}")
    E = np.array([r['env'] for r in rows], float)
    print(f"median note env err {np.median([np.nanmean(e) for e in E if not np.all(np.isnan(e))]):.2f} dB")
    print(f"OVERALL  {len(rows):5d} {np.mean([r['level'] for r in rows]):15.2f} {np.std([r['level'] for r in rows]):10.2f} {np.nanmean(E):13.2f}   ({'hidden keys only' if held else 'all notes'})")
    if a.json: json.dump(rows, open(a.json, 'w'))
    return 0

if __name__ == '__main__': sys.exit(main())
