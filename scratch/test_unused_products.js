const assert = require('assert');
const { analyzeUnusedProducts } = require('../unused-products-service');

async function run() {
  const calls = [];
  const blingRequest = async (_method, path) => {
    calls.push(path);
    if (path.startsWith('/produtos?')) return { data: { data: [{ id: 1, codigo: 'PARADO', nome: 'Produto parado', preco: 10, situacao: 'A', formato: 'S', estoque: { saldoVirtualTotal: 0 } }, { id: 2, codigo: 'VENDIDO', nome: 'Produto vendido', preco: 20, situacao: 'A', formato: 'S', estoque: { saldoVirtualTotal: 0 } }] } };
    if (path.startsWith('/pedidos/vendas?')) return { data: { data: [{ id: 20, data: '2026-09-10' }] } };
    if (path === '/pedidos/vendas/20') return { data: { data: { itens: [{ produto: { id: 2, codigo: 'VENDIDO' }, quantidade: 1 }] } } };
    throw new Error(`Caminho inesperado: ${path}`);
  };
  const result = await analyzeUnusedProducts({ blingRequest, days: 90 });
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].code, 'PARADO');
  assert.equal(result.summary.candidates, 1);
  assert(calls.some(path => path === '/pedidos/vendas/20'));
  console.log('Análise de produtos parados validada.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
