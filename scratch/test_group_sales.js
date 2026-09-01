'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GroupSalesStore } = require('../group-sales-store');
const { GroupSalesEngine } = require('../group-sales-engine');

const file = path.join(__dirname, 'group_sales.test.json');
for (const candidate of [file, `${file}.tmp`]) if (fs.existsSync(candidate)) fs.unlinkSync(candidate);

const offer = {
  id: 'OFR-TESTE', name: 'Oferta de teste', status: 'publicada',
  items: [
    { id: 'ITEM-1', sku: 'SKU001', name: 'Meia teste', price: 39.9, image: '' },
    { id: 'ITEM-2', sku: 'SKU002', name: 'Pijama teste', price: 99.9, image: '' },
  ],
};

(async () => {
  try {
    const store = new GroupSalesStore(file);
    const engine = new GroupSalesEngine({
      store, getOffer: id => id === offer.id ? offer : null,
      checkStock: async () => ({ available: 5, duplicate: false }),
      publicBaseUrl: 'https://localhost:3030',
    });

    let result = await engine.start({ phone: '5511999999999', offerId: offer.id, itemId: 'ITEM-1' });
    assert.equal(result.state, 'OFERTA_IDENTIFICADA');
    result = await engine.handle({ phone: '5511999999999', text: '1' });
    assert.equal(result.state, 'ESCOLHENDO_QUANTIDADE');
    result = await engine.handle({ phone: '5511999999999', text: '2' });
    assert.equal(result.state, 'ESCOLHENDO_ENTREGA');
    result = await engine.handle({ phone: '5511999999999', text: '1' });
    assert.equal(result.state, 'REVISANDO_CARRINHO');
    result = await engine.handle({ phone: '5511999999999', text: '1' });
    assert.equal(result.state, 'CHECKOUT_GERADO');
    assert.match(result.checkoutUrl, /\/checkout\/[a-f0-9]+$/);

    const token = result.checkoutUrl.split('/').pop();
    const checkout = store.getCheckout(token);
    assert.equal(checkout.quantity, 2);
    assert.equal(checkout.subtotal, 79.8);
    assert.equal(store.confirmCheckout(token).status, 'confirmado_teste');
    assert.equal(store.confirmCheckout(token).status, 'confirmado_teste');
    const metrics = store.metrics();
    assert.equal(metrics.totals.conversations, 1);
    assert.equal(metrics.totals.checkouts, 1);
    assert.equal(metrics.totals.confirmedCheckouts, 1);
    assert.equal(metrics.totals.confirmedValue, 79.8);
    assert.ok(store.listEvents(5).length > 0);

    result = await engine.start({ phone: '5511888888888', offerId: offer.id });
    result = await engine.handle({ phone: '5511888888888', text: '1' });
    assert.equal(result.state, 'ESCOLHENDO_PRODUTO');
    assert.match(result.reply, /Meia teste/);
    console.log('Agente comercial do grupo: fluxo do MVP validado com sucesso.');
  } finally {
    for (const candidate of [file, `${file}.tmp`]) if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
