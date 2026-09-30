// Offline shell: sw.js lists every file the app loads, the manifest points at real icons, and the page needs nothing from the network.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const sw = fs.readFileSync(ROOT + '/sw.js', 'utf8'), list = [...sw.slice(sw.indexOf('PRECACHE'), sw.indexOf('];')).matchAll(/'([^']+)'/g)].map(m => m[1]).filter(f => f !== './');
const missing = list.filter(f => !fs.existsSync(path.join(ROOT, f)));
ok(missing.length === 0, `every file in the service worker's list exists ${missing.length ? JSON.stringify(missing) : `(${list.length} files)`}`);
const onDisk = d => fs.readdirSync(path.join(ROOT, d)).filter(f => !f.startsWith('.') && !/LICENSE|\.map$/.test(f)).map(f => d + '/' + f);
const unlisted = [...onDisk('js'), ...onDisk('css'), ...onDisk('fonts'), ...onDisk('icons')].filter(f => !list.includes(f));
ok(unlisted.length === 0, `every script, stylesheet, font and icon is in the list ${unlisted.length ? JSON.stringify(unlisted) : ''}`);
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<a [^>]*>/g, '')), 'index.html loads nothing from another origin');
const css = fs.readFileSync(ROOT + '/css/style.css', 'utf8') + fs.readFileSync(ROOT + '/css/fonts.css', 'utf8');
ok(!/url\(\s*['"]?https?:/.test(css) && !/@import/.test(css), 'stylesheets load nothing from another origin');
const man = JSON.parse(fs.readFileSync(ROOT + '/manifest.webmanifest', 'utf8'));
ok(man.icons.every(i => fs.existsSync(path.join(ROOT, i.src))) && man.icons.some(i => i.sizes === '192x192') && man.icons.some(i => i.sizes === '512x512') && man.start_url && man.display === 'standalone', 'manifest: icons exist (192, 512), start_url and display set');
ok(/\.woff2/.test(fs.readFileSync(ROOT + '/serve.mjs', 'utf8')) && /webmanifest/.test(fs.readFileSync(ROOT + '/serve.mjs', 'utf8')), 'serve.mjs sends fonts and the manifest with the right types');
process.exit(fails ? 1 : 0);
