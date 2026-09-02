const assert = require('assert');
const { executeAutomation } = require('../automation-engine');

const linx = { Produtos: [{ Referencia: '030402879', CodigoAuxiliar: '0304028791452', NomeProduto: 'PIJAMA TESTE ROSA 2', PrecoVenda: 99.9, Saldo: 4, Codebars: [{ Principal: true, Codebar: '7900000000001' }] }] };
function dependencies(handler) {
  const calls = [];
  return { calls, deps: { colors: { 145: 'ROSA' }, consultLinx: async () => linx, blingRequest: async (method, path, body) => { calls.push({ method, path, body }); return handler(method, path, body); } } };
}

async function testNewProduct() {
  const { calls, deps } = dependencies(async (method, path) => {
    if (method === 'GET' && path.startsWith('/produtos?')) return { data: { data: [] } };
    if (method === 'POST' && path === '/produtos') return { data: { data: { id: 10 } } };
    if (method === 'GET' && path === '/produtos/10') return { data: { data: { id: 10, codigo: '030402879', variacoes: [{ id: 11, codigo: '030402879_ROSA_2', gtin: '7900000000001' }] } } };
    if (method === 'POST' && path === '/estoques') return { data: { data: {} } };
    throw new Error(`Chamada inesperada: ${method} ${path}`);
  });
  const result = await executeAutomation({ operation: 'cadastrar-produto', sku: '030402879' }, deps);
  assert.equal(result.created, 1); assert.equal(result.stockUpdated, 1);
  assert(calls.some(call => call.method === 'POST' && call.path === '/produtos'));
}

async function testExistingGtinPreservesVariation() {
  const oldVariation = { id: 21, codigo: '030402879_PINK_2', gtin: '7900000000001' };
  const { calls, deps } = dependencies(async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/produtos?codigo=030402879')) return { data: { data: [{ id: 20, codigo: '030402879' }] } };
    if (method === 'GET' && path === '/produtos/20') return { data: { data: { id: 20, codigo: '030402879', tributacao: { ncm: '6107.21.00' }, categoria: { id: 99 }, variacoes: [oldVariation] } } };
    if (method === 'POST' && path === '/estoques') { assert.equal(body.produto.id, 21); return { data: { data: {} } }; }
    throw new Error(`Chamada inesperada: ${method} ${path}`);
  });
  const result = await executeAutomation({ operation: 'cadastrar-produto', sku: '030402879' }, deps);
  assert.equal(result.created, 0); assert.equal(result.stockUpdated, 1);
  assert(result.warnings.some(value => value.includes('preservada')));
  assert(!calls.some(call => ['POST', 'PUT'].includes(call.method) && call.path.startsWith('/produtos')));
}

async function testDuplicateGtinStopsWrites() {
  const { calls, deps } = dependencies(async (method, path) => {
    if (method === 'GET' && path.startsWith('/produtos?codigo=030402879')) return { data: { data: [{ id: 30, codigo: '030402879' }] } };
    if (method === 'GET' && path === '/produtos/30') return { data: { data: { id: 30, variacoes: [{ id: 31, codigo: '030402879_PINK_2', gtin: '7900000000001' }, { id: 32, codigo: '030402879_ROSA_2', gtin: '7900000000001' }] } } };
    throw new Error(`Chamada inesperada: ${method} ${path}`);
  });
  await assert.rejects(() => executeAutomation({ operation: 'cadastrar-produto', sku: '030402879' }, deps), error => error.step === 'comparando' && error.message.includes('duplicado'));
  assert(!calls.some(call => ['POST', 'PUT'].includes(call.method)));
}

async function testMissingVariationInheritsParentFiscalData() {
  let detailReads = 0;
  const { calls, deps } = dependencies(async (method, path) => {
    if (method === 'GET' && path.startsWith('/produtos?codigo=030402879')) return { data: { data: [{ id: 40, codigo: '030402879' }] } };
    if (method === 'GET' && path === '/produtos/40') {
      detailReads++;
      if (detailReads === 1) return { data: { data: { id: 40, codigo: '030402879', marca: 'PUKET', unidade: 'UN', categoria: { id: 77 }, tributacao: { ncm: '6107.21.00', origem: 0 }, variacoes: [] } } };
      return { data: { data: { id: 40, variacoes: [{ id: 41, codigo: '030402879_ROSA_2', gtin: '7900000000001' }] } } };
    }
    if (method === 'PUT' && path === '/produtos/40') return { data: { data: {} } };
    if (method === 'POST' && path === '/estoques') return { data: { data: {} } };
    throw new Error(`Chamada inesperada: ${method} ${path}`);
  });
  const result = await executeAutomation({ operation: 'cadastrar-produto', sku: '030402879' }, deps);
  const created = calls.find(call => call.method === 'PUT').body.variacoes[0];
  assert.equal(created.tributacao.ncm, '6107.21.00'); assert.equal(created.categoria.id, 77); assert.equal(created.marca, 'PUKET'); assert.equal(result.created, 1);
}

(async () => {
  await testNewProduct(); await testExistingGtinPreservesVariation(); await testDuplicateGtinStopsWrites(); await testMissingVariationInheritsParentFiscalData();
  console.log('Motor de automações: identidade, duplicidade e herança fiscal validadas com sucesso.');
})().catch(error => { console.error(error); process.exit(1); });
