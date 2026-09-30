// Standard MIDI File reader (type 0/1) -> timed events in seconds, and a type-0 writer.

export function parseMidi(buf) {
  const d = new DataView(buf);
  let p = 0;
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); p += n; return s; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hl = u32(), format = u16(), ntr = u16(), div = u16(); p += hl - 6;
  if (div & 0x8000) throw new Error('SMPTE time division not supported');
  const raw = [], tempos = [];
  for (let t = 0; t < ntr && p < d.byteLength; t++) {
    while (p < d.byteLength && str(4) !== 'MTrk') { p += u32(); }
    const len = u32(), end = p + len;
    let tick = 0, run = 0;
    while (p < end) {
      tick += vlq();
      let st = d.getUint8(p);
      if (st & 0x80) p++; else st = run;
      if (st === 0xff) {
        const type = d.getUint8(p++), l = vlq();
        if (type === 0x51) tempos.push({ tick, us: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
        p += l;
      } else if (st === 0xf0 || st === 0xf7) { p += vlq(); }
      else {
        run = st;
        const hi = st & 0xf0, ch = st & 0x0f;
        const a = d.getUint8(p++), b = (hi === 0xc0 || hi === 0xd0) ? 0 : d.getUint8(p++);
        if (hi === 0x90 && b > 0) raw.push({ tick, type: 'on', ch, note: a, vel: b });
        else if (hi === 0x80 || (hi === 0x90 && b === 0)) raw.push({ tick, type: 'off', ch, note: a, vel: hi === 0x80 ? b : 64 });
        else if (hi === 0xb0) raw.push({ tick, type: 'cc', ch, cc: a, value: b });
        else if (hi === 0xe0) raw.push({ tick, type: 'bend', ch, value: ((b << 7) | a) - 8192 });        // pitch wheel, -8192 .. 8191
      }
    }
    p = end;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
  // tick -> seconds through the tempo map
  const toSec = tick => {
    let s = 0, last = 0, us = tempos[0].us;
    for (const tp of tempos) { if (tp.tick > tick) break; s += (tp.tick - last) * us / div / 1e6; last = tp.tick; us = tp.us; }
    return s + (tick - last) * us / div / 1e6;
  };
  raw.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));
  const events = raw.map(e => ({ ...e, time: toSec(e.tick) }));
  const duration = events.length ? events[events.length - 1].time : 0;
  return { format, tracks: ntr, events, duration, notes: events.filter(e => e.type === 'on').length };
}

// events: [{time, type:'on'|'off'|'cc', note, vel, cc, value}] -> type-0 SMF at 120 bpm, 480 ppq
export function writeMidi(events) {
  const ppq = 480, spt = 0.5 / ppq;
  const out = [];
  const vlq = v => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); out.push(...b); };
  let last = 0;
  out.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
  for (const e of [...events].sort((a, b) => a.time - b.time)) {
    const tick = Math.round(e.time / spt);
    vlq(Math.max(0, tick - last)); last = tick;
    if (e.type === 'on') out.push(0x90, e.note, Math.max(1, e.vel));
    else if (e.type === 'off') out.push(0x80, e.note, e.vel ?? 64);
    else out.push(0xb0, e.cc, e.value);
  }
  out.push(0x00, 0xff, 0x2f, 0x00);
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 0xff,
    0x4d, 0x54, 0x72, 0x6b, (out.length >>> 24) & 0xff, (out.length >>> 16) & 0xff, (out.length >>> 8) & 0xff, out.length & 0xff];
  return new Uint8Array([...hdr, ...out]);
}

export function encodeWav(L, R, sr) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), d = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); d.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 2, true); d.setUint32(24, sr, true);
  d.setUint32(28, sr * 4, true); d.setUint16(32, 4, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    d.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    d.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 4;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
