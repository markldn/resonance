// Browser test of the real page: node test/ui.test.mjs
//   Needs Playwright: `npm i -D playwright && npx playwright install chromium`, or PLAYWRIGHT=/path/to/playwright/index.mjs.
//   Without it the test says so and exits 0. It serves the repo itself on a spare port.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), PORT = 9300 + Math.floor(Math.random() * 500);
let pw; try { pw = await import(process.env.PLAYWRIGHT || 'playwright'); } catch { console.log('skip: Playwright is not installed (npm i -D playwright, or set PLAYWRIGHT=/path/to/playwright/index.mjs)'); process.exit(0); }
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const srv = spawn('node', ['serve.mjs', '--port', String(PORT), '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const browser = await pw.chromium.launch();
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
  const pg = await browser.newPage({ viewport: { width: 1500, height: 900 } }); const errs = [];
  pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' }); await pg.waitForTimeout(600);
  const slider = id => pg.locator(`.sl-track[aria-label="${id}"]`);
  const val = async label => +(await slider(label).getAttribute('aria-valuenow'));
  const pad = pg.locator('.pad-svg'); const box = await pad.boundingBox(); const R = 84 / 220 * box.width, cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const drag = async (x, y) => { await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + x * R, cy + y * R, { steps: 6 }); await pg.mouse.up(); };

  ok(await pg.locator('#presetSel').count() === 0 && await pg.locator('#model').isVisible(), 'no preset dropdown; the instrument menu is in the top bar')
  ok((await pg.$$eval('.sl-track', t => t.filter(e => e.getAttribute('role') === 'slider' && e.getAttribute('aria-label')).length)) >= 20, 'every slider has role=slider and a name');
  const unnamed = await pg.evaluate(() => [...document.querySelectorAll('button, select, input:not([type=hidden]), [role=slider], [role=button]')].filter(e => !(e.textContent.trim() || e.getAttribute('aria-label') || e.labels?.length || e.title || e.getAttribute('aria-labelledby') || e.placeholder)).map(e => e.id || e.className));
  ok(unnamed.length === 0, `no control without an accessible name ${unnamed.length ? JSON.stringify(unnamed) : ''}`);

  // sliders by keyboard
  const hm = 'Felt · medium playing'; await slider(hm).focus(); const v0 = await val(hm);
  await pg.keyboard.press('ArrowRight'); const v1 = await val(hm); await pg.keyboard.press('PageDown'); const v2 = await val(hm);
  ok(v1 > v0 && v2 < v1, `slider by keyboard: ArrowRight ${v0} -> ${v1}, PageDown -> ${v2}`);
  await pg.keyboard.press('End'); ok(await val(hm) === 2, 'End goes to the maximum'); await pg.keyboard.press('Delete'); ok(Math.abs(await val(hm) - 1) < 1e-9, 'Delete resets to the default');
  ok(/\d/.test(await slider(hm).getAttribute('aria-valuetext')), 'aria-valuetext carries the formatted value');

  // pad, undo, restore
  await drag(0, -1); const north = await val(hm); ok(north === 2, `pad north rim pushes hardness to the maximum (${north})`);
  await drag(0, 1); ok(await val(hm) < 0.05, `pad south rim pushes hardness to the minimum (${await val(hm)})`);
  await pg.dblclick('.pad-svg'); ok(Math.abs(await val(hm) - 1) < 1e-9, 'double-click centres the pad and restores the centre sound');
  await drag(0.4, -0.4); const mid = await val(hm); const pos = await pg.$eval('.pad-puck', c => [c.getAttribute('cx'), c.getAttribute('cy')].join(','));
  await pg.reload({ waitUntil: 'load' }); await pg.waitForTimeout(500);
  ok(Math.abs(await val(hm) - mid) < 1e-6 && await pg.$eval('.pad-puck', c => [c.getAttribute('cx'), c.getAttribute('cy')].join(',')) === pos, 'reload restores the sound and the puck');
  await pg.locator('.pad-svg').focus(); await pg.keyboard.press('Home'); ok(Math.abs(await val(hm) - 1) < 1e-9, 'pad: Home centres it');
  await pg.click('#undoBtn'); ok(Math.abs(await val(hm) - mid) < 1e-6, 'undo brings the pre-Home sound back');

  // pedal by keyboard
  const ped = pg.locator('.pedal[data-pedal=sostenuto]'); await ped.focus(); await pg.keyboard.press('Enter');
  ok(await ped.getAttribute('aria-pressed') === 'true', 'pedal: Enter latches it and reports aria-pressed');
  await pg.keyboard.press('Enter'); ok(await ped.getAttribute('aria-pressed') === 'false', 'pedal: Enter releases it');
  // offline: the service worker has cached the shell, so the page still works with the network cut
  await pg.evaluate(() => navigator.serviceWorker.ready); await pg.waitForTimeout(600);
  ok(await pg.evaluate(() => !!navigator.serviceWorker.controller), 'service worker is active and controls the page');
  await pg.context().setOffline(true); await pg.reload({ waitUntil: 'load' }); await pg.waitForTimeout(600);
  ok((await pg.$$('.sl-track')).length >= 20 && await pg.locator('.pad-svg').count() === 1, 'offline reload: the whole interface is there');
  const faces = await pg.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')); });
  ok(['Inter', 'JetBrains Mono', 'Cormorant Garamond'].every(f => faces.includes(f)), `offline reload: fonts come from the local files (${faces.join(', ')})`);
  await pg.context().setOffline(false);
  // a phone: nothing wider than the screen, and the pad answers a finger
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }), mp = await phone.newPage();
  await mp.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' }); await mp.waitForTimeout(600);
  const over = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  ok(over.sw <= over.iw + 1, `phone width: no horizontal overflow (page ${over.sw} px, screen ${over.iw} px)`);
  await mp.locator('.pad-svg').scrollIntoViewIfNeeded(); await mp.waitForTimeout(500); const y0 = await mp.evaluate(() => scrollY); const pb = await mp.locator('.pad-svg').boundingBox(), pcx = pb.x + pb.width / 2, pcy = pb.y + pb.height / 2, cdp = await phone.newCDPSession(mp);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pcx, y: pcy }] });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pcx, y: pcy - i * pb.height * 0.07 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await mp.waitForTimeout(200);
  ok(/Glass/.test(await mp.locator('.pad-read').innerText()) && await mp.evaluate(() => scrollY) === y0, 'phone: a finger drag moves the pad and does not scroll the page');
  await phone.close();
  // velocity curve: easy to grab. A click a few pixels off a point still grabs it; dragging from the line adds a point.
  {
    const c = pg.locator('#velCurve'); await c.scrollIntoViewIfNeeded(); const b = await c.boundingBox(), sel = pg.locator('#velPreset');
    await sel.selectOption('Linear'); ok(await sel.inputValue() === 'Linear', 'velocity preset Linear selected');
    await pg.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2 + 3); await pg.mouse.down(); await pg.mouse.up();
    ok(await sel.inputValue() === 'Linear', 'a plain click on the line changes nothing');
    await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 9); await pg.mouse.down(); await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 30, { steps: 5 }); await pg.mouse.up();
    ok(await sel.inputValue() === '', 'dragging from 9 px beside the line bends the curve (adds a point)');
    await sel.selectOption('Linear');
    await pg.mouse.move(b.x + 10 + 8, b.y + b.height - 10 - 6); await pg.mouse.down(); await pg.mouse.move(b.x + 10 + 8, b.y + b.height - 40, { steps: 5 }); await pg.mouse.up();
    ok(await sel.inputValue() === '', 'a press 10 px from an end point grabs it');
    await sel.selectOption('Linear');
    await pg.mouse.move(b.x + b.width / 2, b.y + 10); await pg.mouse.down(); await pg.mouse.move(b.x + b.width / 2, b.y + 40, { steps: 3 }); await pg.mouse.up();
    ok(await sel.inputValue() === 'Linear', 'a press far from the curve does nothing');
  }

  // Variation dialog. Vary mode: every kind builds an instrument, the puck blends corners, New rerolls one. Mix mode: four engines layered by the puck.
  {
    await pg.locator('#instGen').click(); await pg.waitForSelector('#genKind'); await pg.waitForSelector('#vpad .pad-svg');
    const kinds = await pg.locator('#genKind option').evaluateAll(o => o.map(e => e.value));
    ok(kinds.length >= 13 && kinds[0] === 'builtin:iowa_grand' && kinds.includes('bell') && kinds.includes('organ') && kinds.includes('builtin:salamander_grand'), `dialog: kinds (every instrument of the menu) ${kinds.slice(0, 15).join(', ')}${kinds.length > 15 ? ' …' : ''}`);
    const msg = () => pg.locator('#genMsg').textContent();
    const puck = async (x, y) => { const bx = await pg.locator('#vpad .pad-svg').boundingBox(), R = 84 / 220 * bx.width, cx = bx.x + bx.width / 2, cy = bx.y + bx.height / 2; await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + x * R, cy + y * R, { steps: 5 }); await pg.mouse.up(); await pg.waitForTimeout(500); };
    for (const kind of kinds.filter((k, i) => !k.startsWith('user:') || kinds.findIndex(q => q.startsWith('user:')) === i)) {          // the built-ins and the first instrument of yours
      await pg.selectOption('#genKind', kind); await puck(0.3, -0.3);
      ok(/Now playing/.test(await msg()) && /\d+ keys/.test(await msg()), `dialog: ${kind} -> ${(await msg()).slice(0, 60)}`);
    }
    await pg.selectOption('#genKind', 'builtin:iowa_grand'); await puck(0.37, -0.37);
    const read1 = await pg.locator('#vpad .pad-read').textContent();
    ok(/north/.test(read1) && /east/.test(read1), `dialog: the puck between north and east blends both corners (${read1})`);
    await pg.locator('#vpad .pad-svg').dblclick(); await pg.waitForTimeout(300);
    ok(/100% original/.test(await pg.locator('#vpad .pad-read').textContent()), 'dialog: double-click returns the puck to the original instrument');
    await puck(0, -0.74);
    const label = await pg.locator('#vpad .vp-pole.n span').textContent();
    await pg.locator('#vpad .vp-pole.n button').click(); await pg.waitForTimeout(300);
    ok(label !== await pg.locator('#vpad .vp-pole.n span').textContent(), 'dialog: New rerolls the north corner (its number changes)');
    ok(await pg.locator('#genSave').isEnabled(), 'dialog: the sound can be saved');
    // Mix mode
    await pg.locator('#vpModeMix').click(); await pg.waitForSelector('#vpad .vp-pole.n select');
    const opts = await pg.locator('#vpad .vp-pole.n select option').evaluateAll(o => o.map(e => e.value));
    ok(opts.includes('builtin:iowa_grand') && opts.includes('builtin:salamander_grand') && opts.includes('synth:bell') && opts.length >= 8, `mix: every engine is offered in a corner (${opts.length} instruments)`);
    await pg.selectOption('#vpad .vp-pole.n select', 'synth:bell'); await puck(0, -0.74);
    ok(/Mix: /.test(await msg()) && /100% north/.test(await pg.locator('#vpad .pad-read').textContent()), `mix: puck on the north corner -> ${(await msg()).slice(0, 50)}`);
    ok((await pg.locator('#model').inputValue()).startsWith('temp:'), 'mix: the model menu shows the unsaved mix');
    await puck(0.37, 0.37); await puck(-0.5, 0.2);
    ok(!/error/i.test(await msg()), 'mix: dragging across corners keeps playing');
    await pg.locator('#vpMangle').click(); await pg.waitForTimeout(600);
    ok(/Mix: /.test(await msg()), `mix: Mangle picks four random engines (${(await msg()).slice(0, 60)})`);
  }
  ok(errs.length === 0, `no page errors ${errs.length ? JSON.stringify(errs) : ''}`);
} finally { await browser.close(); srv.kill(); }
process.exit(fails ? 1 : 0);
