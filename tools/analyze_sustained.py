#!/usr/bin/env python3
"""Measure a sustained instrument (strings, winds, brass, organ-like) from single-note recordings.

    python3 tools/analyze_sustained.py --name "Clarinet" --family wind --out clarinet.json  clarinet-b3.wav clarinet-d4.wav ...

tools/analyze_instrument.py fits decaying partials (a struck string). A bowed or blown note does not decay: it holds a spectrum, rises
over a bow or breath attack, wobbles in pitch and carries noise. For each recording this measures

  partials   the level of the first harmonics (up to 16 kHz) as the mean power over the steady part of the note, peaks found within 1.5 % of n f0,
             f0 refined from the recording (a comb over the first 8 harmonics), so the instrument's own intonation is kept in the ratios
  attack_s   10-90 % rise time of the RMS envelope
  vibrato    pitch track of the strongest low harmonic, band-passed 3-9 Hz: rate, depth (cents, peak), the time it takes to set in
  noise      the power left after the harmonics are removed (bins within 4 % of every n f0 masked), 200 Hz - 10 kHz, relative to the tone:
             written as a resonator bank (breath, bow: noise at the partials) and, above 4 kHz, plain band noise
  level      the loudness of the steady part, so keys keep their relative levels

and writes a resonance-instrument/1 file with every partial held (T60 3000 s), the median attack, vibrato and noise of all notes in
`engine.synth`, and a release time and voice mode from --family. Names carry the key (clarinet-b3.wav, horns-sus-a#2.wav, C4.wav; C4 = 60).
The engine interpolates partial by partial between the keys you give it.
"""
import sys, os, re, json, math, argparse, collections
import numpy as np, soundfile as sf, scipy.signal as ss

NOTE = {'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11}
FAMILY = {  # release_s, mono, vibrato default when none is heard (Hz), attack floor
    'strings': dict(release_s=0.35, mono=False), 'wind': dict(release_s=0.12, mono=True), 'brass': dict(release_s=0.14, mono=False),
    'other': dict(release_s=0.25, mono=False)}

def key_of(name):
    m = re.search(r'(?<![a-z])([a-g])([#b]?)(-?\d)(?=\.[a-z0-9]+$|$)', os.path.basename(name).lower())
    if not m: return None
    return 12 * (int(m.group(3)) + 1) + NOTE[m.group(1)] + (1 if m.group(2) == '#' else -1 if m.group(2) == 'b' else 0)

def load(path):
    x, sr = sf.read(path); x = x.mean(1) if x.ndim > 1 else x
    return x.astype(float), sr

def envelope(x, sr, hop=0.005, win=0.02):
    n = int(win * sr); h = int(hop * sr); k = np.ones(n) / n
    e = np.sqrt(np.maximum(np.convolve(x * x, k, 'same')[::h], 0)); return e, hop

def segment(x, sr, short=False):
    """(start of the note, start and end of its analysed part, attack rise time, T60 of its decay) from the RMS envelope.
    short=True is for staccato notes: no steady part, the note is analysed from its attack to 0.3 s after its peak and its decay is measured."""
    e, hop = envelope(x, sr); pk = e.max()
    if pk < 1e-5: return None
    o = int(np.argmax(e > 0.03 * pk))                        # onset: 3 % of peak amplitude (-30 dB)
    if short:
        top = o + int(np.argmax(e[o:o + int(0.6 / hop)])); ref = e[top]
        lim = o + int(np.argmax(e[o:] > 0.9 * ref)); t10 = o + int(np.argmax(e[o:top + 1] > 0.1 * ref)); att = max(0.004, (lim - t10) * hop)
        seg = e[top:top + int(0.8 / hop)]; ok = seg > 0.03 * ref; n = int(np.argmin(ok)) if not ok.all() else len(seg)
        db = 20 * np.log10(seg[:max(n, 4)] / ref + 1e-9); slope = np.polyfit(np.arange(len(db)) * hop, db, 1)[0] if len(db) >= 4 else -60.0
        t60 = float(np.clip(-60.0 / min(slope, -1.0), 0.05, 6.0))
        return o * hop, o * hop + 0.02, min(o * hop + 0.14, len(x) / sr - 0.02), att, t60      # levels are read at the onset, where the decays start
    top = o + int(np.argmax(e[o:o + int(1.5 / hop)]))         # the loudest point of the first 1.5 s
    a, b = o + int(0.4 / hop), min(len(e), o + int(1.2 / hop))
    ref = float(np.median(e[a:b])) if b - a > 10 else e[top]     # the level the note settles at: a swell later in the note is not its attack
    lim = o + int(np.argmax(e[o:] > 0.9 * ref)) if (e[o:] > 0.9 * ref).any() else top
    t10 = o + int(np.argmax(e[o:lim + 1] > 0.1 * ref)); t90 = lim
    att = max(0.004, (t90 - t10) * hop)
    end = len(e) - 1
    while end > top and e[end] < 0.25 * ref: end -= 1         # the note before its tail-off
    s0 = top * hop + 0.15; s1 = max(s0 + 0.3, end * hop - 0.15)
    s1 = min(s1, s0 + 3.0, len(x) / sr - 0.05)
    if s1 - s0 < 0.25: s0 = top * hop; s1 = min(len(x) / sr - 0.02, s0 + 0.6)
    return o * hop, s0, s1, att, None

def spec(x, sr, a, b, nfft=None):
    seg = x[int(a * sr):int(b * sr)]; n = len(seg); w = np.hanning(n)
    N = nfft or 1 << int(math.ceil(math.log2(n * 4)))
    return np.fft.rfftfreq(N, 1 / sr), np.abs(np.fft.rfft(seg * w, N)) ** 2 / np.sum(w ** 2)

def refine_f0(F, P, f_nom):
    """the f0 near f_nom whose first 8 harmonics carry the most (log) power"""
    best, bs = f_nom, -1e9
    for c in np.arange(-70, 70.1, 1.0):
        f0 = f_nom * 2 ** (c / 1200); s = 0
        for n in range(1, 9):
            f = f0 * n
            if f > F[-1] * 0.95: break
            lo, hi = np.searchsorted(F, [f * 0.993, f * 1.007]); s += math.log10(P[lo:hi].max() + 1e-20) if hi > lo else -20
        if s > bs: bs, best = s, f0
    return best

def yin_pitch(x, sr, s0):
    """pitch in Hz by the YIN difference function (de Cheveigne and Kawahara 2002) on 0.3 s from sample s0, or None: a period detector, blind to which
    harmonic is the strongest and happy with a missing fundamental, but it can land an octave off on a spectrum with a dominant overtone"""
    tmax = int(sr / 24); tmin = max(2, int(sr / 4700)); W = min(int(0.3 * sr), len(x) - s0 - tmax - 1)
    if W < 4 * tmin: return None
    seg = x[s0:s0 + W + tmax]; head = seg[:W]
    r = ss.fftconvolve(seg, head[::-1], 'valid')[:tmax + 1] if False else np.array([np.dot(head, seg[t:t + W]) for t in range(tmax + 1)]) if tmax < 400 else ss.fftconvolve(seg, head[::-1])[W - 1:W + tmax]
    c = np.concatenate([[0], np.cumsum(seg ** 2)]); d = np.array([c[W] + c[W + t] - c[t] - 2 * r[t] for t in range(tmax + 1)]); d[0] = 0
    nd = np.ones(tmax + 1); run = 0.0
    for t in range(1, tmax + 1): run += d[t]; nd[t] = d[t] * t / run if run > 0 else 1
    for t in range(tmin, tmax):
        if nd[t] < 0.15:
            while t + 1 < tmax and nd[t + 1] < nd[t]: t += 1
            return sr / t
    return None

def resolve_key(F, P, m_named, a4=440.0, f_yin=None, prefer=0):
    """(key that actually sounds, octaves the file name was off). A file name is a label, not a measurement: a flute named A4 sounds an octave higher,
    and a wrong guess puts the wrong partial on the key. Candidates are the named pitch and its octaves, nearest first. The named pitch stays if its
    fundamental is really there (a clear peak at f, 10 dB over the spectrum around it, at most 25 dB under the strongest of the first 8 harmonics).
    Another octave is taken only if its fundamental is there AND the period detector (yin_pitch) hears that pitch: a weak fundamental alone (a piano's
    bass, a contrabassoon) is not proof that the name is wrong."""
    def power(f):
        lo, hi = np.searchsorted(F, [f * 0.985, f * 1.015]); return P[lo:hi].max() if hi > lo else 0.0
    def around(f):
        lo, hi = np.searchsorted(F, [f * 0.7, f * 1.4]); return np.median(P[lo:hi]) + 1e-20
    def ok(k):
        f = a4 * 2 ** ((m_named + 12 * k - 69) / 12)
        if f < 25 or f > 4500: return False
        top = max(power(f * n) for n in range(1, 9))
        return top > 0 and power(f) >= top * 10 ** -2.5 and power(f) > 10 * around(f)
    for k in (-1, -2):                                                   # the named pitch is an overtone of a lower note that really is there and that the period detector hears
        if f_yin is not None and ok(k) and abs(12 * math.log2(f_yin / (a4 * 2 ** ((m_named + 12 * k - 69) / 12)))) < 0.7: return m_named + 12 * k, k
    for k in ([prefer] if prefer else []) + [0, 1, -1, 2, -2]:
        f = a4 * 2 ** ((m_named + 12 * k - 69) / 12)
        if f < 25 or f > 4500: continue
        top = max(power(f * n) for n in range(1, 9))
        if not (top > 0 and power(f) >= top * 10 ** -2.5 and power(f) > 10 * around(f)): continue
        if k == 0 or k == prefer or (f_yin is not None and abs(12 * math.log2(f_yin / f)) < 0.7): return m_named + 12 * k, k
    return m_named, 0

def partials(F, P, f0, sr):
    out = []; top = 0
    for n in range(1, 200):
        f = n * f0
        if f > min(16000, 0.45 * sr): break
        lo, hi = np.searchsorted(F, [f * 0.985, f * 1.015])
        if hi <= lo: continue
        k = lo + int(np.argmax(P[lo:hi])); p = P[max(0, k - 2):k + 3].sum()      # the peak's power (main lobe)
        out.append((n, 10 * math.log10(p + 1e-20)))
    if not out: return []
    top = max(v for _, v in out)
    return [[n, round(v - top, 1)] for n, v in out if v - top > -65][:100]     # the engine plays at most 100 partials per note

def vibrato(x, sr, f0, s0, s1):
    """(rate Hz, peak depth cents, onset delay s) of the pitch modulation over the steady part, or (0, 0, 0)"""
    n = 2 if f0 < 700 else 1                                   # a low harmonic that is clearly there but with enough cycles per frame
    fr, hop = 0.06, 0.01; L = int(fr * sr); tr = []
    for t in np.arange(s0, s1 - fr, hop):
        seg = x[int(t * sr):int(t * sr) + L]; w = np.hanning(L); N = 1 << 16
        X = np.abs(np.fft.rfft(seg * w, N)); F = np.fft.rfftfreq(N, 1 / sr); f = n * f0
        lo, hi = np.searchsorted(F, [f * 0.96, f * 1.04]); k = lo + int(np.argmax(X[lo:hi]))
        a, b, c = np.log(X[k - 1] + 1e-12), np.log(X[k] + 1e-12), np.log(X[k + 1] + 1e-12); d = a - 2 * b + c
        off = max(-1.0, min(1.0, 0.5 * (a - c) / d)) if d else 0.0                # a peak at the edge of the search range gives a wild parabola
        tr.append(1200 * math.log2((F[k] + off * (F[1] - F[0])) / f))
    tr = np.array(tr)
    if len(tr) < 30: return 0.0, 0.0, 0.0
    fs = 1 / hop; sos = ss.butter(2, [3.0, 9.0], 'bp', fs=fs, output='sos'); v = ss.sosfiltfilt(sos, tr - np.median(tr))
    env = np.abs(ss.hilbert(v)); depth = float(np.median(env[len(env) // 3:]))
    sp = np.abs(np.fft.rfft(v * np.hanning(len(v)), 1 << 12)); fq = np.fft.rfftfreq(1 << 12, hop); m = (fq > 3) & (fq < 9); rate = float(fq[m][np.argmax(sp[m])])
    if depth < 3: return 0.0, 0.0, 0.0                          # under 3 cents is tracking noise, not vibrato
    k = int(np.argmax(env > 0.5 * depth)); return rate, depth * 1.0, k * hop

NB = [(150, 600), (600, 2400), (2400, 9600)]                    # the three bands the residual is written as (Hz)
def partial_t60s(x, sr, f0, ns, o):
    """T60 of each harmonic in ns from the decay of its own amplitude after the note's peak (30 ms frames, 10 ms hop, the partial's strongest bin within 1 %),
    smoothed over 5 neighbouring harmonics in the log: a plucked or short note loses its high partials first, which one decay time for all cannot say"""
    L = int(0.03 * sr); hop = int(0.01 * sr); N = 1 << 15; w = np.hanning(L); frames = []
    t0 = int(max(0, o - 0.01) * sr)
    for st in range(t0, min(len(x) - L, t0 + int(1.2 * sr)), hop): frames.append(np.abs(np.fft.rfft(x[st:st + L] * w, N)))
    if len(frames) < 6: return {n: 1.0 for n in ns}
    X = np.array(frames); F = np.fft.rfftfreq(N, 1 / sr); out = {}
    for n in ns:
        lo, hi = np.searchsorted(F, [n * f0 * 0.99, n * f0 * 1.01])
        if hi <= lo: out[n] = 1.0; continue
        db = 20 * np.log10(X[:, lo:hi].max(1) + 1e-12); pk = int(np.argmax(db)); seg = db[pk:]; ok = np.where(seg > seg[0] - 40)[0]; end = (ok[-1] + 1) if len(ok) else len(seg)
        sl = np.polyfit(np.arange(end) * hop / sr, seg[:end], 1)[0] if end >= 4 else -60 / 0.05
        out[n] = float(np.clip(-60.0 / min(sl, -0.5), 0.03, 8.0))
    lg = np.log([out[n] for n in ns]); sm = [float(np.exp(np.median(lg[max(0, i - 2):i + 3]))) for i in range(len(ns))]
    return dict(zip(ns, sm))

def noise_level(F, P, f0):
    """residual power (bins farther than 4 % from every harmonic) in three bands and in total, each in dB relative to the tone (the harmonic bins)"""
    mask = np.ones(len(F), bool)
    for n in range(1, 400):
        f = n * f0
        if f > F[-1]: break
        mask[(F > f * 0.96) & (F < f * 1.04)] = False
    band = (F > 150) & (F < 9600); tone = P[(~mask) & band].sum() + 1e-20; df = F[1] - F[0]
    out = []
    for lo, hi in NB:
        sel = mask & (F >= lo) & (F < hi); frac = max(0.3, 1 - (~mask[(F >= lo) & (F < hi)]).mean())   # the masked bins hold noise too: scale the rest up
        out.append(10 * math.log10(P[sel].sum() / frac / tone + 1e-20))
    return out

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='+'); ap.add_argument('--name', default='Sustained instrument'); ap.add_argument('--out', required=True)
    ap.add_argument('--family', choices=list(FAMILY), default='wind'); ap.add_argument('--license', default='')
    ap.add_argument('--source', default=''); ap.add_argument('--short', action='store_true', help='staccato notes: measure each note\'s decay instead of a held spectrum'); ap.add_argument('--a4', type=float, default=440.0)
    a = ap.parse_args(); keys = {}; att, vib, nz, decs = [], [], [], []
    # octave errors in file names are uniform within an instrument (every flute file is an octave low), so the octave most files need is preferred for the
    # files whose own evidence is ambiguous (a fundamental that is weak, or a period detector that lands on an overtone)
    votes = collections.Counter()
    for path in a.files:
        m = key_of(path)
        if m is None or os.path.basename(path).startswith('.'): continue
        try:
            x, sr = load(path); sg = segment(x, sr, a.short)
            if sg: F, P = spec(x, sr, sg[1], sg[2]); votes[resolve_key(F, P, m, a.a4, yin_pitch(x, sr, int(sg[0] * sr) + int(0.03 * sr)))[1]] += 1
        except Exception: pass
    prefer = votes.most_common(1)[0][0] if votes and votes.most_common(1)[0][1] * 2 > sum(votes.values()) else 0
    for path in a.files:
        m = key_of(path)
        if m is None or os.path.basename(path).startswith('.'): print('skip', path, file=sys.stderr); continue
        x, sr = load(path); sg = segment(x, sr, a.short)
        if sg is None: continue
        o, s0, s1, at, t60 = sg
        F, P = spec(x, sr, s0, s1)
        m_name = m; fy = yin_pitch(x, sr, int(o * sr) + int(0.03 * sr)); m, shift = resolve_key(F, P, m_name, a.a4, fy, prefer)
        if shift: print(f'  {os.path.basename(path)}: named {m_name}, sounds {m} ({shift:+d} octave): using what it sounds like', file=sys.stderr)
        f_nom = a.a4 * 2 ** ((m - 69) / 12); f0 = refine_f0(F, P, f_nom)
        parts = partials(F, P, f0, sr)
        if len(parts) < 2: print('no harmonics in', path, file=sys.stderr); continue
        rate, depth, delay = (0.0, 0.0, 0.0) if a.short else vibrato(x, sr, f0, s0, s1)
        if a.short: decs.append(t60)
        nb = noise_level(F, P, f0)
        lvl = 10 * math.log10(np.mean(x[int(s0 * sr):int(s1 * sr)] ** 2) + 1e-20)
        k = keys.setdefault(m, {'note': m, 'f0s': [], 'lv': [], 'parts': [], 'dec': []}); k['f0s'].append(f0); k['lv'].append(lvl); k['parts'].append(parts)
        k['dec'].append(partial_t60s(x, sr, f0, [n for n, _ in parts], o) if a.short else None)
        att.append(at); nz.append(nb)
        if depth > 0: vib.append((rate, depth, delay))
        print(f'{os.path.basename(path):34s} key {m:3d} f0 {f0:8.2f} ({1200 * math.log2(f0 / f_nom):+5.0f} c) harmonics {len(parts):2d} attack {at * 1000:5.0f} ms  vibrato {rate:.1f} Hz {depth:4.0f} c  noise {nb[0]:5.1f} {nb[1]:5.1f} {nb[2]:5.1f} dB', file=sys.stderr)
    if not keys: print('nothing measured', file=sys.stderr); return 1
    T = round(float(np.median(decs)), 3) if a.short and decs else 3000                # a staccato note's own decay; a held note does not decay
    ref = max(np.mean(k['lv']) for k in keys.values()); docs = []
    cents = [1200 * math.log2(float(np.median(k['f0s'])) / (a.a4 * 2 ** ((m - 69) / 12))) for m, k in keys.items()]; a4 = a.a4 * 2 ** (float(np.median(cents)) / 1200)   # the instrument's own pitch standard
    for m in sorted(keys):
        k = keys[m]; i = int(np.argmax(k['lv'])); f0 = float(np.median(k['f0s']))
        docs.append({'note': m, 'f0_hz': round(f0, 3), 'B': 0.0, 'level_db': round(float(np.mean(k['lv']) - ref), 1),
                     'layers': [{'velocity': 80, 'gain_db': 0.0, 'partials': [[n, l] + ([round(k['dec'][i][n], 3)] * 2 if a.short else [T, T]) + [-120] for n, l in k['parts'][i]]}]})
    fam = FAMILY[a.family]; med = lambda v, d=0.0: float(np.median(v)) if len(v) else d
    synth = {}
    if len(vib) * 2 >= len(att):                                # the instrument has a vibrato when at least half its notes do
        synth['vibrato'] = {'hz': round(med([v[0] for v in vib]), 2), 'cents': round(med([v[1] for v in vib]), 1), 'delay_s': round(med([v[2] for v in vib]), 2), 'rise_s': 0.5, 'jitter': 0.3}
    noise = []; nzm = np.median(np.array(nz), 0) if nz else [-90] * 3
    for (lo, hi), lv in zip(NB, nzm):
        if lv > -55: noise.append({'type': 'band', 'kind': 'bp', 'fc': int(math.sqrt(lo * hi)), 'q': round(math.sqrt(lo * hi) / (hi - lo) * 1.2, 2), 'poles': 2, 'level_db': round(float(min(lv, -6)), 1), 'sustain': 0 if a.short else 1, **({'decay_s': T} if a.short else {}), 'attack_s': round(max(0.02, med(att) * 0.6), 3)})
    if noise: synth['noise'] = noise
    if fam['mono']: synth['mono'] = True
    doc = {'format': 'resonance-instrument/1', 'name': a.name, 'author': 'Resonance sustained-instrument analyzer', 'license': a.license, 'source': a.source or f'measured from {len(a.files)} recordings',
           'a4_hz': round(a4, 2), 'keys': docs,
           'engine': {'knock': 0, 'sympathetic': False, 'key_noise': False, 'quadratic': 0, 'dampers': 'all', 'release_s': 0.05 if a.short else fam['release_s'], 'attack_s': round(med(att, 0.05), 3), 'synth': synth,
                      'params': {'stretch': 0, 'globalRes': 0.35, 'keyNoise': 0}}}
    json.dump(doc, open(a.out, 'w'), indent=1); print(f'wrote {a.out}: {len(docs)} keys, attack {doc["engine"]["attack_s"] * 1000:.0f} ms, vibrato {synth.get("vibrato")}, noise {[n["level_db"] for n in noise]}', file=sys.stderr)

if __name__ == '__main__': sys.exit(main())
