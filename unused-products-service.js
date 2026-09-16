function arrayData(response) {
  return Array.isArray(response?.data?.data) ? response.data.data : [];
}

function isoDate(date) { return date.toISOString().slice(0, 10); }

function productBalance(product) {
  const value = product?.estoque?.saldoVirtualTotal ?? product?.estoque?.saldoFisicoTotal ?? 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function orderItems(detail) {
  const order = detail?.data?.data || detail?.data || {};
  return Array.isArray(order.itens) ? order.itens : [];
}

function itemKeys(item) {
  return [item?.produto?.id, item?.produto?.codigo, item?.codigo].map(value => String(value || '').trim()).filter(Boolean);
}

async function fetchPages(blingRequest, pathForPage, maxPages, onProgress) {
  const values = [];
  for (let page = 1; page <= maxPages; page++) {
    const response = await blingRequest('GET', pathForPage(page));
    const chunk = arrayData(response);
    values.push(...chunk);
    onProgress?.(page, chunk.length, values.length);
    if (chunk.length < 100) break;
  }
  return values;
}

async function analyzeUnusedProducts({ blingRequest, days = 90, maxProductPages = 10, maxOrderPages = 5, progress = () => {} }) {
  const safeDays = Math.min(730, Math.max(7, Number(days) || 90));
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - safeDays);
  progress({ stage: 'products', message: 'Carregando produtos do Bling…', current: 0 });
  const products = await fetchPages(blingRequest, page => `/produtos?pagina=${page}&limite=100`, maxProductPages, (page, _size, total) => progress({ stage: 'products', message: `${total} produtos carregados`, current: page, total: maxProductPages }));
  progress({ stage: 'orders', message: 'Localizando vendas do período…', current: 0 });
  const orders = await fetchPages(blingRequest, page => `/pedidos/vendas?dataInicial=${isoDate(start)}&dataFinal=${isoDate(end)}&pagina=${page}&limite=100`, maxOrderPages, (page, _size, total) => progress({ stage: 'orders', message: `${total} pedidos encontrados`, current: page, total: maxOrderPages }));
  const sold = new Map();
  for (let index = 0; index < orders.length; index++) {
    const order = orders[index];
    const response = await blingRequest('GET', `/pedidos/vendas/${order.id}`);
    for (const item of orderItems(response)) {
      for (const key of itemKeys(item)) {
        const previous = sold.get(key) || { quantity: 0, lastSale: '' };
        previous.quantity += Number(item.quantidade || 0);
        const date = String(order.data || order.dataSaida || '').slice(0, 10);
        if (date > previous.lastSale) previous.lastSale = date;
        sold.set(key, previous);
      }
    }
    if (index === orders.length - 1 || index % 10 === 0) progress({ stage: 'details', message: `${index + 1} de ${orders.length} pedidos analisados`, current: index + 1, total: orders.length });
  }
  const analyzed = products.map(product => {
    const keys = [product.id, product.codigo].map(value => String(value || '').trim()).filter(Boolean);
    const sale = keys.map(key => sold.get(key)).find(Boolean) || { quantity: 0, lastSale: '' };
    const balance = productBalance(product);
    const reasons = [];
    if (!sale.quantity) reasons.push(`Sem venda nos últimos ${safeDays} dias`);
    if (balance <= 0) reasons.push('Estoque zerado');
    if (product.situacao && product.situacao !== 'A') reasons.push('Cadastro inativo');
    return { id: Number(product.id), code: String(product.codigo || ''), name: String(product.nome || 'Produto sem nome'), price: Number(product.preco || 0), balance, format: String(product.formato || 'S'), situation: String(product.situacao || ''), soldQuantity: Number(sale.quantity || 0), lastSale: sale.lastSale || null, reasons, candidate: !sale.quantity && balance <= 0 };
  });
  const candidates = analyzed.filter(product => product.candidate);
  return { generatedAt: new Date().toISOString(), days: safeDays, scannedProducts: products.length, scannedOrders: orders.length, truncated: products.length >= maxProductPages * 100 || orders.length >= maxOrderPages * 100, summary: { candidates: candidates.length, neverSoldInPeriod: analyzed.filter(product => product.soldQuantity === 0).length, zeroStock: analyzed.filter(product => product.balance <= 0).length, inactive: analyzed.filter(product => product.situation && product.situation !== 'A').length }, products: candidates };
}

module.exports = { analyzeUnusedProducts, productBalance, orderItems };
