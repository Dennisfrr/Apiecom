const assert = require('assert');
const { executeAutomation, previewAutomation } = require('../automation-engine');

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

async function testPreviewDoesNotWrite() {
  const { calls, deps } = dependencies(async (method, path) => {
    if (method === 'GET' && path.startsWith('/produtos?codigo=030402879')) return { data: { data: [{ id: 50, codigo: '030402879' }] } };
    if (method === 'GET' && path === '/produtos/50') return { data: { data: { id: 50, codigo: '030402879', nome: 'PIJAMA TESTE', marca: 'PUKET', categoria: { id: 77 }, tributacao: { ncm: '6107.21.00' }, midia: { imagens: { externas: [{ link: 'https://img.test/bling.png' }] } }, variacoes: [] } } };
    throw new Error(`Chamada inesperada: ${method} ${path}`);
  });
  deps.catalogSearch = async () => [{ descricao: 'Descrição detalhada. Largura: 20 cm; Altura: 30 cm; Comprimento: 10 cm; Peso líquido: 250 g; Peso bruto: 0,3 kg.', preco: 89.9, precoOriginal: 'R$ 149,90', imagens: ['https://img.test/catalogo-1.png', { link: 'https://img.test/catalogo-2.png' }] }];
  const preview = await previewAutomation({ operation: 'cadastrar-produto', sku: '030402879' }, deps);
  assert.equal(preview.canApprove, true); assert.equal(preview.summary.toCreate, 1); assert.equal(preview.product.ncm, '6107.21.00');
  assert.deepEqual(preview.product.images.slice(0, 2), ['https://img.test/catalogo-1.png', 'https://img.test/catalogo-2.png']);
  assert(preview.product.images.includes('https://img.test/bling.png'));
  assert(preview.product.description.startsWith('Descrição detalhada.'));
  assert.equal(preview.product.dimensions.width, 20); assert.equal(preview.product.dimensions.height, 30); assert.equal(preview.product.dimensions.depth, 10); assert.equal(preview.product.dimensions.netWeight, .25); assert.equal(preview.product.dimensions.grossWeight, .3);
  assert.equal(preview.product.price, 149.9); assert.equal(preview.product.catalogPrice, 149.9); assert.equal(preview.product.linxPrice, 99.9);
  assert(!calls.some(call => ['POST', 'PUT', 'DELETE'].includes(call.method)));
}

async function testApprovedEditsReachBling() {
  let detailReads = 0;
  const { calls, deps } = dependencies(async (method, path) => {
    if (method === 'GET' && path.startsWith('/produtos?codigo=030402879')) return { data: { data: [{ id: 60, codigo: '030402879' }] } };
    if (method === 'GET' && path === '/produtos/60') {
      detailReads++;
      if (detailReads === 1) return { data: { data: { id: 60, codigo: '030402879', nome: 'ANTIGO', preco: 10, categoria: { id: 77 }, tributacao: { ncm: '6107.21.00' }, variacoes: [{ id: 61, codigo: '030402879_ROSA_2', gtin: '7900000000001' }] } } };
      return { data: { data: { id: 60, variacoes: [{ id: 61, codigo: '030402879_ROSA_2', gtin: '7900000000001' }] } } };
    }
    if (method === 'PUT' && path === '/produtos/60') return { data: { data: {} } };
    if (method === 'POST' && path === '/estoques') return { data: { data: {} } };
    throw new Error(`Chamada inesperada: ${method} ${path}`);
  });
  await executeAutomation({ operation: 'cadastrar-produto', sku: '030402879', edits: { name: 'NOVO NOME', description: 'Nova descricao', price: 129.9, ncm: '6108.31.00', categoryId: 88, images: ['https://img.test/principal.png', 'https://img.test/segunda.png'], ignored: 'nao enviar' } }, deps);
  const update = calls.find(call => call.method === 'PUT').body;
  assert.equal(update.nome, 'NOVO NOME'); assert.equal(update.descricaoComplementar, 'Nova descricao'); assert.equal(update.preco, 129.9);
  assert.equal(update.tributacao.ncm, '6108.31.00'); assert.equal(update.categoria.id, 88); assert.equal(update.ignored, undefined);
  assert.deepEqual(update.midia.imagens.imagensURL.map(item => item.link), ['https://img.test/principal.png', 'https://img.test/segunda.png']);
}

async function testKitCreatesMissingComponentsFirst() {
  const calls = [];
  const componentIds = { '111111111': { parent: 101, variation: 111 }, '222222222': { parent: 202, variation: 222 } };
  const deps = {
    colors: { '001': 'AZUL' },
    consultLinx: async sku => ({ Produtos: [{ Referencia: sku, CodigoAuxiliar: `${sku}001UN`, NomeProduto: `PRODUTO ${sku}`, PrecoVenda: 50, Saldo: 3, Codebars: [{ Principal: true, Codebar: `789${sku}` }] }] }),
    blingRequest: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('/produtos?')) return { data: { data: [] } };
      if (method === 'POST' && path === '/produtos' && body.formato === 'V') return { data: { data: { id: componentIds[body.codigo].parent } } };
      if (method === 'GET' && /^\/produtos\/(101|202)$/.test(path)) {
        const entry = Object.values(componentIds).find(value => String(value.parent) === path.split('/').pop());
        return { data: { data: { id: entry.parent, variacoes: [{ id: entry.variation, codigo: path.includes('101') ? '111111111_AZUL_UN' : '222222222_AZUL_UN', gtin: path.includes('101') ? '789111111111' : '789222222222' }] } } };
      }
      if (method === 'POST' && path === '/estoques') return { data: { data: {} } };
      if (method === 'POST' && path === '/produtos' && body.formato === 'S') return { data: { data: { id: 303 } } };
      throw new Error(`Chamada inesperada: ${method} ${path}`);
    },
  };
  const result = await executeAutomation({ operation: 'criar-kit', sku: '111111111_222222222' }, deps);
  const kit = calls.find(call => call.method === 'POST' && call.path === '/produtos' && call.body.formato === 'S');
  assert.deepEqual(kit.body.estrutura.componentes.map(item => item.produto.id), [111, 222]);
  assert.equal(result.createdComponents, 2); assert.equal(result.created, 1);
}

async function testKitPreviewDoesNotWrite() {
  const calls = [];
  const deps = { colors: { '001': 'AZUL' }, consultLinx: async sku => ({ Produtos: [{ Referencia: sku, CodigoAuxiliar: `${sku}001UN`, NomeProduto: `PRODUTO ${sku}`, PrecoVenda: 50, Saldo: 3, Codebars: [{ Principal: true, Codebar: `789${sku}` }] }] }), blingRequest: async (method, path) => { calls.push({ method, path }); return { data: { data: [] } }; } };
  const preview = await previewAutomation({ operation: 'criar-kit', sku: '111111111_222222222' }, deps);
  assert.equal(preview.kind, 'kit'); assert.equal(preview.components.length, 2); assert(preview.components.every(item => item.status === 'missing')); assert.equal(preview.canApprove, true);
  assert(!calls.some(call => ['POST', 'PUT', 'DELETE'].includes(call.method)));
}

(async () => {
  await testNewProduct(); await testExistingGtinPreservesVariation(); await testDuplicateGtinStopsWrites(); await testMissingVariationInheritsParentFiscalData(); await testPreviewDoesNotWrite(); await testApprovedEditsReachBling(); await testKitCreatesMissingComponentsFirst(); await testKitPreviewDoesNotWrite();
  console.log('Motor de automações: identidade, duplicidade e herança fiscal validadas com sucesso.');
})().catch(error => { console.error(error); process.exit(1); });
