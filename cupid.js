'use strict';
// Cupido: sugere primeiras mensagens a partir do perfil da outra pessoa. Não usa IA externa nem envia nada sozinho:
// quem decide se usa, edita ou ignora a sugestão é a pessoa.
const L = require('./lib');

function pool(me, other, common) {
  const first = String(other.name || '').split(' ')[0];
  const ints = JSON.parse(other.interests || '[]');
  const out = [];
  for (const c of common) out.push(`Vi que nós dois gostamos de ${c}. Como isso começou pra você?`);
  for (const i of ints) {
    out.push(`Vi que você curte ${i}. Qual é a sua melhor história com isso?`);
    out.push(`Se eu perguntar sobre ${i}, você me conta quanto tempo de conversa?`);
  }
  if (other.anthem) {
    out.push(`Que boa a música do seu perfil: "${other.anthem}". Ela tem alguma história?`);
    out.push(`"${other.anthem}" é a trilha ideal de qual momento do seu dia?`);
  }
  const city = String(other.city_name || '').split(' - ')[0];
  if (city && city !== 'Localização por GPS') out.push(`Que lugar de ${city} você levaria alguém que acabou de conhecer?`);
  out.push(`Oi, ${first}! Qual foi a melhor coisa do seu dia até agora?`);
  out.push('Sem pressão: café, sorvete ou caminhada? Qual é o seu tipo de encontro ideal?');
  out.push('Qual é o lugar da região que você nunca enjoa de frequentar?');
  out.push('Me conta uma coisa que te faz rir fácil.');
  return out;
}

// A mesma "semente" dá sempre as mesmas sugestões; mudando a semente, vêm outras.
function icebreakers(me, other, seed, count = 3) {
  const { common } = L.affinity(me, other, null);
  const list = pool(me, other, common);
  const ranked = list.map((text, i) => ({ text, k: L.hash32((Number(seed) || 0) * 7919 + i * 104729 + me.id * 31 + other.id) })).sort((a, b) => a.k - b.k);
  // mantém as mais personalizadas (as primeiras da lista) com mais chance: reforça uma delas no início
  const personal = list.slice(0, Math.max(0, list.length - 4));
  const picked = [];
  if (personal.length) picked.push(personal[L.hash32((Number(seed) || 0) + me.id + other.id) % personal.length]);
  for (const r of ranked) { if (picked.length >= count) break; if (!picked.includes(r.text)) picked.push(r.text); }
  return picked.slice(0, count).map((t) => t.slice(0, 200));
}

const POSES = [
  'Mostre a palma da mão direita aberta ao lado do rosto.',
  'Faça um joinha com a mão esquerda ao lado do rosto.',
  'Faça o sinal de paz (dois dedos) na altura do queixo.',
  'Encoste o dedo indicador na ponta do nariz.',
  'Segure uma folha de papel com a palavra "Pertinho" escrita à mão.',
];

module.exports = { icebreakers, POSES };
