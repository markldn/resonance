// serve.mjs: zero-dependency static server with HTTP Range support (needed for MP4 seeking in browsers).
//   node serve.mjs [--port 9040] [--host 0.0.0.0] [--root .] [--instruments DIR]   "/" serves index.html
//   --instruments DIR (or RESONANCE_INSTRUMENTS; optional): a folder of resonance-instrument/1 .json files kept
//   outside the repo (built with tools/build_sampled_set.py). /local/index.json lists them and /local/<file> serves one; the page loads them into its menu.
import http from 'node:http';
import { createReadStream, statSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = resolve(arg('root', dirname(fileURLToPath(import.meta.url)))), PORT = +arg('port', 9040), HOST = arg('host', '0.0.0.0');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8' };
const LOCAL = arg('instruments', process.env.RESONANCE_INSTRUMENTS) ? resolve(arg('instruments', process.env.RESONANCE_INSTRUMENTS)) : null;
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/local/') && LOCAL && existsSync(LOCAL)) {
    const name = p.slice(7), json = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' };
    if (name === 'index.json') {
      const list = readdirSync(LOCAL).filter(f => f.endsWith('.json') && !f.startsWith('.')).sort().map(f => { let n = f; try { n = JSON.parse(readFileSync(join(LOCAL, f), 'utf8')).name || f; } catch { } return { file: f, name: n, mtime: Math.floor(statSync(join(LOCAL, f)).mtimeMs) }; });
      res.writeHead(200, json).end(JSON.stringify(list)); return;
    }
    const f = join(LOCAL, name);
    if (/^[\w.-]+\.json$/.test(name) && !name.startsWith('.') && existsSync(f)) { res.writeHead(200, json); createReadStream(f).pipe(res); return; }
    res.writeHead(404).end('not found'); return;
  }
  if (p === '/') p = existsSync(join(ROOT, 'home.html')) ? '/home.html' : '/index.html';
  if (p.split('/').some(seg => seg.startsWith('.'))) { res.writeHead(404).end('not found'); return; }   // no dotfiles (.git, .env…)
  const file = normalize(join(ROOT, p));
  if ((file !== ROOT && !file.startsWith(ROOT + sep)) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return; }
  const size = statSync(file).size, type = TYPES[extname(file)] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache' });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
  }
}).listen(PORT, HOST, () => console.log(`serving ${ROOT} on http://${HOST}:${PORT}/`));
