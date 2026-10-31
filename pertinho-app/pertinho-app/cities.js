'use strict';
// [nome, UF, latitude, longitude] do centro de cada cidade.
const RAW = [
  ['São José do Rio Preto', 'SP', -20.8197, -49.3794], ['São Paulo', 'SP', -23.5505, -46.6333],
  ['Campinas', 'SP', -22.9099, -47.0626], ['Ribeirão Preto', 'SP', -21.1775, -47.8103],
  ['Santos', 'SP', -23.9608, -46.3336], ['Sorocaba', 'SP', -23.5015, -47.4526],
  ['Bauru', 'SP', -22.3147, -49.0606], ['Araçatuba', 'SP', -21.2089, -50.4328],
  ['Votuporanga', 'SP', -20.4231, -49.9728], ['Catanduva', 'SP', -21.1378, -48.9728],
  ['Mirassol', 'SP', -20.8167, -49.5206], ['Birigui', 'SP', -21.2889, -50.34],
  ['Presidente Prudente', 'SP', -22.1256, -51.3889], ['Marília', 'SP', -22.2139, -49.9456],
  ['São Carlos', 'SP', -22.0087, -47.8909], ['Piracicaba', 'SP', -22.7253, -47.6492],
  ['Jundiaí', 'SP', -23.1857, -46.8978], ['Guarulhos', 'SP', -23.4543, -46.5333],
  ['Rio de Janeiro', 'RJ', -22.9068, -43.1729], ['Niterói', 'RJ', -22.8832, -43.1034],
  ['Petrópolis', 'RJ', -22.505, -43.1789], ['Campos dos Goytacazes', 'RJ', -21.7545, -41.3244],
  ['Belo Horizonte', 'MG', -19.9167, -43.9345], ['Uberlândia', 'MG', -18.9186, -48.2772],
  ['Uberaba', 'MG', -19.7472, -47.9319], ['Juiz de Fora', 'MG', -21.7642, -43.3503],
  ['Montes Claros', 'MG', -16.7282, -43.8578], ['Contagem', 'MG', -19.9319, -44.0539],
  ['Vitória', 'ES', -20.3155, -40.3128], ['Vila Velha', 'ES', -20.3297, -40.2925],
  ['Curitiba', 'PR', -25.4284, -49.2733], ['Londrina', 'PR', -23.3045, -51.1696],
  ['Maringá', 'PR', -23.4205, -51.9331], ['Foz do Iguaçu', 'PR', -25.5163, -54.5854],
  ['Florianópolis', 'SC', -27.5954, -48.548], ['Joinville', 'SC', -26.3045, -48.8487],
  ['Blumenau', 'SC', -26.9194, -49.0661], ['Porto Alegre', 'RS', -30.0346, -51.2177],
  ['Caxias do Sul', 'RS', -29.1678, -51.1794], ['Pelotas', 'RS', -31.7654, -52.3376],
  ['Brasília', 'DF', -15.7939, -47.8828], ['Goiânia', 'GO', -16.6869, -49.2648],
  ['Anápolis', 'GO', -16.3281, -48.9534], ['Cuiabá', 'MT', -15.601, -56.0974],
  ['Campo Grande', 'MS', -20.4697, -54.6201], ['Salvador', 'BA', -12.9777, -38.5016],
  ['Feira de Santana', 'BA', -12.2664, -38.9663], ['Vitória da Conquista', 'BA', -14.8615, -40.8442],
  ['Recife', 'PE', -8.0476, -34.877], ['Olinda', 'PE', -8.0089, -34.8553],
  ['Caruaru', 'PE', -8.276, -35.9819], ['Fortaleza', 'CE', -3.7319, -38.5267],
  ['Natal', 'RN', -5.7945, -35.211], ['João Pessoa', 'PB', -7.1195, -34.845],
  ['Maceió', 'AL', -9.6498, -35.7089], ['Aracaju', 'SE', -10.9472, -37.0731],
  ['Teresina', 'PI', -5.0892, -42.8019], ['São Luís', 'MA', -2.5307, -44.3068],
  ['Belém', 'PA', -1.4558, -48.4902], ['Manaus', 'AM', -3.119, -60.0217],
  ['Palmas', 'TO', -10.1689, -48.3317], ['Porto Velho', 'RO', -8.7612, -63.9004],
  ['Rio Branco', 'AC', -9.9747, -67.8243], ['Macapá', 'AP', 0.0349, -51.0694],
  ['Boa Vista', 'RR', 2.8235, -60.6758],
];

function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const CITIES = RAW.map(([name, uf, lat, lng]) => ({ id: `${slug(name)}-${uf.toLowerCase()}`, name, uf, lat, lng }));
const BY_ID = new Map(CITIES.map((c) => [c.id, c]));

module.exports = { CITIES, byId: (id) => BY_ID.get(id) };
