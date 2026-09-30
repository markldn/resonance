#!/usr/bin/env python3
"""Give a measured instrument the playing loudness of the shipped Iowa Grand.

    python3 tools/normalise_level.py instrument.json [out.json]      (default: in place)

Recordings arrive at whatever level they were made at (a close-miked piano is 10 dB louder than the Iowa Grand's), and the engine keeps that:
an instrument built from them jumps in volume when it is selected, and the fixed-size mechanical noises (key release, pedal) sit further below a
louder note. This renders every key of the instrument and of the Iowa Grand through the engine at the same strength (the layer nearest velocity 72),
measures the attack loudness the way tools/calibrate_levels.py does (RMS over 0.15 s from the loudest 50 ms), and shifts every key's
level_db by the difference of the two means. Relative levels between keys and layers are untouched.
"""
import sys, os, json, subprocess, tempfile, importlib.util
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('cl', os.path.join(HERE, 'calibrate_levels.py')); cl = importlib.util.module_from_spec(spec); spec.loader.exec_module(cl)
SR = 48000

def mean_level(path):
    doc = json.load(open(path)); jobs = []
    for k in doc['keys']:
        v = min((L['velocity'] for L in k['layers']), key=lambda v: abs(v - 72)); jobs.append({'note': k['note'], 'vel': v, 'secs': 0.8, 'params': {'globalRes': 1, 'sympRes': 1, 'hammerNoise': 0.8, 'keyNoise': 0}})
    with tempfile.TemporaryDirectory() as d:
        json.dump(jobs, open(d + '/j.json', 'w'))
        subprocess.run(['node', os.path.join(ROOT, 'test/render_batch.mjs'), path, d + '/j.json', d + '/o.f32'], check=True)
        y = np.fromfile(d + '/o.f32', 'f4').astype(float)
    n = int(np.ceil(0.8 * SR / 128) * 128); lv = [cl.level(y[i * n:(i + 1) * n], 0.15) for i in range(len(jobs))]
    return float(np.mean([v for v in lv if v is not None and v > -90]))

def main():
    src = sys.argv[1]; dst = sys.argv[2] if len(sys.argv) > 2 else src
    ref = mean_level(os.path.join(ROOT, 'data/measured/iowa_grand.json')); cur = mean_level(src); shift = ref - cur
    doc = json.load(open(src))
    for k in doc['keys']: k['level_db'] = round(k.get('level_db', 0) + shift, 2)
    json.dump(doc, open(dst, 'w'), indent=1); print(f'{os.path.basename(src)}: {cur:.1f} dB -> {ref:.1f} dB (shift {shift:+.1f})', file=sys.stderr)

if __name__ == '__main__': sys.exit(main())
