const assert = require('assert');
const { executeAutomation } = require('../automation-engine');
const linx = { Produtos: [{ Referencia: '030402879', CodigoAuxiliar: '0304028791452', NomeProduto: 'PIJAMA TESTE ROSA 2', PrecoVenda: 99.9, Saldo: 4, Codebars: [{ Principal: true, Codebar: '7900000000001' }] }] };
const calls = [];
const deps = {
  colors: { 145: 'ROSA' }, consultLinx: async () => linx,
  blingRequest: async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/produtos?')) return { data: { data: [] } };
    if (method === 'POST' && path === '/produtos') return { data: { data: { id: 10 } } };
    if (method === 'GET' && path === '/produtos/10') return { data: { data: { id: 10, codigo: '030402879', variacoes: [{ id: 11, codigo: '030402879_ROSA_2' }] } } };
    if (method === 'POST' && path === '/estoques') return { data: { data: {} } };
    throw new Error(`Chamada inesperada: ${method} ${path}`);
  },
};
(async () => {
  const result = await executeAutomation({ operation: 'cadastrar-produto', sku: '030402879' }, deps);
  assert.equal(result.parentSku, '030402879'); assert.equal(result.created, 1); assert.equal(result.stockUpdated, 1);
  assert(calls.some(call => call.method === 'POST' && call.path === '/produtos'));
  assert(calls.some(call => call.method === 'POST' && call.path === '/estoques'));
  console.log('Motor de automações: fluxo de produto validado com sucesso.');
})().catch(error => { console.error(error); process.exit(1); });
