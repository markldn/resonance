#!/usr/bin/env python3
"""Build a resonance-instrument/1 file for every instrument in a folder of single-note recordings.

    python3 tools/build_sampled_set.py RECORDINGS_DIR [--out DIR]     (default DIR: <folder>/_resonance)

Layout: one sub-folder per instrument, files like clarinet-b3.wav, flutes-stc-rr1-a3.wav, piano-f-a1.wav (a note name with C4 = 60 at
the end; an articulation word before it: sus = sustained, stc = staccato, piz = pizzicato, p / f = a strength). One instrument file is
written per folder and articulation. Sustained notes (sus, or no articulation) go through tools/analyze_sustained.py (held partials, attack,
vibrato, noise); plucked, staccato and struck notes (piz, stc, harp, piano) through tools/analyze_instrument.py (decaying partials).
Files that start with "." (macOS resource forks) are ignored. Only the first take (rr1) of a round-robin set is used.
The output is meant for your own use: check the licence of the recordings before you publish anything built from them.
"""
import sys, os, re, glob, json, argparse, subprocess, tempfile, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
FAMILY = [('violin', 'strings'), ('viola', 'strings'), ('cello', 'strings'), ('bass', 'strings'), ('harp', 'other'), ('horn', 'brass'), ('trumpet', 'brass'), ('trombone', 'brass'), ('tuba', 'brass')]
DYN = {'p': 'p', 'f': 'f'}

def family(folder):
    f = folder.lower()
    if 'clarinet' in f or 'flute' in f or 'oboe' in f or 'bassoon' in f or 'piccolo' in f or 'anglais' in f: return 'wind'
    for k, v in FAMILY:
        if k in f: return v
    return 'other'

def tidy_struck(path):
    """a plucked or staccato instrument is not a piano: no key or pedal noise, no hammer knock, no strings ringing each other, and the per-key stiffness fits
    (0 on one key, 0.005 on the next) are replaced by the median of the neighbouring keys, floored at 1e-5 so the String length slider has a string to act on"""
    doc = json.load(open(path)); ks = sorted(doc['keys'], key=lambda k: k['note']); Bs = [k.get('B') or 0.0 for k in ks]
    good = [b for b in Bs if 2e-5 <= b <= 2e-3]; base = sorted(good)[len(good) // 2] if good else 2e-4
    for i, k in enumerate(ks):
        nb = sorted(b for b in Bs[max(0, i - 2):i + 3] if 2e-5 <= b <= 2e-3); k['B'] = float(f'{(nb[len(nb) // 2] if nb else base):.3g}')
    doc['engine'] = dict(doc.get('engine') or {}, key_noise=False, sympathetic=False, knock=0, quadratic=0)
    json.dump(doc, open(path, 'w'), indent=1)

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
def token(m): return NOTE_NAMES[m % 12] + str(m // 12 - 1)

def A_key(path):
    m = re.search(r'([a-g])([#b]?)(\d)\.wav$', path, re.I); return 12 * (int(m.group(3)) + 1) + {'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11}[m.group(1).lower()] + (1 if m.group(2) == '#' else -1 if m.group(2) == 'b' else 0)

def sounding_key(path):
    """the key a recording really plays (tools/analyze_sustained.py resolve_key), and how many octaves its file name was off; the name if it cannot tell"""
    import importlib.util
    spec = importlib.util.spec_from_file_location('as_', os.path.join(HERE, 'analyze_sustained.py')); A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
    m = A.key_of(path)
    try:
        x, sr = A.load(path); e, hop = A.envelope(x, sr); o = int(np.argmax(e > 0.03 * e.max())) * hop
        F, P = A.spec(x, sr, o + 0.03, min(o + 0.6, len(x) / sr - 0.01)); return A.resolve_key(F, P, m, 440.0, A.yin_pitch(x, sr, int(o * sr) + int(0.03 * sr)))
    except Exception: return m, 0

def word(art, plural):
    return ', '.join([('section' if plural else 'solo')] + [{'piz': 'pizzicato', 'stc': 'staccato', 'sus': 'sustained'}.get(t, t) for t in (art.split('-') if art else ['sus']) if t not in ('p', 'f', 'rr1') and not t.endswith('s') or t in ('piz', 'stc', 'sus')])

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('folder'); ap.add_argument('--out'); ap.add_argument('--license', default='recordings of unknown licence: personal use only')
    a = ap.parse_args(); out = a.out or os.path.join(a.folder, '_resonance'); os.makedirs(out, exist_ok=True)
    entries = []
    for d in sorted(os.listdir(a.folder)):
        p = os.path.join(a.folder, d)
        if not os.path.isdir(p) or d.startswith(('_', '.')) or d.lower() == 'percussion': continue
        groups = collections.defaultdict(list)
        for f in sorted(glob.glob(os.path.join(p, '*.wav'))):
            b = os.path.basename(f)
            if b.startswith('.'): continue
            m = re.match(r'(.*?)-((?:[a-z]+\d?-)*)([a-g][#b]?\d)\.wav$', b, re.I)
            if not m: print('skip', b); continue
            parts = [t for t in m.group(2).strip('-').lower().split('-') if t]
            if any(t.startswith('rr') and t != 'rr1' for t in parts): continue                 # one take per note
            groups['-'.join(t for t in parts if not t.startswith('rr'))].append(f)
        if 'p' in groups and 'f' in groups: groups['p-f'] = groups.pop('p') + groups.pop('f')   # two strengths of one instrument: two layers
        for art, files in groups.items():
            toks = art.split('-'); short = 'stc' in toks or 'piz' in toks                                      # staccato winds and brass: a voice with its own decay, not a struck string
            decaying = (any(t in toks for t in ('p', 'f', 'p-f')) or d.lower() in ('harp', 'grand piano')) and not short
            plural = d.lower().endswith('s') and d.lower() != 'cor anglais'
            entries.append(dict(d=d, art=art, files=files, short=short, decaying=decaying, plural=plural, fam=re.sub(r'(?i)s$', '', d).lower(),
                                fn=re.sub(r'[^A-Za-z0-9]+', '_', d + ('_' + art if art else '')).strip('_').lower() + '.json'))
    fams = collections.defaultdict(list)
    for e in entries:
        if not e['d'][0].isdigit(): fams[e['fam']].append(e)
    for e in entries:                                                                            # names: Flute 1 (section, sustained), Flute 2 (section, staccato) ...
        many = fams.get(e['fam'], [])
        if e['d'][0].isdigit() or len(many) < 2: e['nm'] = f"{e['d']} ({word(e['art'], e['plural']) if e['art'] or e['plural'] else 'solo'}) (measured)" if e['art'] not in ('', 'p-f') or e['d'][0].isdigit() else f"{e['d']} (measured)"
        else:
            order = sorted(many, key=lambda z: (z['plural'], 'stc' in z['art'] or 'piz' in z['art'], z['art'])); n = order.index(e) + 1
            e['nm'] = f"{re.sub(r'(?i)s$', '', e['d'])} {n} ({word(e['art'], e['plural'])}) (measured)"
    for e in entries:
        d, art, files, short, decaying, nm = e['d'], e['art'], e['files'], e['short'], e['decaying'], e['nm']; dest = os.path.join(out, e['fn'])
        if decaying:
            with tempfile.TemporaryDirectory() as t:
                for f in files:
                    key, shift = (A_key(f), 0) if d.lower() in ('grand piano', 'harp') else sounding_key(f)
                    if shift: print(f'  {os.path.basename(f)}: sounds {token(key)} ({shift:+d} octave from its name)')
                    dyn = 'mf'; mm = re.match(r'.*?-(p|f)-[a-g][#b]?\d\.wav$', os.path.basename(f), re.I)
                    if mm: dyn = mm.group(1).lower()
                    os.symlink(os.path.abspath(f), os.path.join(t, f'{token(key)}_{dyn}{os.path.splitext(f)[1]}'))
                cmd = [sys.executable, os.path.join(HERE, 'analyze_instrument.py'), '--name', nm, '--license', a.license, '--out', dest] + sorted(glob.glob(t + '/*'))
                r = subprocess.run(cmd, capture_output=True, text=True)
                if r.returncode == 0: subprocess.run([sys.executable, os.path.join(HERE, 'calibrate_levels.py'), dest, dest, t], capture_output=True, text=True)   # loudness of every layer against its recording
        else:
            cmd = [sys.executable, os.path.join(HERE, 'analyze_sustained.py'), '--name', nm, '--family', family(d), '--license', a.license, '--out', dest] + (['--short'] if short else []) + files
            r = subprocess.run(cmd, capture_output=True, text=True)
            for l in r.stderr.splitlines():
                if 'octave' in l: print(l)
        if decaying and r.returncode == 0 and d.lower() != 'grand piano': tidy_struck(dest)
        if r.returncode == 0: subprocess.run([sys.executable, os.path.join(HERE, 'normalise_level.py'), dest], capture_output=True, text=True)      # same playing loudness as the Iowa Grand
        print(f'{"decaying" if decaying else "staccato" if short else "sustained":9s} {nm:44s} {len(files):3d} files -> {e["fn"]}' + ('' if r.returncode == 0 else '   FAILED: ' + (r.stderr.strip().splitlines() or [''])[-1]))

if __name__ == '__main__': sys.exit(main())
