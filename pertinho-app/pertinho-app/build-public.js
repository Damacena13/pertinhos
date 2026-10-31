'use strict';
// Gera public-dist: o mesmo site com os JavaScripts minificados e embaralhados e sem comentários.
// Não impede ninguém de ler o que o navegador baixa (isso é impossível), mas desencoraja cópia casual.
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');
const SRC = path.join(__dirname, 'public'), OUT = path.join(__dirname, 'public-dist');
fs.rmSync(OUT, { recursive: true, force: true });
(async () => {
  let before = 0, after = 0;
  const walk = async (dir, rel = '') => {
    fs.mkdirSync(path.join(OUT, rel), { recursive: true });
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { await walk(dir, r); continue; }
      let buf = fs.readFileSync(path.join(dir, r));
      if (e.name.endsWith('.js')) {
        const src = buf.toString('utf8'); before += src.length;
        const out = await minify(src, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
        if (out.error || !out.code) throw new Error('falha ao minificar ' + r);
        buf = Buffer.from(out.code); after += buf.length;
      } else if (e.name.endsWith('.css')) {
        buf = Buffer.from(buf.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
      }
      fs.writeFileSync(path.join(OUT, r), buf);
    }
  };
  await walk(SRC);
  console.log(`public-dist pronto: JavaScript ${before} -> ${after} bytes`);
})().catch((e) => { console.error(e); process.exit(1); });
