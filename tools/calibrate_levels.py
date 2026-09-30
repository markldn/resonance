#!/usr/bin/env python3
"""Level-only calibration: trim every layer's gain_db so the engine's note is as loud as the recording.

    python3 tools/calibrate_levels.py instrument.json out.json recordings_dir [--iters 3] [--params '{...}']

Use it as the last step after any change that moves levels (regularize_brightness.py, regularize_decays.py, hand edits).
tools/calibrate_to_recordings.py also fits decays; this one leaves partials and decay times alone.

For each key and layer that has a recording, the shipped engine renders the note at the layer's velocity and its RMS over the
first `--window` seconds after the onset (default 0.15) is compared with the recording's. gain_db is corrected by the difference and the render is repeated
(the engine's per-note normalisation makes the first correction almost exact). Prints the level error before and after.
"""
import sys, os, json, glob, math, argparse, subprocess, tempfile, importlib.util
import numpy as np, soundfile as sf, scipy.signal as ss
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('ai', os.path.join(HERE, 'analyze_instrument.py')); ai = importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
SR = 48000; WIN = 0.5

def level(x, win=None, noise=None):
    """RMS in dB over `win` seconds starting at the loudest 50 ms of the attack (a soft key's onset detector can fire on the key thump). With `noise` (a noise power, from `noise_power`) that power is subtracted
    first, and None comes back when the note is less than 6 dB above the noise (there the recording measures the room)."""
    o = ai.onset(x, SR); x = x[o:]
    e = [np.mean(x[i * 480:i * 480 + 2400] ** 2) for i in range(40)]           # the loudest 50 ms of the first 0.4 s is the attack
    o = int(np.argmax(e)) * 480; s = x[o:o + int((win or WIN) * SR)]
    if len(s) <= 1000: return None
    p = float(np.mean(s ** 2))
    if noise is not None:
        if p < 4 * noise: return None
        p -= noise
    return 10 * np.log10(p + 1e-24)

def noise_power(x):
    """the recording's noise: the quiet before the onset, else its quietest 100 ms"""
    o = ai.onset(x, SR); pre = x[max(0, o - int(0.5 * SR)):max(0, o - int(0.01 * SR))]
    if len(pre) > 0.1 * SR: return float(np.mean(pre ** 2))
    n = int(0.1 * SR); m = len(x) // n
    return float(np.min(np.mean(x[:m * n].reshape(m, n) ** 2, 1))) if m else 0.0

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('instrument'); ap.add_argument('out'); ap.add_argument('recordings')
    ap.add_argument('--iters', type=int, default=3)
    ap.add_argument('--window', type=float, default=0.15, help='seconds after the onset whose RMS is matched (default 0.15)')
    ap.add_argument('--params', default='{"hammerNoise":0.8,"globalRes":1,"sympRes":1,"keyNoise":0}')
    a = ap.parse_args()
    doc = json.load(open(a.instrument)); params = json.loads(a.params); ref = {}
    for f in sorted(glob.glob(os.path.join(a.recordings, '*.*'))):
        m, v = ai.parse_name(f)
        if m is None: continue
        try: x, sr = sf.read(f)
        except Exception: continue
        x = x.mean(1) if x.ndim > 1 else x
        if sr != SR: x = ss.resample_poly(x, SR, sr)
        x = x[:int(4 * SR)]; r = level(x, a.window, noise_power(x))
        if r is not None and r > -80: ref[(m, v)] = r
    keys = {k['note']: k for k in doc['keys']}
    todo = [(m, L) for m, k in sorted(keys.items()) for L in k['layers'] if (m, L['velocity']) in ref]
    for it in range(a.iters + 1):
        jobs = [{'note': m, 'vel': L['velocity'], 'secs': 0.8, 'params': params} for m, L in todo]
        with tempfile.TemporaryDirectory() as d:
            json.dump(doc, open(d + '/i.json', 'w')); json.dump(jobs, open(d + '/j.json', 'w'))
            subprocess.run(['node', os.path.join(ROOT, 'test/render_batch.mjs'), d + '/i.json', d + '/j.json', d + '/o.f32'], check=True)
            y = np.fromfile(d + '/o.f32', 'f4').astype(float)
        n = int(math.ceil(0.8 * SR / 128) * 128); err = []
        for i, (m, L) in enumerate(todo):
            ours = level(y[i * n:(i + 1) * n], a.window)
            e = (ours if ours is not None else -120.0) - ref[(m, L['velocity'])]; err.append(e)
            if it < a.iters and abs(e) > 0.05: L['gain_db'] = round(L['gain_db'] - max(-12.0, min(12.0, e)), 2)
        err = np.array(err); print(f'pass {it}: level error mean {err.mean():+.2f} dB, std {err.std():.2f}, worst {np.abs(err).max():.2f}  ({len(err)} layers)')
    dm = doc.setdefault('decay_model', {}); note = f'levels trimmed to the recordings (tools/calibrate_levels.py, {a.window} s window)'
    if note not in dm.get('note', ''): dm['note'] = (dm.get('note', '') + ' + ' + note).lstrip(' +')
    json.dump(doc, open(a.out, 'w'), indent=1); print('wrote', a.out)

if __name__ == '__main__': sys.exit(main())
