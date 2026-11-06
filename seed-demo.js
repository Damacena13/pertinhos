'use strict';
// Cria perfis FICTÍCIOS para testar o sistema. Não use em produção.
// Uso: npm run seed:demo
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, UPLOAD_DIR } = require('./db');
const L = require('./lib');
const { byId } = require('./cities');

const NAMES_F = ['Marina', 'Camila', 'Beatriz', 'Júlia', 'Larissa', 'Ana Clara', 'Isabela', 'Fernanda', 'Letícia', 'Bruna', 'Aline', 'Patrícia', 'Renata', 'Carolina', 'Gabriela'];
const NAMES_M = ['Lucas', 'Rafael', 'Thiago', 'Gustavo', 'Pedro', 'Felipe', 'Daniel', 'Bruno', 'Rodrigo', 'André', 'Diego', 'Mateus', 'Vinícius', 'Leonardo', 'Henrique'];
const BIOS = [
  'Café bom e conversa boa resolvem meu domingo.', 'Corro de manhã e cozinho à noite.', 'Procuro alguém para trilhas e festival de música.',
  'Apaixonada por livros usados e sebos.', 'Toco violão mal, mas com muito entusiasmo.', 'Viajo sempre que o orçamento deixa.',
  'Tenho dois cachorros e nenhuma paciência para trânsito.', 'Cinema, pipoca e discussão sobre o final.', 'Cozinho bem, lavo pouca louça.',
  'Sempre com a câmera por perto.', 'Churrasco de domingo é compromisso fixo.', 'Yoga cedo e playlist animada o dia todo.',
];
const SONGS = ['Djavan - Oceano', 'Tim Maia - Azul da Cor do Mar', 'Marisa Monte - Ainda Bem', 'Legião Urbana - Tempo Perdido', 'Anavitória - Trevo', 'Jorge Ben Jor - Mais Que Nada', 'Cazuza - Exagerado', 'Gilberto Gil - Aquele Abraço'];
const TAGS = ['Café', 'Corrida', 'Trilhas', 'Livros', 'Cinema', 'Música ao vivo', 'Viagens', 'Culinária', 'Pets', 'Fotografia', 'Yoga', 'Games'];
const CITY_IDS = [
  ['sao-jose-do-rio-preto-sp', 12], ['mirassol-sp', 4], ['votuporanga-sp', 3], ['catanduva-sp', 3],
  ['sao-paulo-sp', 8], ['campinas-sp', 3], ['rio-de-janeiro-rj', 4], ['belo-horizonte-mg', 3], ['curitiba-pr', 3], ['brasilia-df', 3],
];

function svg(hue, variant) {
  const h2 = (hue + 50) % 360;
  const shapes = [
    '<circle cx="200" cy="170" r="70" fill="rgba(255,255,255,.28)"/><path d="M60 400c0-90 60-140 140-140s140 50 140 140z" fill="rgba(255,255,255,.28)"/>',
    '<path d="M0 400 L110 240 L190 330 L290 190 L400 400Z" fill="rgba(255,255,255,.25)"/><circle cx="300" cy="90" r="34" fill="rgba(255,255,255,.4)"/>',
    '<circle cx="140" cy="160" r="90" fill="rgba(255,255,255,.2)"/><circle cx="270" cy="260" r="120" fill="rgba(255,255,255,.15)"/>',
    '<path d="M0 280 Q100 200 200 280 T400 280 V400 H0Z" fill="rgba(255,255,255,.25)"/><path d="M0 200 Q100 120 200 200 T400 200" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="8"/>',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 46%)"/><stop offset="1" stop-color="hsl(${h2} 60% 26%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/>${shapes[variant % shapes.length]}</svg>`;
}

function savePhoto(userId, hue, variant, isMain) {
  const filename = `${crypto.randomBytes(12).toString('hex')}.svg`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), svg(hue, variant));
  db.prepare('INSERT INTO photos (user_id, filename, mime, is_main, created_at) VALUES (?,?,?,?,?)').run(userId, filename, 'image/svg+xml', isMain ? 1 : 0, Date.now());
}

(async () => {
  if (db.prepare('SELECT COUNT(*) c FROM users WHERE is_demo = 1').get().c > 0) {
    console.log('Os perfis de demonstração já existem. Nada a fazer.');
    return;
  }
  const hash = await L.hashPassword(crypto.randomBytes(24).toString('hex')); // ninguém consegue entrar nessas contas
  let n = 0;
  for (const [cityId, qty] of CITY_IDS) {
    const city = byId(cityId);
    for (let i = 0; i < qty; i++) {
      n++;
      const female = n % 2 === 0;
      const list = female ? NAMES_F : NAMES_M;
      const name = list[(n * 7) % list.length];
      const year = 1984 + ((n * 5) % 17);
      const born = `${year}-${String(1 + (n % 12)).padStart(2, '0')}-${String(1 + ((n * 3) % 27)).padStart(2, '0')}`;
      const tags = [TAGS[n % TAGS.length], TAGS[(n * 3 + 1) % TAGS.length], TAGS[(n * 5 + 2) % TAGS.length]].filter((t, k, a) => a.indexOf(t) === k);
      const info = db
        .prepare(`INSERT INTO users (email, pass_hash, name, birth_date, gender, seeking, bio, interests, city_id, city_name, loc_source, verified, is_demo, terms_at, created_at, last_seen)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`)
        .run(`demo${n}@pertinho.invalid`, hash, name, born, female ? 'f' : 'm', 'all', BIOS[n % BIOS.length], JSON.stringify(tags), city.id, `${city.name} - ${city.uf}`, 'city', n % 4 === 0 ? 0 : 1, Date.now(), Date.now() - n * 3600_000, Date.now() - (n % 9) * 3600_000);
      const id = Number(info.lastInsertRowid);
      if (n % 3 !== 0) db.prepare('UPDATE users SET anthem = ? WHERE id = ?').run(SONGS[n % SONGS.length], id);
      const pt = L.cityPoint(city, id);
      db.prepare('UPDATE users SET lat = ?, lng = ? WHERE id = ?').run(pt.lat, pt.lng, id);
      const hue = (n * 47) % 360;
      savePhoto(id, hue, n, true);
      for (let k = 1; k <= 1 + (n % 3); k++) savePhoto(id, hue + k * 38, n + k, false);
    }
  }
  console.log(`Criados ${n} perfis fictícios (fotos geradas, sem pessoas reais).`);
})();
