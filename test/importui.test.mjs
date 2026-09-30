// The audio import in the real page: node test/importui.test.mjs
//   Notes rendered by the engine are written as WAV files, chosen in the import window (some by name, one by pitch, one by a click on
//   the piano bar), measured in the browser and saved as an instrument that is then selected. Needs Playwright (see ui.test.mjs).
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), PORT = 9300 + Math.floor(Math.random() * 500);
let pw; try { pw = await import(process.env.PLAYWRIGHT || 'playwright'); } catch { console.log('skip: Playwright is not installed (npm i -D playwright, or set PLAYWRIGHT=/path/to/playwright/index.mjs)'); process.exit(0); }
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const { loadEngine, renderNote } = await import(ROOT + '/js/trimcore.js');
const { compile } = await import(ROOT + '/js/instrument.js'); const { encodeWav } = await import(ROOT + '/js/midifile.js');
const P = loadEngine(fs.readFileSync(ROOT + '/js/engine.worklet.js', 'utf8'));
const inst = compile(JSON.parse(fs.readFileSync(ROOT + '/data/measured/iowa_grand.json', 'utf8')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')), files = {};
const NM = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'], nn = m => NM[m % 12] + (Math.floor(m / 12) - 1);
const wavA = async (note, vel, name) => { const x = renderNote(P, inst, note, vel, 5, { globalRes: 0, sympRes: 0, hammerNoise: 0.8, keyNoise: 0 }); const blob = encodeWav(x, x, 48000); fs.writeFileSync(path.join(dir, name), Buffer.from(await blob.arrayBuffer())); files[name] = note; return path.join(dir, name); };
const named = [];
for (const k of [36, 48, 60, 72, 84]) for (const [v, tag] of [[32, 'pp'], [104, 'ff']]) named.push(await wavA(k, v, `Piano.${tag}.${nn(k)}.wav`));
const mystery = await wavA(60, 72, 'take 17.wav');            // no name: placed by its pitch (C4)
const manual = await wavA(64, 72, 'whatever.wav');            // put on the key E4 by a click
const { synthesize } = await import(ROOT + '/js/synth.js');
const jsons = ['bell', 'organ'].map((id, i) => { const f = path.join(dir, `syn${i}.json`); fs.writeFileSync(f, JSON.stringify({ ...synthesize(id, 5 + i, 1), name: 'Batch ' + id })); return f; });
const ldir = path.join(dir, 'local'); fs.mkdirSync(ldir); fs.writeFileSync(path.join(ldir, 'a.json'), JSON.stringify({ ...synthesize('bell', 9, 1), name: 'Local bell' })); fs.writeFileSync(path.join(ldir, 'b.json'), JSON.stringify({ ...synthesize('organ', 9, 1), name: 'Local organ' }));
// a flute-like instrument whose files are all named an octave too low (as real sample sets do): the sound decides, not the name
const fluteInst = compile(synthesize('flute', 1, 1)), fluteFiles = [];
for (const [sound, nameKey] of [[60, 48], [64, 52], [67, 55], [72, 60]]) { const x = renderNote(P, fluteInst, sound, 80, 3, { globalRes: 0, sympRes: 0, hammerNoise: 0.8, keyNoise: 0 }); const f = path.join(dir, `Flute_${nn(nameKey)}.wav`); fs.writeFileSync(f, Buffer.from(await encodeWav(x, x, 48000).arrayBuffer())); fluteFiles.push(f); }
const srv = spawn('node', ['serve.mjs', '--port', String(PORT), '--host', '127.0.0.1', '--instruments', ldir], { cwd: ROOT, stdio: 'ignore' });
const browser = await pw.chromium.launch();
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const pg = await browser.newPage({ viewport: { width: 1300, height: 1000 } }); const errs = [];
  pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' }); await pg.waitForTimeout(600);
  // instruments from the server's local folder are in the menu without any import, and stay one copy each after a reload
  await pg.waitForFunction(() => [...document.querySelectorAll('#model option')].filter(o => /^Local /.test(o.textContent)).length === 2, null, { timeout: 30000 });
  await pg.reload({ waitUntil: 'load' }); await pg.waitForTimeout(1500);
  ok(await pg.$$eval('#model option', o => o.filter(x => /^Local /.test(x.textContent)).length) === 2, 'the server\'s local instruments are in the menu by default, one copy each after a reload');
  await pg.click('#instAudio'); await pg.waitForSelector('.ia-k');
  ok(await pg.locator('.ia-k').count() === 88, 'the piano bar has 88 keys');
  ok(await pg.locator('#iaBuild').isDisabled(), 'Build is disabled while nothing is chosen');
  const choose = async (sel, list) => { const [fc] = await Promise.all([pg.waitForEvent('filechooser'), pg.click(sel)]); await fc.setFiles(list); };
  await choose('#iaAdd', [...named, mystery]);
  await pg.waitForFunction(() => /11 files on 5 keys/.test(document.querySelector('#iaSum')?.textContent || ''), null, { timeout: 60000 });
  ok(true, 'eleven files were placed on five keys: ' + await pg.locator('#iaSum').innerText());
  const has = await pg.$$eval('.ia-k.has', e => e.map(x => +x.dataset.m));
  ok(JSON.stringify(has.sort((a, b) => a - b)) === '[36,48,60,72,84]', `keys lit by name and pitch: ${has}`);
  await pg.click('.ia-k[data-m="60"]'); await pg.waitForSelector('.ia-row');
  ok(await pg.locator('.ia-row').count() === 3, 'C4 has three files (pp and ff by name, the mystery one by its pitch)');
  ok(/pitch/.test(await pg.locator('.ia-row .ia-n small').first().innerText().catch(() => '')) || (await pg.locator('.ia-row').allInnerTexts()).some(t => /placed by its pitch/.test(t)), 'the file placed by pitch says so');
  const vels = await pg.$$eval('.ia-row select[data-k="vel"]', s => s.map(x => +x.value).sort((a, b) => a - b));
  ok(vels.length === 3 && vels[0] === 32 && vels[2] === 104 && vels[1] > 32 && vels[1] < 104, `strengths: pp 32, ff 104 by name, the unnamed one in between (${vels})`);
  // by hand: click the empty key E4 and choose a file
  const [fc] = await Promise.all([pg.waitForEvent('filechooser'), pg.click('.ia-k[data-m="64"]')]); await fc.setFiles([manual]);
  await pg.waitForFunction(() => /12 files on 6 keys/.test(document.querySelector('#iaSum')?.textContent || ''), null, { timeout: 30000 });
  ok(await pg.locator('.ia-k[data-m="64"].has').count() === 1, 'clicking the empty key E4 and choosing a file puts it there');
  await pg.locator('#iaName').fill('Test piano');
  await pg.click('#iaBuild');
  await pg.waitForSelector('#iaDl', { timeout: 240000 });
  const done = await pg.locator('#modalBody').innerText();
  ok(/Test piano/.test(done) && /6 keys/.test(done), 'built: ' + done.split('\n')[0]);
  await pg.click('#modalClose'); await pg.waitForTimeout(800);
  ok(/Test piano/.test(await pg.$eval('#model', s => s.selectedOptions[0]?.textContent || '')), 'the new instrument is selected in the model menu');
  // Import… takes several instrument files at once
  await pg.locator('#instFile').setInputFiles(jsons); await pg.waitForFunction(() => [...document.querySelectorAll('#model option')].filter(o => /^Batch /.test(o.textContent)).length === 2, null, { timeout: 30000 });
  ok(true, 'Import… with two instrument files loads both');
  // the Notes-at-once switch is on the page and remembers its choice
  ok(await pg.locator('#voices button').count() === 3 && await pg.locator('#voices button.on').innerText() === 'Instrument', 'Notes at once: three choices, Instrument selected by default');
  await pg.locator('#voices button', { hasText: 'Chords' }).click(); await pg.reload({ waitUntil: 'load' }); await pg.waitForTimeout(600);
  ok(await pg.locator('#voices button.on').innerText() === 'Chords', 'the Chords choice survives a reload');
  // files named an octave low land on the keys they sound on
  await pg.click('#instAudio'); await pg.waitForSelector('.ia-k');
  { const [fc] = await Promise.all([pg.waitForEvent('filechooser'), pg.click('#iaAdd')]); await fc.setFiles(fluteFiles); }
  await pg.waitForFunction(() => /4 files on 4 keys/.test(document.querySelector('#iaSum')?.textContent || ''), null, { timeout: 60000 });
  const lit = (await pg.$$eval('.ia-k.has', e => e.map(x => +x.dataset.m))).sort((a, b) => a - b);
  ok(JSON.stringify(lit) === '[60,64,67,72]', `four flute files named C3 to C4 are placed on the keys they sound on, one octave up: ${lit}`);
  await pg.click('.ia-k[data-m="60"]'); ok(/sounds C4/.test(await pg.locator('.ia-row').first().innerText()), 'and the row says so: ' + (await pg.locator('.ia-row').first().innerText()).replace(/\n/g, ' '));
  await pg.click('#modalClose');
  // the variation dialog offers every instrument of the menu, imported ones included, and varies them
  await pg.click('#instGen'); await pg.waitForSelector('#genKind');
  const kinds = await pg.$$eval('#genKind option', o => o.map(x => x.textContent));
  ok(['Test piano', 'Batch bell', 'Batch organ', 'Local bell'].every(n => kinds.some(k => k.startsWith(n))), `Variation lists the imported and local instruments (${kinds.length} kinds)`);
  await pg.selectOption('#genKind', { label: kinds.find(k => k.startsWith('Test piano')) });
  await pg.waitForFunction(() => /Now playing/.test(document.querySelector('#genMsg')?.textContent || ''), null, { timeout: 20000 }).catch(() => { });
  const pad = pg.locator('.pad-svg').last(); const bb = await pad.boundingBox(); await pg.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await pg.mouse.down(); await pg.mouse.move(bb.x + bb.width / 2, bb.y + bb.height * 0.2, { steps: 5 }); await pg.mouse.up();
  await pg.waitForTimeout(800);
  ok(/Test piano variation/.test(await pg.locator('#genMsg').innerText()), 'dragging the pad plays a variation of the imported piano: ' + (await pg.locator('#genMsg').innerText()));
  await pg.click('#modalClose');
  await pg.locator('.key, #keys').first().waitFor({ state: 'attached' }).catch(() => { });
  ok(errs.length === 0, 'no page errors ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : ''));
} finally { await browser.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
process.exit(fails ? 1 : 0);
