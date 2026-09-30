import { synthDefault } from './synth.js';
import { PARAMS, ENUMS, ROOMS, CC_BOOL, VEL_PRESETS, EQ_DEFAULT, PRESETS, VOICINGS, RANDOM_GROUPS, defaults, noteName } from './params.js';
import { parseMidi, writeMidi, encodeWav } from './midifile.js';
import { compile as compileInstrument, store as instStore, validate as validateInstrument, inertParams } from './instrument.js';
import { initStudio, openGenerator, openImportAudio } from './studio.js';
import { analyzeNote } from './analyzer.js';
import { initPad } from './pad.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const PDEF = Object.fromEntries(PARAMS.map(d => [d.id, d]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('resonance.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('resonance.' + k, JSON.stringify(v)); } catch { } },
};

// ======================= state =======================
let p = defaults();
let presetIdx = 0, dirty = false;
const padState = { x: 0, y: 0, center: 'Concert Grand', poles: ['Glass', 'Cathedral Bloom', 'Velvet', 'Tack Upright'] };
let padCtl = null;
let userPresets = store.get('userPresets', []);
const undoStack = [], redoStack = [];
const defaultCC = {}; for (const d of PARAMS) if (d.cc) defaultCC[d.cc] = d.id;
let ccMap = Object.assign({}, defaultCC, store.get('ccMap', {}));
let learning = null;
const pedals = { sustain: 0, soft: 0, sostenuto: 0, harmonic: 0 };
const keysDown = new Set(), silentKeys = new Set();

function allPresets() { return [...PRESETS, ...userPresets.map(u => ({ ...u, group: 'User' }))]; }
function presetParams(pr) {
  const base = defaults(), o = JSON.parse(JSON.stringify(pr.p));
  if (o.room && !('duration' in o)) Object.assign(base, ROOMS[o.room]);
  return Object.assign(base, o);
}

// ======================= audio =======================
let ctx = null, g = null, starting = null;
const pending = [];

function curveVal(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [a, b] = pts[i - 1], [c, d] = pts[i]; return b + (d - b) * (x - a) / (c - a || 1); }
  return pts[pts.length - 1][1];
}

function makeIR(ac, prm) {
  const sr = ac.sampleRate, dur = prm.duration, size = prm.roomSize;
  const persp = { player: 0.6, orchestra: 1, audience: 1.6 }[prm.perspective] || 1;
  const pre = (0.004 + 0.028 * size) * persp;
  const len = Math.ceil((pre + dur * 1.25 + 0.05) * sr);
  const buf = ac.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let s = 12345 + ch * 777, y = 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2147483648 - 1; };
    const build = 0.008 + 0.05 * size;
    for (let i = 0; i < len; i++) {
      const t = i / sr - pre;
      if (t < 0) continue;
      const env = Math.exp(-6.9 * t / dur) * Math.min(1, t / build);
      const damp = 0.15 + 0.8 * Math.min(1, t / dur) * (persp > 1 ? 1 : 0.85);
      y += (1 - damp) * (rnd() - y);
      d[i] = y * env;
    }
    // early reflections
    const er = 7;
    for (let k = 0; k < er; k++) {
      const t = pre + (0.003 + (k + 1) * (0.006 + 0.012 * size)) * (1 + 0.13 * ((k * 7 + ch * 3) % 5));
      const i = Math.floor(t * sr); if (i < len) d[i] += (k % 2 ? -1 : 1) * 0.55 * Math.pow(0.8, k);
    }
    let e = 0; for (let i = 0; i < len; i++) e += d[i] * d[i];
    const n = 1 / Math.sqrt(e / 1.2 + 1e-12); for (let i = 0; i < len; i++) d[i] *= n;
  }
  return buf;
}

// AudioWorklet only exists in secure contexts (HTTPS / localhost). On plain http://<ip> we run the
// very same processor code on the main thread behind a ScriptProcessorNode.
let engineSrc = null;
async function mainThreadProcessor(ac, name, options) {
  engineSrc ||= await (await fetch('js/engine.worklet.js?v=' + (window.__v || 1))).text();
  const scope = { sampleRate: ac.sampleRate, currentFrame: 0, currentTime: 0 };
  const classes = {};
  class Shim {
    constructor() {
      const nodePort = { onmessage: null, postMessage: d => this.port.onmessage?.({ data: d }) };
      this.port = { onmessage: null, postMessage: d => nodePort.onmessage?.({ data: d }) };
      this.__nodePort = nodePort;
    }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'scope', 'with (scope) {' + engineSrc + '\n}')(Shim, (n, c) => { classes[n] = c; }, scope);
  const proc = new classes[name](options);
  return { proc, scope, port: proc.__nodePort };
}
const instCache = {};
async function loadInst(name) {
  if (!name) return null;
  if (!instCache[name]) instCache[name] = (async () => {
    try {
      let doc = null;
      if (name.startsWith('builtin:')) doc = await (await fetch('data/measured/' + name.slice(8) + '.json')).json();
      else if (name.startsWith('synth:')) doc = synthDefault(name.slice(6));
      else if (name.startsWith('user:')) doc = (await instStore.get(name.slice(5)))?.doc;
      return doc ? compileInstrument(doc) : null;
    } catch (e) { console.error('instrument', name, e); toast('Could not load instrument: ' + e.message); return null; }
  })();
  return instCache[name];
}
async function engineNode(ac, opts) {
  const options = { processorOptions: { params: engineParams(), inst: await loadInst(p.model), ...opts } };
  if (ac.audioWorklet) {
    await ac.audioWorklet.addModule('js/engine.worklet.js?v=' + (window.__v || 1));
    return new AudioWorkletNode(ac, 'piano-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], ...options });
  }
  const { proc, scope, port } = await mainThreadProcessor(ac, 'piano-engine', options);
  const spn = ac.createScriptProcessor(1024, 0, 2);
  const bl = new Float32Array(128), br = new Float32Array(128), outs = [[bl, br]];
  spn.onaudioprocess = e => {
    const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
    scope.currentFrame = Math.round(e.playbackTime * ac.sampleRate);
    for (let o = 0; o < L.length; o += 128) {
      scope.currentTime = scope.currentFrame / ac.sampleRate;
      proc.process([], outs);
      L.set(bl, o); R.set(br, o);
      scope.currentFrame += 128;
    }
  };
  spn.port = port;
  return spn;
}
function recorderNode(ac) {
  if (ac.audioWorklet) return new AudioWorkletNode(ac, 'wav-recorder', { numberOfOutputs: 0 });
  const spn = ac.createScriptProcessor(4096, 2, 2);
  const sink = ac.createGain(); sink.gain.value = 0; spn.connect(sink); sink.connect(ac.destination);
  let on = false;
  spn.port = { onmessage: null, postMessage: d => { on = d === 'start'; if (!on) spn.port.onmessage?.({ data: 'done' }); } };
  spn.onaudioprocess = e => { if (on) spn.port.onmessage?.({ data: [e.inputBuffer.getChannelData(0).slice(), e.inputBuffer.getChannelData(1).slice()] }); };
  return spn;
}

async function buildGraph(ac, opts = {}) {
  const node = await engineNode(ac, opts);
  const lid = ac.createBiquadFilter(); lid.type = 'highshelf'; lid.frequency.value = 2500;
  const lidLp = ac.createBiquadFilter(); lidLp.type = 'lowpass'; lidLp.Q.value = 0.5;
  const dry = ac.createGain(), wet = ac.createGain(), conv = ac.createConvolver();
  const master = ac.createGain(); master.gain.value = 0.7;   // headroom: the compressor is a soft safety, not a brickwall
  const lim = ac.createDynamicsCompressor();
  lim.threshold.value = -2; lim.knee.value = 1; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  // microphone position: close = proximity boost in the low end + presence, far = air absorption of the highs
  const micLow = ac.createBiquadFilter(); micLow.type = 'lowshelf'; micLow.frequency.value = 180;
  const micHigh = ac.createBiquadFilter(); micHigh.type = 'highshelf'; micHigh.frequency.value = 5000;
  node.connect(lid); lid.connect(lidLp); lidLp.connect(micLow); micLow.connect(micHigh); micHigh.connect(dry); micHigh.connect(conv); conv.connect(wet);
  dry.connect(master); wet.connect(master); master.connect(lim);
  const G = { ac, node, lid, lidLp, micLow, micHigh, dry, wet, conv, master, lim, irKey: '' };
  applyMix(G, true);
  return G;
}

function engineParams() {
  const o = {};
  for (const d of PARAMS) o[d.id] = p[d.id];
  Object.assign(o, { model: p.model, temperament: p.temperament, mode: p.mode, profile: p.profile, damperNoise: p.damperNoise, fullSympa: p.fullSympa, vel: p.vel, eq: p.eq });
  return o;
}

function applyMix(G, now) {
  const t = G.ac.currentTime;
  const lidDb = { open: 0, semi: -4.5, closed: -11 }[p.lid];
  G.lid.gain.setTargetAtTime(lidDb, t, 0.03);
  G.lidLp.frequency.setTargetAtTime(p.lid === 'closed' ? 5500 : p.lid === 'semi' ? 11000 : 20000, t, 0.03);
  const mic = { player: [3, 1.5], orchestra: [0, 0], audience: [-1.5, -4.5] }[p.perspective] || [0, 0];   // dB: [low shelf, high shelf]
  G.micLow.gain.setTargetAtTime(mic[0], t, 0.03); G.micHigh.gain.setTargetAtTime(mic[1], t, 0.03);
  const persp = { player: [1, 0.7], orchestra: [0.9, 1], audience: [0.75, 1.25] }[p.perspective];
  const on = p.reverbOn;
  G.dry.gain.setTargetAtTime(on ? persp[0] * (1 - 0.45 * p.wet) : 1, t, 0.03);
  G.wet.gain.setTargetAtTime(on ? persp[1] * p.wet * 0.9 : 0, t, 0.03);
  const key = [p.duration.toFixed(2), p.roomSize.toFixed(2), p.perspective].join();
  if (key !== G.irKey) {
    G.irKey = key;
    clearTimeout(G.irTimer);
    const run = () => { G.conv.buffer = makeIR(G.ac, p); };
    if (now) run(); else G.irTimer = setTimeout(run, 120);
  }
}

async function startAudio() {
  if (ctx) { if (ctx.state !== 'running') await ctx.resume(); return; }
  if (starting) return starting;
  starting = (async () => {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    try { await ctx.resume(); } catch { }
    g = await buildGraph(ctx);
    g.analyser = ctx.createAnalyser(); g.analyser.fftSize = 8192; g.analyser.smoothingTimeConstant = 0.72;
    g.lim.connect(g.analyser); g.lim.connect(ctx.destination);
    g.rec = recorderNode(ctx);
    g.lim.connect(g.rec);
    g.rec.port.onmessage = onRecChunk;
    g.node.port.onmessage = e => onEngine(e.data);
    await ctx.resume();
    $('#stRate').textContent = (ctx.sampleRate / 1000).toFixed(1) + 'k';
    if (!ctx.audioWorklet) toast('Plain-HTTP page: engine runs on the main thread. For lowest latency and MIDI use https://…:9041 or localhost');
    $('#powerBtn').classList.add('on'); $('#powerLbl').textContent = 'Audio on';
    sentInst = p.model;
    for (const ev of pending.splice(0)) g.node.port.postMessage(ev);
    for (const [k, v] of Object.entries(pedals)) if (v) send({ type: 'pedal', which: k, value: v });
    for (const m of silentKeys) send({ type: 'on', note: m, vel: 0, silent: true });
  })();
  starting.catch(err => { console.error(err); toast('Audio failed to start: ' + err.message); ctx = null; starting = null; });
  return starting;
}

let sentInst = null;
async function syncInst() {
  if (!g || sentInst === p.model) return;
  const want = p.model; sentInst = want;
  const data = await loadInst(want);
  if (g && p.model === want) g.node.port.postMessage({ type: 'inst', data });
}
function send(ev) { if (g) g.node.port.postMessage(ev); else pending.push(ev); }
let paramsQueued = false;
function pushParams() {
  if (paramsQueued) return; paramsQueued = true;
  requestAnimationFrame(() => { paramsQueued = false; if (g) { g.node.port.postMessage({ type: 'params', p: engineParams() }); applyMix(g); syncInst(); } });
}

// ======================= notes =======================
let midiRecording = [], midiRecStart = performance.now();
function noteOn(m, vel, src) {
  if (m < 21 || m > 108) return;
  if (!ctx) startAudio();
  silentKeys.delete(m);
  keysDown.add(m);
  send({ type: 'on', note: m, vel });
  logMidi({ type: 'on', note: m, vel });
  setKey(m, true);
}
function noteOff(m, vel = 64) {
  if (m < 21 || m > 108) return;
  keysDown.delete(m);
  send({ type: 'off', note: m, vel });
  logMidi({ type: 'off', note: m, vel });
  setKey(m, silentKeys.has(m));
}
function toggleSilent(m) {
  if (silentKeys.has(m)) { silentKeys.delete(m); send({ type: 'off', note: m, vel: 0 }); keyEls[m]?.classList.remove('silent'); setKey(m, keysDown.has(m)); }
  else { silentKeys.add(m); if (!ctx) startAudio(); send({ type: 'on', note: m, vel: 0, silent: true }); keyEls[m]?.classList.add('silent'); setKey(m, true); toast(noteName(m) + ' held silently — its strings are now free to resonate'); }
}
function setPedal(which, value, fromUI) {
  value = clamp(value, 0, 1);
  if (pedals[which] === value) return;
  pedals[which] = value;
  send({ type: 'pedal', which, value });
  const cc = { sustain: 64, sostenuto: 66, soft: 67, harmonic: 69 }[which];
  logMidi({ type: 'cc', cc, value: Math.round(value * 127) });
  drawPedals();
}
function logMidi(e) { midiRecording.push({ ...e, time: (performance.now() - midiRecStart) / 1000 }); if (midiRecording.length > 200000) midiRecording.shift(); }

// ======================= engine feedback =======================
let levels = new Array(128).fill(0), lastInfo = null;
function onEngine(d) {
  if (d.type !== 'meter') return;
  levels = d.levels;
  $('#stVoices').textContent = d.voices;
  $('#stRes').textContent = d.res;
  const cpu = Math.round(d.cpu * 100);
  const cEl = $('#stCpu'); cEl.textContent = cpu + '%'; cEl.style.color = cpu > 80 ? 'var(--red)' : cpu > 55 ? '#e8c547' : '';
  const db = x => clamp((20 * Math.log10(x + 1e-9) + 48) / 48, 0, 1);
  $('#mL').style.height = db(d.peakL) * 100 + '%'; $('#mR').style.height = db(d.peakR) * 100 + '%';
  if (d.info) showInfo(d.info);
}
function showInfo(i) {
  lastInfo = { ...i, at: performance.now() };
  const et = p.diapason * Math.pow(2, (i.note - 69) / 12);
  const cents = 1200 * Math.log2(i.f1 / et);
  $('#nowNote').textContent = noteName(i.note);
  $('#nowMeta').textContent = `${i.f1.toFixed(2)} Hz  ${cents >= 0 ? '+' : ''}${cents.toFixed(1)}¢  ·  vel ${i.vel}  ·  ${i.strings} string${i.strings > 1 ? 's' : ''} × ${i.partials} partials  ·  B ${i.B.toExponential(2)}  ·  hardness ${i.hard.toFixed(2)}`;
}

// ======================= spectrum display =======================
const spec = $('#spectrum'), sctx = spec.getContext('2d');
let fbuf = null;
function drawSpectrum() {
  requestAnimationFrame(drawSpectrum);
  const dpr = devicePixelRatio || 1, W = spec.clientWidth - 18, H = spec.clientHeight;
  if (spec.width !== Math.round((W + 18) * dpr) || spec.height !== Math.round(H * dpr)) { spec.width = Math.round((W + 18) * dpr); spec.height = Math.round(H * dpr); }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, W + 18, H);
  const fx = f => Math.log(f / 20) / Math.log(20000 / 20) * W;
  const dy = db => H - 4 - (db + 100) / 100 * (H - 14);
  sctx.font = '9.5px JetBrains Mono, monospace'; sctx.fillStyle = '#4a4a52'; sctx.strokeStyle = '#1b1d21'; sctx.lineWidth = 1;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(fx(f)) + 0.5; sctx.beginPath(); sctx.moveTo(x, 0); sctx.lineTo(x, H); sctx.stroke();
    sctx.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, H - 4);
  }
  for (const db of [-20, -40, -60, -80]) { const y = Math.round(dy(db)) + 0.5; sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(W, y); sctx.stroke(); }
  // partial markers of the last struck note
  if (lastInfo) {
    const age = (performance.now() - lastInfo.at) / 1000, a = Math.max(0, 1 - age / 6);
    if (a > 0) {
      const amax = Math.max(...lastInfo.amps);
      sctx.strokeStyle = `rgba(127,179,255,${0.55 * a})`;
      lastInfo.freqs.forEach((f, k) => {
        const x = fx(f), h = clamp((20 * Math.log10(lastInfo.amps[k] / amax + 1e-9) + 60) / 60, 0.05, 1);
        sctx.beginPath(); sctx.moveTo(x, H - 16); sctx.lineTo(x, H - 16 - h * 22); sctx.stroke();
      });
    }
  }
  if (!g || !g.analyser) return;
  const an = g.analyser, n = an.frequencyBinCount;
  if (!fbuf || fbuf.length !== n) fbuf = new Float32Array(n);
  an.getFloatFrequencyData(fbuf);
  const sr = ctx.sampleRate, grad = sctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(227,201,143,.45)'); grad.addColorStop(1, 'rgba(227,201,143,0)');
  sctx.beginPath(); sctx.moveTo(0, H);
  let lastX = -1, acc = -200;
  for (let i = 1; i < n; i++) {
    const f = i * sr / an.fftSize; if (f < 20) continue; if (f > 20000) break;
    const x = fx(f); acc = Math.max(acc, fbuf[i]);
    if (x - lastX >= 1) { sctx.lineTo(x, dy(clamp(acc, -100, 0))); lastX = x; acc = -200; }
  }
  sctx.lineTo(W, H); sctx.closePath(); sctx.fillStyle = grad; sctx.fill();
  sctx.strokeStyle = '#e3c98f'; sctx.lineWidth = 1.2; sctx.stroke();
}

// ======================= sliders =======================
const sliders = {};
const toNorm = (d, v) => d.log ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min);
const fromNorm = (d, t) => { t = clamp(t, 0, 1); let v = d.log ? d.min * Math.pow(d.max / d.min, t) : d.min + t * (d.max - d.min); if (d.step) v = Math.round(v / d.step) * d.step; return v; };
const fmtVal = (d, v) => d.fmt(v) + (d.unit ? ' ' + d.unit : '');

const ccName = cc => cc === 128 ? 'AT' : 'CC' + cc;        // 128 = channel / polyphonic aftertouch (pressure), usable with MIDI learn
function ccOf(id) { for (const [cc, pid] of Object.entries(ccMap)) if (pid === id) return +cc; return null; }

function makeSlider(d) {
  const el = document.createElement('div');
  el.className = 'sl';
  el.innerHTML = `<div class="sl-label"><span>${d.label}</span><em class="sl-cc"></em></div><div class="sl-val"></div>
    <div class="sl-track"><div class="sl-def"></div><div class="sl-fill"></div><div class="sl-knob"></div></div>`;
  const track = el.querySelector('.sl-track'), val = el.querySelector('.sl-val');
  el.querySelector('.sl-def').style.left = toNorm(d, d.def) * 100 + '%';
  track.tabIndex = 0; track.setAttribute('role', 'slider'); track.setAttribute('aria-label', d.label);
  track.setAttribute('aria-valuemin', d.min); track.setAttribute('aria-valuemax', d.max);
  let start = null;
  // keyboard: arrows nudge 1% (Shift 0.2%), Page keys 10%, Home / End go to the ends, Delete resets to the default
  track.addEventListener('keydown', e => {
    const one = d.step && !d.log ? d.step / (d.max - d.min) : e.shiftKey ? 0.002 : 0.01, t = toNorm(d, p[d.id]);
    const nt = { ArrowRight: t + one, ArrowUp: t + one, ArrowLeft: t - one, ArrowDown: t - one, PageUp: t + 0.1, PageDown: t - 0.1, Home: 0, End: 1 }[e.key];
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); beginEdit(); setParam(d.id, d.def); commit(); return; }
    if (nt == null) return;
    e.preventDefault(); e.stopPropagation(); beginEdit(); set(nt); commitSoon();
  });
  track.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    track.setPointerCapture(e.pointerId); el.classList.add('drag');
    const r = track.getBoundingClientRect();
    beginEdit();
    start = { x: e.clientX, t: toNorm(d, p[d.id]), w: r.width };
    if (!e.shiftKey) { set((e.clientX - r.left) / r.width); start.t = toNorm(d, p[d.id]); }
  });
  track.addEventListener('pointermove', e => {
    if (!start) return;
    const fine = e.shiftKey ? 0.1 : 1;
    set(start.t + (e.clientX - start.x) / start.w * fine);
  });
  const end = () => { if (start) { start = null; el.classList.remove('drag'); commit(); } };
  track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
  track.addEventListener('dblclick', () => { beginEdit(); setParam(d.id, d.def); commit(); });
  track.addEventListener('wheel', e => { e.preventDefault(); beginEdit(); set(toNorm(d, p[d.id]) - Math.sign(e.deltaY) * (e.shiftKey ? 0.002 : 0.01)); commitSoon(); }, { passive: false });
  el.addEventListener('contextmenu', e => { e.preventDefault(); sliderMenu(d, e.clientX, e.clientY); });
  val.addEventListener('click', () => {
    const inp = document.createElement('input'); inp.value = +p[d.id].toFixed(3);
    val.textContent = ''; val.appendChild(inp); inp.focus(); inp.select();
    const done = ok => { if (ok && !isNaN(+inp.value)) { beginEdit(); setParam(d.id, clamp(+inp.value, d.min, d.max)); commit(); } refreshSlider(d.id); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
    inp.addEventListener('blur', () => done(true));
  });
  if (d.help) { el.addEventListener('mouseenter', e => tip(d.label, inert[d.id] ? 'Not used by this instrument. ' + inert[d.id] : d.help, el)); el.addEventListener('mouseleave', () => tip()); }
  function set(t) { setParam(d.id, fromNorm(d, t)); }
  sliders[d.id] = el;
  return el;
}
function refreshSlider(id) {
  const d = PDEF[id], el = sliders[id]; if (!el) return;
  const t = toNorm(d, p[id]);
  el.querySelector('.sl-fill').style.cssText = `left:${Math.min(t, toNorm(d, d.def)) * 100}%;width:${Math.abs(t - toNorm(d, d.def)) * 100}%`;
  el.querySelector('.sl-knob').style.left = t * 100 + '%';
  const v = el.querySelector('.sl-val'); if (!v.querySelector('input')) v.textContent = fmtVal(d, p[id]);
  const tr = el.querySelector('.sl-track'); tr.setAttribute('aria-valuenow', p[id]); tr.setAttribute('aria-valuetext', fmtVal(d, p[id]));
  const cc = ccOf(id), ce = el.querySelector('.sl-cc');
  ce.textContent = learning === id ? 'learn' : cc != null ? ccName(cc) : '';
  ce.style.display = learning === id || cc != null ? '' : 'none';
  ce.className = 'sl-cc' + (learning === id ? ' learn' : cc != null && defaultCC[cc] !== id ? ' custom' : '');
  el.classList.toggle('changed', Math.abs(p[id] - d.def) > 1e-9);
  el.classList.toggle('inert', !!inert[id]);
}
function sliderMenu(d, x, y) {
  const cc = ccOf(d.id);
  const items = [
    ['MIDI learn…', () => { learning = d.id; refreshAll(); toast(`Move a controller to assign it to “${d.label}”`); }],
    cc != null ? ['Remove ' + ccName(cc), () => { delete ccMap[cc]; saveCC(); refreshAll(); }] : null,
    ['Reset to default', () => { beginEdit(); setParam(d.id, d.def); commit(); }],
    ['Restore factory CC map', () => { ccMap = { ...defaultCC }; saveCC(); refreshAll(); }],
  ].filter(Boolean);
  ctxMenu(items, x, y);
}
function saveCC() { const diff = {}; for (const [k, v] of Object.entries(ccMap)) if (defaultCC[k] !== v) diff[k] = v; for (const k in defaultCC) if (!(k in ccMap)) diff[k] = null; store.set('ccMap', diff); }

function setParam(id, v) {
  p[id] = v;
  if (PDEF[id]) refreshSlider(id);
  markDirty();
  pushParams();
}

// ======================= undo / redo =======================
let editSnap = null, commitTimer = 0;
function beginEdit() { if (!editSnap) editSnap = JSON.stringify(p); }
function commit() {
  clearTimeout(commitTimer);
  if (!editSnap) return;
  if (editSnap !== JSON.stringify(p)) { undoStack.push(editSnap); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
  editSnap = null; updateUndo(); persist();
}
function commitSoon() { clearTimeout(commitTimer); commitTimer = setTimeout(commit, 400); }
function undo() { commit(); if (!undoStack.length) return; redoStack.push(JSON.stringify(p)); p = JSON.parse(undoStack.pop()); afterLoad(); markDirty(); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(p)); p = JSON.parse(redoStack.pop()); afterLoad(); markDirty(); }
function updateUndo() { $('#undoBtn').disabled = !undoStack.length; $('#redoBtn').disabled = !redoStack.length; }
function persist() { store.set('state', { p, presetIdx, dirty, presetName: allPresets()[presetIdx]?.name }); }

// ======================= presets =======================
function fillPresetMenu() { }          // the preset dropdown is gone; presets still feed the variation pad, MIDI program change and File > Import
function loadPreset(i, keepLower = false) {
  const list = allPresets(); i = (i + list.length) % list.length;
  beginEdit();
  const lower = keepLower ? lowerPanel() : null;
  p = presetParams(list[i]);
  if (lower) Object.assign(p, lower);
  presetIdx = i; dirty = false;
  afterLoad(); commit();
  persist();
}
function lowerPanel() { const o = {}; for (const d of PARAMS) if (['output', 'reverb', 'options'].includes(d.group)) o[d.id] = p[d.id]; for (const k of ['eq', 'vel', 'mode', 'lid', 'perspective', 'room', 'reverbOn']) o[k] = p[k]; return JSON.parse(JSON.stringify(o)); }
function markDirty() { dirty = true; }
function afterLoad() { refreshAll(); pushParams(); updateUndo(); }

function randomise() {
  beginEdit();
  for (const d of PARAMS) if (RANDOM_GROUPS.includes(d.group)) {
    // stay near musical territory: gaussian around default in normalized space
    const t = clamp(toNorm(d, d.def) + (Math.random() + Math.random() + Math.random() - 1.5) * 0.45, 0, 1);
    p[d.id] = fromNorm(d, t);
  }
  p.profile = p.profile.map(() => Math.round((Math.random() - 0.5) * 12));
  if (Math.random() < 0.3) p.temperament = ENUMS.temperament.options[Math.floor(Math.random() * 6)][0];
  afterLoad(); markDirty(); commit();
}

// ======================= enums, profile, pedals =======================
function makeSeg(id) {
  const el = $('#' + id); el.innerHTML = '';
  for (const [v, l] of ENUMS[id].options) {
    const b = document.createElement('button'); b.textContent = l; b.dataset.v = v;
    b.onclick = () => { beginEdit(); p[id] = v; markDirty(); pushParams(); refreshAll(); commit(); };
    el.appendChild(b);
  }
}
function makeSelect(id) {
  const el = $('#' + id);
  el.innerHTML = ENUMS[id].options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  el.onchange = async () => {
    beginEdit(); const prev = p[id]; p[id] = el.value;
    if (id === 'model') await adoptInstrument(prev, p.model);
    if (id === 'room') Object.assign(p, ROOMS[el.value]);
    markDirty(); pushParams(); refreshAll(); commit();
  };
}
function makeProfile() {
  const el = $('#profile'); el.innerHTML = '';
  p.profile.forEach((_, k) => {
    const b = document.createElement('div'); b.className = 'pbar';
    b.innerHTML = `<i></i><span></span><b>${k + 1}</b>`;
    let drag = false;
    const set = e => { const r = b.getBoundingClientRect(); const v = Math.round(clamp((0.5 - (e.clientY - r.top) / r.height) * 30, -15, 15)); if (p.profile[k] !== v) { p.profile[k] = v; markDirty(); pushParams(); refreshProfile(); } };
    b.addEventListener('pointerdown', e => { drag = true; b.setPointerCapture(e.pointerId); beginEdit(); set(e); });
    b.addEventListener('pointermove', e => drag && set(e));
    b.addEventListener('pointerup', () => { drag = false; commit(); });
    b.addEventListener('dblclick', () => { beginEdit(); p.profile[k] = 0; pushParams(); refreshProfile(); commit(); });
    b.addEventListener('mouseenter', () => tip(`Overtone ${k + 1}`, k === 0 ? 'The fundamental. Raise it for a rounder, softer tone.' : k === 6 ? 'Makers are said to avoid a strong 7th overtone.' : 'Drag up/down (±15 dB). Double-click to reset.', b));
    b.addEventListener('mouseleave', () => tip());
    el.appendChild(b);
  });
}
function refreshProfile() {
  $$('#profile .pbar').forEach((b, k) => {
    const v = p.profile[k], i = b.querySelector('i'), h = Math.abs(v) / 30 * 100;
    i.className = v < 0 ? 'neg' : '';
    i.style.cssText = v >= 0 ? `bottom:50%;height:${h}%` : `top:50%;height:${h}%`;
    b.querySelector('span').textContent = v ? (v > 0 ? '+' : '') + v : '';
  });
}
function drawPedals() {
  for (const el of $$('.pedal')) {
    const v = pedals[el.dataset.pedal];
    el.style.setProperty('--p', v);
    el.classList.toggle('active', v > 0.02);
    el.setAttribute('aria-pressed', v > 0.5);
  }
}
function setupPedals() {
  for (const el of $$('.pedal')) {
    const which = el.dataset.pedal;
    el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', el.querySelector('span').textContent + ' pedal');
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (!ctx) startAudio(); setPedal(which, pedals[which] > 0.5 ? 0 : 1, true); } });
    let y0 = null, moved = false;
    el.addEventListener('pointerdown', e => {
      if (!ctx) startAudio();
      y0 = e.clientY; moved = false; el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (y0 == null || which !== 'sustain' && which !== 'soft') return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > 4) { moved = true; setPedal(which, clamp(dy / 50, 0, 1), true); }
    });
    el.addEventListener('pointerup', () => {
      if (!moved) setPedal(which, pedals[which] > 0.5 ? 0 : 1, true);
      y0 = null;
    });
  }
}

// Give every control without visible text an accessible name: icon buttons from their title, selects from the label next to them.
function a11yPass() {
  for (const b of $$('button')) if (!b.textContent.trim() && !b.getAttribute('aria-label') && b.title) b.setAttribute('aria-label', b.title);
  for (const s of $$('select')) {
    if (s.getAttribute('aria-label') || s.labels?.length) continue;
    const l = s.closest('.field')?.querySelector('label') || s.closest('.card')?.querySelector('.card-title');
    s.setAttribute('aria-label', s.title || l?.textContent.trim() || s.id);
  }
  for (const c of $$('canvas')) if (!c.getAttribute('aria-label')) c.setAttribute('role', 'img'), c.setAttribute('aria-label', c.id === 'spectrum' ? 'Live spectrum' : c.id);
}

// ======================= curve editors (EQ, velocity) =======================
function curveEditor(canvas, cfg) {
  const c2 = canvas.getContext('2d');
  let drag = -1;
  const pts = () => cfg.get();
  const size = () => { const r = canvas.getBoundingClientRect(); return { w: r.width, h: r.height, r }; };
  const toPx = ([x, y], w, h) => [cfg.xn(x) * (w - 20) + 10, (1 - cfg.yn(y)) * (h - 20) + 10];
  const fromPx = (px, py, w, h) => [cfg.xv((px - 10) / (w - 20)), cfg.yv(1 - (py - 10) / (h - 20))];
  function draw() {
    const { w, h } = size(), dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    c2.setTransform(dpr, 0, 0, dpr, 0, 0); c2.clearRect(0, 0, w, h);
    c2.strokeStyle = '#1c1e22'; c2.lineWidth = 1; c2.font = '9.5px JetBrains Mono'; c2.fillStyle = '#4a4a52';
    for (const [gx, lbl] of cfg.gridX) { const x = Math.round(cfg.xn(gx) * (w - 20) + 10) + .5; c2.beginPath(); c2.moveTo(x, 6); c2.lineTo(x, h - 6); c2.stroke(); c2.fillText(lbl, x + 3, h - 8); }
    for (const [gy, lbl] of cfg.gridY) { const y = Math.round((1 - cfg.yn(gy)) * (h - 20) + 10) + .5; c2.strokeStyle = gy === 0 && cfg.zeroLine ? '#34343c' : '#1c1e22'; c2.beginPath(); c2.moveTo(6, y); c2.lineTo(w - 6, y); c2.stroke(); c2.fillText(lbl, 12, y - 3); }
    const P = pts().map(q => toPx(q, w, h));
    const base = cfg.zeroLine ? (1 - cfg.yn(0)) * (h - 20) + 10 : h - 10;
    const grad = c2.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, 'rgba(201,168,106,.28)'); grad.addColorStop(1, 'rgba(201,168,106,.02)');
    c2.beginPath(); c2.moveTo(10, P[0][1]); P.forEach(q => c2.lineTo(q[0], q[1])); c2.lineTo(w - 10, P[P.length - 1][1]);
    c2.strokeStyle = '#e3c98f'; c2.lineWidth = 1.8; c2.stroke();
    c2.lineTo(w - 10, base); c2.lineTo(10, base); c2.closePath(); c2.fillStyle = grad; c2.fill();
    P.forEach((q, i) => { c2.beginPath(); c2.arc(q[0], q[1], i === drag ? 7 : 5.5, 0, 7); c2.fillStyle = '#16130c'; c2.fill(); c2.strokeStyle = '#e3c98f'; c2.lineWidth = 2; c2.stroke(); });
  }
  // Grab radius in px: generous, and larger for a finger than for a mouse.
  const reach = e => (e.pointerType === 'touch' ? 24 : e.pointerType === 'pen' ? 16 : 13);
  function hit(e) {
    const { w, h, r } = size(); const x = e.clientX - r.left, y = e.clientY - r.top, lim = reach(e);
    let best = -1, bd = lim;                                    // the nearest point within reach wins
    pts().forEach((q, i) => { const [px, py] = toPx(q, w, h), d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  // A point on the curve under the pointer (within reach of the line), or null: dragging from the line adds a point there.
  function onLine(e) {
    const { w, h, r } = size(); const x = e.clientX - r.left, y = e.clientY - r.top, P = pts().map(q => toPx(q, w, h));
    for (let i = 0; i + 1 < P.length; i++) {
      const [x0, y0] = P[i], [x1, y1] = P[i + 1];
      if (x < x0 || x > x1 || x1 - x0 < 1e-6) continue;
      const ly = y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      if (Math.abs(y - ly) > reach(e) + 4) return null;
      const [vx, vy] = fromPx(x, ly, w, h); return [vx, cfg.clampY(vy)];
    }
    return null;
  }
  let pend = null;                                              // pointer went down on the line: a point is added once it moves
  canvas.addEventListener('pointerdown', e => {
    if (e.button) return;
    drag = hit(e);
    if (drag >= 0) { canvas.setPointerCapture(e.pointerId); beginEdit(); draw(); return; }
    const q = onLine(e);
    if (q) { pend = { q, x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); }
  });
  canvas.addEventListener('pointermove', e => {
    if (pend && drag < 0) {
      if (Math.hypot(e.clientX - pend.x, e.clientY - pend.y) < 3) return;
      beginEdit(); const a = pts(); a.push(pend.q); a.sort((m, n) => m[0] - n[0]); cfg.set(a); drag = a.indexOf(pend.q); pend = null;
    }
    if (drag < 0) { canvas.style.cursor = hit(e) >= 0 ? 'grab' : onLine(e) ? 'copy' : 'crosshair'; return; }
    const { w, h, r } = size(); let [x, y] = fromPx(e.clientX - r.left, e.clientY - r.top, w, h);
    const a = pts();
    const lo = drag > 0 ? a[drag - 1][0] : cfg.xv(0), hi = drag < a.length - 1 ? a[drag + 1][0] : cfg.xv(1);
    if (cfg.lockEnds && (drag === 0 || drag === a.length - 1)) x = a[drag][0];
    a[drag] = [clamp(x, lo * 1.0001, hi * 0.9999 || hi - 1e-4), cfg.clampY(y)];
    cfg.set(a); draw();
  });
  canvas.addEventListener('pointerup', () => { pend = null; if (drag >= 0) { drag = -1; commit(); draw(); } });
  canvas.addEventListener('pointercancel', () => { pend = null; if (drag >= 0) { drag = -1; commit(); draw(); } });
  canvas.addEventListener('dblclick', e => {
    const i = hit(e); beginEdit();
    const a = pts();
    if (i >= 0) { if (a.length > 2 && !(cfg.lockEnds && (i === 0 || i === a.length - 1))) a.splice(i, 1); }
    else { const { w, h, r } = size(); const [x, y] = fromPx(e.clientX - r.left, e.clientY - r.top, w, h); a.push([x, cfg.clampY(y)]); a.sort((m, n) => m[0] - n[0]); }
    cfg.set(a); draw(); commit();
  });
  canvas.addEventListener('contextmenu', e => { e.preventDefault(); const i = hit(e); const a = pts(); if (i >= 0 && a.length > 2 && !(cfg.lockEnds && (i === 0 || i === a.length - 1))) { beginEdit(); a.splice(i, 1); cfg.set(a); draw(); commit(); } });
  new ResizeObserver(draw).observe(canvas);
  return { draw };
}
let eqEd, velEd;
function setupCurves() {
  const lf = f => Math.log(f / 20) / Math.log(1000);
  eqEd = curveEditor($('#eqCurve'), {
    get: () => p.eq, set: a => { p.eq = a; markDirty(); pushParams(); },
    xn: lf, xv: t => 20 * Math.pow(1000, clamp(t, 0, 1)), yn: db => (db + 15) / 30, yv: t => t * 30 - 15, clampY: y => Math.round(clamp(y, -15, 15) * 2) / 2,
    gridX: [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']],
    gridY: [[10, '+10'], [0, '0 dB'], [-10, '-10']], zeroLine: true,
  });
  velEd = curveEditor($('#velCurve'), {
    get: () => p.vel, set: a => { p.vel = a; markDirty(); pushParams(); $('#velPreset').value = ''; },
    xn: x => x, xv: t => clamp(t, 0, 1), yn: y => y, yv: t => t, clampY: y => clamp(y, 0, 1), lockEnds: true,
    gridX: [[0.25, '32'], [0.5, '64'], [0.75, '96']], gridY: [[0.25, ''], [0.5, ''], [0.75, '']],
  });
  const vp = $('#velPreset');
  vp.innerHTML = '<option value="">Custom</option>' + Object.keys(VEL_PRESETS).map(k => `<option>${k}</option>`).join('');
  vp.onchange = () => { if (!vp.value) return; beginEdit(); p.vel = VEL_PRESETS[vp.value].map(a => a.slice()); markDirty(); pushParams(); velEd.draw(); commit(); vp.value = vp.value; };
  $('#eqReset').onclick = () => { beginEdit(); p.eq = EQ_DEFAULT.map(a => a.slice()); markDirty(); pushParams(); eqEd.draw(); commit(); };
}
function velPresetName() { const s = JSON.stringify(p.vel); return Object.keys(VEL_PRESETS).find(k => JSON.stringify(VEL_PRESETS[k]) === s) || ''; }

// Sliders that cannot act on the selected instrument (js/instrument.js inertParams) are greyed, with the reason in their tooltip.
let inert = {}, inertFor = null;
async function refreshInert() {
  const want = p.model; if (inertFor === want) return; inertFor = want;
  const c = await loadInst(want);
  if (p.model !== want) return;
  inert = c ? inertParams(c) : {};
  for (const id in sliders) refreshSlider(id);
}
// Changing instrument is like loading a voicing: the new instrument's recommended slider values (engine.params) are applied, and
// values the previous instrument had set that the new one does not are put back to the factory default.
async function adoptInstrument(prevModel, nextModel) {
  const prev = (await loadInst(prevModel))?.eng?.params || {}, next = (await loadInst(nextModel))?.eng?.params || {};
  for (const id in prev) if (!(id in next) && PDEF[id]) p[id] = PDEF[id].def;
  for (const id in next) if (PDEF[id]) p[id] = next[id];
}
function refreshAll() {
  refreshInert();
  for (const id in sliders) refreshSlider(id);
  $('#temperament').value = p.temperament; $('#room').value = p.room; $('#model').value = p.model;
  for (const id of ['mode', 'voices', 'lid', 'perspective']) $$(`#${id} button`).forEach(b => b.classList.toggle('on', b.dataset.v === p[id]));
  $('#reverbOn').checked = p.reverbOn; $('#damperNoise').checked = p.damperNoise; $('#fullSympa').checked = p.fullSympa;
  $('.card [data-sliders=reverb]').style.opacity = p.reverbOn ? 1 : 0.45;
  refreshProfile(); eqEd?.draw(); velEd?.draw();
  if (padCtl) { padState.x = p.pad?.[0] ?? 0; padState.y = p.pad?.[1] ?? 0; padCtl.redraw(); }
  $('#velPreset').value = velPresetName();
}

// ======================= keyboard =======================
const keyEls = [];
function buildKeyboard() {
  const kb = $('#keyboard'); kb.innerHTML = '';
  const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);
  const whites = []; for (let m = 21; m <= 108; m++) if (!isBlack(m)) whites.push(m);
  const ww = 100 / whites.length;
  let wi = 0;
  for (let m = 21; m <= 108; m++) {
    const el = document.createElement('div');
    el.dataset.note = m;
    el.innerHTML = '<div class="glow"></div>';
    if (isBlack(m)) {
      el.className = 'key b';
      const off = { 1: -0.62, 3: -0.38, 6: -0.64, 8: -0.5, 10: -0.36 }[m % 12];
      el.style.left = (wi + off) * ww + '%'; el.style.width = ww * 0.62 + '%';
    } else {
      el.className = 'key w';
      el.style.left = wi * ww + '%'; el.style.width = ww + '%';
      if (m % 12 === 0) el.insertAdjacentHTML('beforeend', `<div class="lbl">C${m / 12 - 1}</div>`);
      wi++;
    }
    kb.appendChild(el); keyEls[m] = el;
  }
  const active = new Map();
  const noteAt = e => { const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('.key'); return t ? +t.dataset.note : null; };
  const velAt = (e, m) => { const r = keyEls[m].getBoundingClientRect(); return Math.round(clamp(28 + 99 * (e.clientY - r.top) / r.height, 1, 127)); };
  kb.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const m = noteAt(e); if (m == null) return;
    kb.setPointerCapture(e.pointerId);
    active.set(e.pointerId, m); noteOn(m, velAt(e, m));
  });
  kb.addEventListener('pointermove', e => {
    if (!active.has(e.pointerId)) return;
    const m = noteAt(e), cur = active.get(e.pointerId);
    if (m != null && m !== cur) { noteOff(cur); active.set(e.pointerId, m); noteOn(m, velAt(e, m)); }
  });
  const up = e => { if (active.has(e.pointerId)) { noteOff(active.get(e.pointerId)); active.delete(e.pointerId); } };
  kb.addEventListener('pointerup', up); kb.addEventListener('pointercancel', up);
  kb.addEventListener('contextmenu', e => { e.preventDefault(); const m = noteAt(e); if (m != null) toggleSilent(m); });
}
function setKey(m, down) { keyEls[m]?.classList.toggle('down', !!down); }
function animateKeys() {
  requestAnimationFrame(animateKeys);
  for (let m = 21; m <= 108; m++) {
    const el = keyEls[m]; if (!el) continue;
    const l = levels[m] || 0;
    const a = clamp((20 * Math.log10(l + 1e-9) + 70) / 55, 0, 1);
    const gl = el.firstChild;
    if (gl._a !== a) { gl.style.opacity = a.toFixed(2); gl._a = a; }
  }
}

// computer keyboard
const KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };
let octave = 4, kVel = 90;
const heldCodes = new Map();
function setupComputerKeys() {
  addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) { if (e.code === 'Space' && !e.ctrlKey) e.preventDefault(); return; }
    if (e.code === 'Space') { e.preventDefault(); if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur(); setPedal('sustain', 1); return; }
    if (e.code === 'KeyZ') { octave = Math.max(1, octave - 1); $('#octLbl').textContent = 'C' + octave; return; }
    if (e.code === 'KeyX') { octave = Math.min(7, octave + 1); $('#octLbl').textContent = 'C' + octave; return; }
    if (e.code === 'KeyC') { kVel = Math.max(10, kVel - 15); $('#velLbl').textContent = kVel; return; }
    if (e.code === 'KeyV') { kVel = Math.min(127, kVel + 15); $('#velLbl').textContent = kVel; return; }
    if (e.code in KEYMAP) { const m = 12 * (octave + 1) + KEYMAP[e.code]; heldCodes.set(e.code, m); noteOn(m, kVel); }
  });
  addEventListener('keyup', e => {
    if (e.code === 'Space') { if (!e.target.closest('input, select, textarea')) e.preventDefault(); setPedal('sustain', 0); return; }
    if (heldCodes.has(e.code)) { noteOff(heldCodes.get(e.code)); heldCodes.delete(e.code); }
  });
  addEventListener('blur', () => { for (const m of heldCodes.values()) noteOff(m); heldCodes.clear(); });
}

// ======================= Web MIDI =======================
let midiAccess = null;
async function setupMidi() {
  const sel = $('#midiIn'), ch = $('#midiCh');
  for (let i = 1; i <= 16; i++) ch.appendChild(new Option('Ch ' + i, i - 1));
  ch.value = store.get('midiCh', -1);
  ch.onchange = () => store.set('midiCh', +ch.value);
  if (!navigator.requestMIDIAccess) { sel.innerHTML = `<option>MIDI: ${isSecureContext ? 'unsupported browser' : 'needs HTTPS/localhost'}</option>`; return; }
  try { midiAccess = await navigator.requestMIDIAccess(); }
  catch { sel.innerHTML = '<option>MIDI: permission denied</option>'; return; }
  const fill = () => {
    const cur = sel.value || store.get('midiIn', '*');
    const ins = [...midiAccess.inputs.values()];
    sel.innerHTML = `<option value="*">All MIDI inputs (${ins.length})</option><option value="-">MIDI off</option>` + ins.map(i => `<option value="${i.id}">${i.name}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : '*';
    for (const i of ins) i.onmidimessage = onMidi;
  };
  sel.onchange = () => store.set('midiIn', sel.value);
  midiAccess.onstatechange = e => { fill(); if (e.port.type === 'input') toast(`${e.port.name} ${e.port.state}`); };
  fill();
}
let ledTimer = 0;
function onMidi(e) {
  const sel = $('#midiIn').value;
  if (sel === '-' || (sel !== '*' && e.currentTarget.id !== sel)) return;
  const [st, a = 0, b = 0] = e.data, hi = st & 0xf0, chn = st & 0x0f;
  const want = +$('#midiCh').value;
  if (st < 0xf0 && want >= 0 && chn !== want) return;
  const led = $('#midiLed'); led.classList.add('on'); clearTimeout(ledTimer); ledTimer = setTimeout(() => led.classList.remove('on'), 60);
  if (hi === 0x90 && b > 0) noteOn(a, b);
  else if (hi === 0x80 || (hi === 0x90 && b === 0)) noteOff(a, hi === 0x80 ? b : 64);
  else if (hi === 0xb0) handleCC(a, b);
  else if (hi === 0xe0) pitchBend(((b << 7) | a) - 8192);
  else if (hi === 0xd0) handleCC(128, a);
  else if (hi === 0xa0) handleCC(128, b);
  else if (hi === 0xc0 && $('#listenPC').checked) { if (a < allPresets().length) loadPreset(a, true); }
}
let bendQueued = false, bendSemis = 0;
function pitchBend(raw) {                                        // -8192 .. 8191; sent at most once per animation frame
  bendSemis = raw / 8192 * p.bendRange;
  if (bendQueued) return; bendQueued = true;
  requestAnimationFrame(() => { bendQueued = false; send({ type: 'bend', semis: bendSemis }); });
}
function handleCC(cc, v) {
  if (learning && ![64, 66, 67, 69, 120, 121, 123].includes(cc)) {
    for (const k of Object.keys(ccMap)) if (ccMap[k] === learning) delete ccMap[k];
    ccMap[cc] = learning; saveCC(); toast(`CC${cc} → ${PDEF[learning].label}`); learning = null; refreshAll(); return;
  }
  if (cc === 64) return setPedal('sustain', v / 127);
  if (cc === 66) return setPedal('sostenuto', v >= 64 ? 1 : 0);
  if (cc === 67) return setPedal('soft', v / 127);
  if (cc === 69) return setPedal('harmonic', v >= 64 ? 1 : 0);
  if (cc === 121) { pitchBend(0); return; }
  if (cc === 120 || cc === 123) { send({ type: 'allOff' }); keysDown.forEach(m => setKey(m, false)); keysDown.clear(); return; }
  if (CC_BOOL[cc]) { p[CC_BOOL[cc]] = v >= 64; markDirty(); pushParams(); refreshAll(); return; }
  const id = ccMap[cc];
  if (id && PDEF[id]) { setParam(id, fromNorm(PDEF[id], v / 127)); commitSoon(); }
}

// ======================= MIDI file player =======================
const song = { data: null, name: '', playing: false, pos: 0, startCtx: 0, idx: 0, timer: 0, speed: 1, notesOn: new Set() };
async function loadMidiFile(file) {
  try {
    const data = parseMidi(await file.arrayBuffer());
    if (!data.events.length) throw new Error('No note events');
    stopSong();
    song.data = data; song.name = file.name; song.pos = 0;
    $('#songName').textContent = `${file.name} · ${data.notes} notes · ${data.tracks} track${data.tracks > 1 ? 's' : ''}`;
    for (const id of ['#playBtn', '#stopBtn', '#songPos', '#exportWav']) $(id).disabled = false;
    updateSongTime();
    toast('Loaded ' + file.name);
  } catch (err) { toast('Could not read MIDI: ' + err.message); }
}
const fmtT = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function updateSongTime() {
  if (!song.data) return;
  const cur = song.playing ? (ctx.currentTime - song.startCtx) * song.speed : song.pos;
  $('#songTime').textContent = `${fmtT(cur)} / ${fmtT(song.data.duration)}`;
  if (!song.seeking) $('#songPos').value = Math.round(cur / (song.data.duration || 1) * 1000);
}
async function playSong() {
  if (!song.data) return;
  await startAudio();
  if (song.playing) return pauseSong();
  song.playing = true; $('#playBtn').textContent = '❚❚';
  song.startCtx = ctx.currentTime + 0.1 - song.pos / song.speed;
  song.idx = song.data.events.findIndex(e => e.time >= song.pos); if (song.idx < 0) song.idx = song.data.events.length;
  schedule();
}
function schedule() {
  if (!song.playing) return;
  const ev = song.data.events, horizon = (ctx.currentTime - song.startCtx + 0.2) * song.speed;
  const batch = [];
  while (song.idx < ev.length && ev[song.idx].time <= horizon) {
    const e = ev[song.idx++], t = song.startCtx + e.time / song.speed;
    if (e.type === 'on') { batch.push({ type: 'on', note: e.note, vel: e.vel, t }); song.notesOn.add(e.note); uiAt(t, () => setKey(e.note, true)); }
    else if (e.type === 'off') { batch.push({ type: 'off', note: e.note, vel: e.vel, t }); song.notesOn.delete(e.note); uiAt(t, () => setKey(e.note, keysDown.has(e.note))); }
    else if (e.type === 'bend') batch.push({ type: 'bend', semis: e.value / 8192 * p.bendRange, t });
    else if (e.type === 'cc') {
      const w = { 64: 'sustain', 66: 'sostenuto', 67: 'soft', 69: 'harmonic' }[e.cc];
      if (w) { const v = w === 'sustain' || w === 'soft' ? e.value / 127 : (e.value >= 64 ? 1 : 0); batch.push({ type: 'pedal', which: w, value: v, t }); uiAt(t, () => { pedals[w] = v; drawPedals(); }); }
    }
  }
  if (batch.length) g.node.port.postMessage({ type: 'events', events: batch });
  updateSongTime();
  if (song.idx >= ev.length && ctx.currentTime - song.startCtx > song.data.duration / song.speed + (song.loop ? 0.3 : 0.5)) {
    if (song.loop) { song.startCtx = ctx.currentTime + 0.25; song.idx = 0; song.notesOn.clear(); }
    else { stopSong(); return; }
  }
  song.timer = setTimeout(schedule, 40);
}
function uiAt(t, fn) { setTimeout(fn, Math.max(0, (t - ctx.currentTime) * 1000)); }
function pauseSong() {
  song.pos = (ctx.currentTime - song.startCtx) * song.speed;
  haltSong();
}
function haltSong() {
  song.playing = false; clearTimeout(song.timer); $('#playBtn').textContent = '▶';
  if (g) { g.node.port.postMessage({ type: 'panic' }); for (const [k, v] of Object.entries(pedals)) if (v) send({ type: 'pedal', which: k, value: v }); for (const m of silentKeys) send({ type: 'on', note: m, vel: 0, silent: true }); }
  for (const m of song.notesOn) setKey(m, keysDown.has(m)); song.notesOn.clear();
  for (const w of ['sustain', 'sostenuto', 'soft', 'harmonic']) { pedals[w] = 0; send({ type: 'pedal', which: w, value: 0 }); } drawPedals();
  send({ type: 'bend', semis: bendSemis });                     // a song's pitch wheel must not stay bent after it stops; the live wheel state comes back
}
function stopSong() { if (song.playing) haltSong(); song.pos = 0; updateSongTime(); }
function seekSong(frac) {
  const was = song.playing; if (was) haltSong();
  song.pos = frac * song.data.duration; updateSongTime();
  if (was) playSong();
}

// ======================= offline render (MIDI -> WAV) =======================
let renderAbort = false;
async function renderWav() {
  if (!song.data) return;
  const sr = 48000, dur = song.data.duration / song.speed + Math.min(8, p.duration + 3);
  const events = [];
  for (const e of song.data.events) {
    const t = 0.05 + e.time / song.speed;
    if (e.type === 'on') events.push({ type: 'on', note: e.note, vel: e.vel, t });
    else if (e.type === 'off') events.push({ type: 'off', note: e.note, vel: e.vel, t });
    else { const w = { 64: 'sustain', 66: 'sostenuto', 67: 'soft', 69: 'harmonic' }[e.cc]; if (w) events.push({ type: 'pedal', which: w, value: w === 'sustain' || w === 'soft' ? e.value / 127 : +(e.value >= 64), t }); }
  }
  const oc = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  $('#renderOverlay').hidden = false; $('#renderProg').style.width = '0%'; renderAbort = false;
  const G = await buildGraph(oc, { events });
  G.lim.connect(oc.destination);
  const step = Math.max(1, Math.ceil(dur / 50));
  for (let t = step; t < dur; t += step) oc.suspend(t).then(() => { $('#renderProg').style.width = (t / dur * 100) + '%'; if (renderAbort) throw 0; oc.resume(); });
  try {
    const buf = await oc.startRendering();
    if (renderAbort) return;
    download(encodeWav(buf.getChannelData(0), buf.getChannelData(1), sr), song.name.replace(/\.midi?$/i, '') + ' · ' + allPresets()[presetIdx].name + '.wav');
    toast('Rendered ' + fmtT(dur));
  } catch { } finally { $('#renderOverlay').hidden = true; }
}

// ======================= live recording =======================
let recChunks = null;
function toggleRecord() {
  if (!g) { startAudio().then(toggleRecord); return; }
  const b = $('#recBtn');
  if (!recChunks) { recChunks = []; g.rec.port.postMessage('start'); b.classList.add('on'); b.querySelector('span').textContent = 'Stop'; }
  else { g.rec.port.postMessage('stop'); b.classList.remove('on'); b.querySelector('span').textContent = 'Record'; }
}
function onRecChunk(e) {
  if (e.data === 'done') {
    const ch = recChunks; recChunks = null;
    const n = ch.reduce((a, c) => a + c[0].length, 0); if (!n) return;
    const L = new Float32Array(n), R = new Float32Array(n); let o = 0;
    for (const [l, r] of ch) { L.set(l, o); R.set(r, o); o += l.length; }
    download(encodeWav(L, R, ctx.sampleRate), 'resonance-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.wav');
    return;
  }
  if (recChunks) recChunks.push(e.data);
}

// ======================= misc UI =======================
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
let toastT = 0;
function toast(msg) { const t = $('#toast'); t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }
function tip(title, body, el) {
  const t = $('#tooltip');
  if (!title) { t.hidden = true; return; }
  t.innerHTML = `<b>${title}</b>${body}`; t.hidden = false;
  const r = el.getBoundingClientRect(), tr = t.getBoundingClientRect();
  let y = r.top - tr.height - 8; if (y < 8) y = r.bottom + 8;
  t.style.left = clamp(r.left, 8, innerWidth - tr.width - 8) + 'px'; t.style.top = y + 'px';
}
function ctxMenu(items, x, y) {
  const m = $('#ctxMenu'); m.innerHTML = '';
  for (const [l, fn] of items) { const b = document.createElement('button'); b.textContent = l; b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); }
  m.hidden = false; m.style.left = Math.min(x, innerWidth - 200) + 'px'; m.style.top = Math.min(y, innerHeight - m.offsetHeight - 8) + 'px';
}
addEventListener('pointerdown', e => { if (!e.target.closest('#ctxMenu')) $('#ctxMenu').hidden = true; if (!e.target.closest('.menu-wrap')) $('#fileMenu').hidden = true; if (!e.target.closest('.opts')) $('.opts').open = false; }, true);

function fileMenu(act) {
  $('#fileMenu').hidden = true;
  if (act === 'export') download(new Blob([JSON.stringify({ name: allPresets()[presetIdx].name, p }, null, 1)], { type: 'application/json' }), allPresets()[presetIdx].name + '.json');
  if (act === 'import') $('#presetFile').click();
  if (act === 'midiExport') {
    if (!midiRecording.length) { toast('Nothing played yet'); return; }
    const t0 = midiRecording[0].time;
    download(new Blob([writeMidi(midiRecording.map(e => ({ ...e, time: e.time - t0 })))], { type: 'audio/midi' }), 'resonance-take.mid');
  }
  if (act === 'panic') { send({ type: 'panic' }); keysDown.forEach(m => setKey(m, false)); keysDown.clear(); silentKeys.forEach(m => keyEls[m].classList.remove('silent')); silentKeys.clear(); for (const w in pedals) setPedal(w, 0); }
}

// ======================= instruments: import / manage / help =======================
let tempName = '', tempSeq = 0;
async function refreshModelOptions() {
  const sel = $('#model'), user = await instStore.list();
  const opt = (v, l) => `<option value="${v}">${l.replace(/</g, '&lt;')}</option>`;
  sel.innerHTML =
    `<optgroup label="Built-in (measured)">${ENUMS.model.options.filter(o => o[0].startsWith('builtin:')).map(o => opt(...o)).join('')}</optgroup>` +
    `<optgroup label="Built-in (synth)">${ENUMS.model.options.filter(o => o[0].startsWith('synth:')).map(o => opt(...o)).join('')}</optgroup>` +
    (user.length ? `<optgroup label="Your instruments">${user.map(u => opt('user:' + u.id, u.name)).join('')}</optgroup>` : '') +
    (p.model.startsWith('temp:') && tempName ? `<optgroup label="Unsaved">${opt(p.model, tempName + ' (unsaved)')}</optgroup>` : '');
  if (![...sel.options].some(o => o.value === p.model)) p.model = ENUMS.model.def;
  sel.value = p.model;
}
function modal(title, html) {
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').hidden = false;
}
function setupInstrumentUI() {
  $('#modalClose').onclick = () => { $('#modal').hidden = true; };
  $('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') { $('#modal').hidden = true; } });
  $('#instImport').onclick = () => $('#instFile').click();
  $('#instFile').onchange = async e => {
    const fs = [...e.target.files]; e.target.value = ''; for (const f of fs) await importInstrumentFile(f, fs.length > 1);
    if (fs.length > 1) toast(`Imported ${fs.length} instruments`);
  };
  $('#instHelp').onclick = async () => modal('Measure your own instrument', await (await fetch('docs/measuring.html')).text());
  $('#instManage').onclick = manageInstruments;
  $('#instGen').onclick = openGenerator;
  $('#instAudio').onclick = () => openImportAudio();
  let worker = null, wid = 0; const waiting = {};
  const analyze = (samples, sr, midi) => new Promise(res => {
    try {
      worker ||= new Worker('js/analyzer.worker.js', { type: 'module' });
      worker.onmessage = e => { const f = waiting[e.data.id]; delete waiting[e.data.id]; f && f(e.data.result || null); };
      const id = ++wid; waiting[id] = res; worker.postMessage({ id, samples, sr, midi });
    } catch { setTimeout(() => res(analyzeNote(samples, sr, midi)), 0); }
  });
  initStudio({
    modal, download, analyze, recorderNode,
    audioContext: async () => { await startAudio(); return ctx; },
    currentModel: () => p.model,
    baseInstrument: async () => (await (await fetch('data/measured/iowa_grand.json')).json()),
    useTemporary(doc) {                       // play a generated instrument now, without storing it
      const key = 'temp:' + (++tempSeq);
      instCache[key] = Promise.resolve(compileInstrument(doc)); tempName = doc.name;
      const prev = p.model; p.model = key; adoptInstrument(prev, key).then(() => { markDirty(); pushParams(); refreshModelOptions(); refreshAll(); });
    },
    async models() {                         // every instrument the menu offers, for the mix pad's corners
      const user = await instStore.list();
      return [...ENUMS.model.options, ...user.map(u => ['user:' + u.id, u.name])];
    },
    async rawDoc(model) {                     // the instrument document behind a menu entry (for the mix pad's corners)
      if (model.startsWith('builtin:')) return (await fetch('data/measured/' + model.slice(8) + '.json')).json();
      if (model.startsWith('synth:')) return synthDefault(model.slice(6));
      if (model.startsWith('user:')) return (await instStore.get(model.slice(5)))?.doc;
      return null;
    },
    applyMix(comp, name) {                    // play a layered instrument (js/instrument.js mixCompiled) as the unsaved one
      let key = p.model;
      if (!key.startsWith('temp:')) { key = 'temp:' + (++tempSeq); const prev = p.model; p.model = key; adoptInstrument(prev, key).then(() => { markDirty(); pushParams(); refreshModelOptions(); refreshAll(); }); }
      instCache[key] = Promise.resolve(comp); tempName = name;
      const o = document.querySelector(`#model option[value="${key}"]`); if (o) o.textContent = name + ' (unsaved)';
      if (g) g.node.port.postMessage({ type: 'inst', data: comp });
      refreshInert();
    },
    mixWeights(w) {                           // only the puck moved: the parts stay, their weights change
      instCache[p.model]?.then(c => { if (c.multi) w.forEach((x, i) => { if (c.multi[i]) c.multi[i].w = x; }); });
      if (g) g.node.port.postMessage({ type: 'mixw', w });
    },
    updateTemporary(doc) {                    // replace the unsaved instrument in place (the variation pad calls this on every move)
      if (!p.model.startsWith('temp:')) return this.useTemporary(doc);
      const key = p.model, c = compileInstrument(doc); instCache[key] = Promise.resolve(c); tempName = doc.name;
      const o = document.querySelector(`#model option[value="${key}"]`); if (o) o.textContent = doc.name + ' (unsaved)';
      if (g) g.node.port.postMessage({ type: 'inst', data: c });
      refreshInert();
    },
    async playDemo(lo, hi) {                  // short phrase across the instrument's range
      await startAudio();
      const t0 = ctx.currentTime + 0.15, ev = [], mid = Math.round((lo + hi) / 2 / 12) * 12;
      const seq = [0, 4, 7, 12, 16, 19, 24].map(i => Math.min(hi, Math.max(lo, mid - 12 + i)));
      seq.forEach((n, i) => { ev.push({ type: 'on', note: n, vel: 70 + i * 6, t: t0 + i * 0.16 }, { type: 'off', note: n, t: t0 + i * 0.16 + 0.5 }); });
      const ch = [mid - 12, mid - 5, mid, mid + 4, mid + 7].map(n => Math.min(hi, Math.max(lo, n))), tc = t0 + seq.length * 0.16 + 0.25;
      ch.forEach(n => ev.push({ type: 'on', note: n, vel: 85, t: tc }, { type: 'off', note: n, t: tc + 2.2 }));
      g.node.port.postMessage({ type: 'events', events: ev });
    },
    async saveAndSelect(doc) {
      const id = await instStore.put(doc); await refreshModelOptions();
      beginEdit(); const prev = p.model; p.model = 'user:' + id; await adoptInstrument(prev, p.model); markDirty(); pushParams(); refreshAll(); commit(); return id;
    },
  });
}
// Instruments the local server offers from a folder outside the repo (serve.mjs --instruments; nothing there when the page is hosted elsewhere):
// each one is stored in the browser once, and again whenever its file has changed.
async function syncLocalInstruments() {
  try {
    const r = await fetch('local/index.json', { cache: 'no-store' }); if (!r.ok) return;
    const list = await r.json(); let seen = {}; try { seen = JSON.parse(localStorage.getItem('resonance.local') || '{}'); } catch { }
    const have = await instStore.list(); let n = 0;
    const live = new Set(list.map(it => it.name)), stale = have.filter(u => / \((measured|sampled)\)$/.test(u.name) && !live.has(u.name));
    for (const u of stale) await instStore.remove(u.id);                                                 // a renamed instrument leaves no old copy behind
    if (stale.length) { seen = {}; have.splice(0, have.length, ...await instStore.list()); }
    for (const it of list) {
      if (seen[it.file] === it.mtime && have.some(u => u.name === it.name)) continue;
      try {
        const doc = await (await fetch('local/' + encodeURIComponent(it.file))).json(); validateInstrument(doc); compileInstrument(doc);
        for (const u of have.filter(u => u.name === doc.name)) await instStore.remove(u.id);          // a rebuilt file replaces its old copy
        await instStore.put(doc); seen[it.file] = it.mtime; n++;
      } catch (e) { console.warn('local instrument', it.file, e); }
    }
    try { localStorage.setItem('resonance.local', JSON.stringify(seen)); } catch { }
    if (n) { await refreshModelOptions(); toast(`Loaded ${n} instrument${n > 1 ? 's' : ''} from the local folder`); }
  } catch { }
}
async function importInstrumentFile(f, quiet = false) {
  try {
    const doc = JSON.parse(await f.text());
    validateInstrument(doc);
    compileInstrument(doc);                                   // throws on malformed content
    const id = await instStore.put(doc);
    await refreshModelOptions();
    beginEdit(); const prev = p.model; p.model = 'user:' + id; await adoptInstrument(prev, p.model); markDirty(); pushParams(); refreshAll(); commit();
    if (!quiet) toast(`Imported “${doc.name}” · ${doc.keys.length} keys`);
  } catch (err) { toast('Import failed: ' + err.message); }
}
async function manageInstruments() {
  const list = await instStore.list();
  const rows = list.map(u => {
    const k = u.doc.keys.length, layers = u.doc.keys.reduce((a, x) => a + x.layers.length, 0);
    return `<div class="inst-row"><div class="nm">${u.name.replace(/</g, '&lt;')}<small>${k} keys · ${layers} layers · ${u.doc.author ? 'by ' + u.doc.author.replace(/</g, '&lt;') + ' · ' : ''}${u.doc.license ? u.doc.license.replace(/</g, '&lt;') : 'no licence given'}</small></div>
      <button class="mini" data-exp="${u.id}">Export</button><button class="mini" data-del="${u.id}">Delete</button></div>`;
  }).join('') || '<p>No imported instruments yet. Use <b>Import…</b>, or read <b>How to measure your own</b>.</p>';
  modal('Your instruments', rows + '<p style="margin-top:14px">Stored only in this browser. Export to keep a copy or share it.</p>');
  $$('#modalBody [data-exp]').forEach(b => b.onclick = async () => {
    const u = await instStore.get(b.dataset.exp);
    download(new Blob([JSON.stringify(u.doc, null, 1)], { type: 'application/json' }), (u.name || 'instrument') + '.json');
  });
  $$('#modalBody [data-del]').forEach(b => b.onclick = async () => {
    await instStore.remove(b.dataset.del); delete instCache['user:' + b.dataset.del];
    if (p.model === 'user:' + b.dataset.del) { p.model = ENUMS.model.def; pushParams(); }
    await refreshModelOptions(); manageInstruments();
  });
}

// ======================= init =======================
function init() {
  for (const grp of ['tuning', 'voicing', 'design', 'output', 'reverb', 'options']) {
    const host = document.querySelector(`[data-sliders=${grp}]`);
    for (const d of PARAMS.filter(d => d.group === grp)) host.appendChild(makeSlider(d));
  }
  makeSelect('temperament'); makeSelect('room'); makeSelect('model'); refreshModelOptions(); setupInstrumentUI(); syncLocalInstruments();
  makeSeg('mode'); makeSeg('voices'); makeSeg('lid'); makeSeg('perspective');
  makeProfile(); setupCurves(); setupPedals(); buildKeyboard(); setupComputerKeys();
  for (const [id, key] of [['reverbOn', 'reverbOn'], ['damperNoise', 'damperNoise'], ['fullSympa', 'fullSympa']])
    $('#' + id).onchange = e => { beginEdit(); p[key] = e.target.checked; markDirty(); pushParams(); refreshAll(); commit(); };

  const saved = store.get('state', null);
  fillPresetMenu();
  if (saved && saved.p) { p = Object.assign(defaults(), saved.p); presetIdx = Math.max(0, saved.presetName ? allPresets().findIndex(x => x.name === saved.presetName) : Math.min(saved.presetIdx || 0, allPresets().length - 1)); dirty = saved.dirty; }
  else p = presetParams(PRESETS[0]);
  refreshAll(); updateUndo();

  a11yPass();
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => { });     // offline use; plain http just skips it
  Object.assign(padState, store.get('pad2', {}), { x: p.pad?.[0] ?? 0, y: p.pad?.[1] ?? 0 });     // the puck lives in p, so undo and preset loads move it
  padCtl = initPad({ root: $('#pad'), presets: () => [...VOICINGS, ...allPresets()], menu: () => [...VOICINGS, ...userPresets], presetParams, params: PARAMS, state: padState,
    onStart: beginEdit, onMove: values => { Object.assign(p, values); p.pad = [padState.x, padState.y]; markDirty(); refreshAll(); pushParams(); persist(); }, onEnd: commit,
    save: () => store.set('pad2', { center: padState.center, poles: padState.poles }) });
  $('#fileMenuBtn').onclick = () => { $('#fileMenu').hidden = !$('#fileMenu').hidden; };
  $$('#fileMenu button').forEach(b => b.onclick = () => fileMenu(b.dataset.act));
  $('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo; $('#randomBtn').onclick = randomise;
  $('#powerBtn').onclick = async () => { if (ctx && ctx.state === 'running') { await ctx.suspend(); $('#powerBtn').classList.remove('on'); $('#powerLbl').textContent = 'Resume audio'; } else { await startAudio(); $('#powerBtn').classList.add('on'); $('#powerLbl').textContent = 'Audio on'; } };
  $('#loadMidi').onclick = () => $('#midiFile').click();
  $('#midiFile').onchange = e => e.target.files[0] && loadMidiFile(e.target.files[0]);
  $('#presetFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); userPresets.push({ name: j.name || f.name, p: j.p || j }); store.set('userPresets', userPresets); fillPresetMenu(); loadPreset(allPresets().length - 1); toast('Imported ' + (j.name || f.name)); }
    catch { toast('Not a preset file'); }
  };
  $('#playBtn').onclick = playSong; $('#stopBtn').onclick = stopSong;
  song.loop = store.get('loop', false); $('#loopBtn').classList.toggle('on', song.loop);
  $('#loopBtn').onclick = () => { song.loop = !song.loop; store.set('loop', song.loop); $('#loopBtn').classList.toggle('on', song.loop); };
  const sp = $('#songPos');
  sp.oninput = () => { song.seeking = true; $('#songTime').textContent = `${fmtT(sp.value / 1000 * song.data.duration)} / ${fmtT(song.data.duration)}`; };
  sp.onchange = () => { song.seeking = false; seekSong(sp.value / 1000); };
  $('#tempo').oninput = e => {
    const s = e.target.value / 100; $('#tempoVal').textContent = e.target.value + '%';
    if (song.playing) { const cur = (ctx.currentTime - song.startCtx) * song.speed; song.speed = s; song.startCtx = ctx.currentTime - cur / s; } else song.speed = s;
  };
  $('#exportWav').onclick = renderWav;
  $('#renderCancel').onclick = () => { renderAbort = true; $('#renderOverlay').hidden = true; };
  $('#recBtn').onclick = toggleRecord;
  setInterval(() => song.playing && updateSongTime(), 250);

  addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('dragging'); const fl = [...e.dataTransfer.files]; if (fl.length && fl.every(x => /\.(wav|wave|mp3|flac|ogg|oga|opus|m4a|aif|aiff|aac)$/i.test(x.name))) { openImportAudio(fl); return; } const f = fl[0]; if (f) f.name.endsWith('.json') ? f.text().then(t => { let j = null; try { j = JSON.parse(t); } catch { } if (j && j.format === 'resonance-instrument/1') importInstrumentFile(f); else $('#presetFile').onchange({ target: { files: [f] } }); }) : loadMidiFile(f); });

  setupMidi();
  drawPedals(); drawSpectrum(); animateKeys();
  // first gesture anywhere starts audio (autoplay policy)
  const firstGesture = e => { if (e.target.closest && e.target.closest('#powerBtn')) return; removeEventListener('pointerdown', firstGesture); startAudio(); };
  addEventListener('pointerdown', firstGesture);
  addEventListener('keydown', () => startAudio(), { once: true });
}
init();

// test hooks (headless verification)
window.__resonance = {
  startAudio, noteOn, noteOff, setPedal, loadPreset, get params() { return p; }, get ctx() { return ctx; }, get levels() { return levels; },
  async renderNotes(evts, seconds = 3, params, instDoc) {
    const oc = new OfflineAudioContext(2, Math.ceil(seconds * 48000), 48000);
    const save = p; if (params) p = Object.assign(defaults(), params);
    const extra = { events: evts };
    if (instDoc) extra.inst = compileInstrument(instDoc);
    const G = await buildGraph(oc, extra); p = save;
    G.lim.connect(oc.destination);
    const b = await oc.startRendering();
    return [b.getChannelData(0), b.getChannelData(1)];
  },
};
