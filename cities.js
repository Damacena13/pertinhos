'use strict';
// Todos os municípios do Brasil (IBGE): [nome, UF, latitude, longitude] do centro de cada um. Dados em cities-data.json.
const RAW = require('./cities-data.json');

function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const UFS = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás',
  MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco',
  PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina',
  SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};
const CITIES = RAW.map(([name, uf, lat, lng]) => ({ id: `${slug(name)}-${uf.toLowerCase()}`, name, uf, lat, lng }));
const BY_ID = new Map(CITIES.map((c) => [c.id, c]));

module.exports = { CITIES, UFS, byId: (id) => BY_ID.get(id) };
