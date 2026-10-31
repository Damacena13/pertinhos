'use strict';
// Gera CPFs matematicamente válidos e únicos para os testes (não são CPFs de pessoas reais).
let n = 100000000 + Math.floor(Math.random() * 1e6);
function nextCpf() {
  const d = String(++n).padStart(9, '0').split('').map(Number);
  for (const len of [9, 10]) {
    let s = 0; for (let i = 0; i < len; i++) s += d[i] * (len + 1 - i);
    d.push(((s * 10) % 11) % 10);
  }
  return d.join('');
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('close', resolve);
    child.kill();
  });
}
module.exports = { nextCpf, stopChild };
