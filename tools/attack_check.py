#!/usr/bin/env python3
"""Attack-rise check: median envelope (dB re the note peak) in the first 160 ms, engine vs the Iowa recordings, keys 40-84 at pp/mf/ff.
    HN=0.8 python3 tools/attack_check.py RECORDINGS_DIR [instrument.json]
RECORDINGS_DIR holds the Iowa piano files (Piano.pp.*.aiff, Piano.mf.*.aiff, Piano.ff.*.aiff)."""
import sys, os, json, subprocess, tempfile, glob, importlib.util
import numpy as np, soundfile as sf, scipy.signal as ss
if len(sys.argv)<2: sys.exit(__doc__)
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); REC=sys.argv[1]; SR=48000
spec=importlib.util.spec_from_file_location('ai',ROOT+'/tools/analyze_instrument.py'); ai=importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
inst=sys.argv[2] if len(sys.argv)>2 and sys.argv[2] else ROOT+'/data/measured/iowa_grand.json'
DYN={'pp':32,'mf':72,'ff':104}; steps=[(0,.005),(.005,.01),(.01,.02),(.02,.04),(.04,.08),(.08,.16)]
def env(x):
    o=ai.onset(x,SR); x=x[max(0,o-int(.004*SR)):]; pk=max(np.sqrt(np.mean(x[int(t*SR):int((t+.05)*SR)]**2)) for t in np.arange(0,.4,.01))
    return np.array([20*np.log10(np.sqrt(np.mean(x[int(a*SR):int(b*SR)]**2))/pk+1e-9) for a,b in steps])
jobs=[];ref={}
for d,v in DYN.items():
    for f in glob.glob(f'{REC}/Piano.{d}.*.aiff'):
        m,_=ai.parse_name(f)
        if not 40<=m<=84: continue
        x,sr=sf.read(f); x=x.mean(1) if x.ndim>1 else x
        if sr!=SR: x=ss.resample_poly(x,SR,sr)
        if np.abs(x).max()<1e-4: continue
        ref[(m,d)]=env(x[:SR]); jobs.append(dict(note=m,vel=v,secs=1.0,params={"hammerNoise":float(os.environ.get("HN","0.8")),"globalRes":1,"sympRes":1,"keyNoise":0},d=d))
with tempfile.TemporaryDirectory() as t:
    json.dump(jobs,open(t+'/j.json','w')); subprocess.run(['node',ROOT+'/test/render_batch.mjs',inst,t+'/j.json',t+'/o.f32'],check=True); y=np.fromfile(t+'/o.f32','f4').astype(float)
N=int(np.ceil(SR/128)*128); p=0; res={d:[] for d in DYN}; R={d:[] for d in DYN}; O={d:[] for d in DYN}
for j in jobs:
    o=env(y[p:p+N]); p+=N; res[j['d']].append(o-ref[(j['note'],j['d'])]); R[j['d']].append(ref[(j['note'],j['d'])]); O[j['d']].append(o)
print('windows',steps)
for d in DYN: print(d,'ref',np.round(np.median(R[d],0),1).tolist(),'ours',np.round(np.median(O[d],0),1).tolist())
