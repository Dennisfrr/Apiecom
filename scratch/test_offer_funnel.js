'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { OfferFunnelStore } = require('../offer-funnel-store');

const file = path.join(__dirname, 'offer_funnel.test.json');
for (const candidate of [file, `${file}.tmp`]) {
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

try {
  const store = new OfferFunnelStore(file);
  const offer = store.createOffer({
    name: 'Oferta teste',
    cluster: 'Meias',
    campaign: 'Campanha teste',
    groupId: '120000000000@g.us',
    message: 'Oferta aprovada pela equipe.',
    items: [{ sku: 'SKU001', name: 'Meia teste', price: 39.9, options: ['23-28'] }],
  });
  assert.equal(offer.status, 'rascunho');
  store.setOfferStatus(offer.id, 'aprovada', [{ sku: 'SKU001', valid: true }]);
  const queued = store.queuePublication(offer.id);
  assert.equal(store.nextPublication().entry.id, queued.id);
  store.finishPublication(queued.id, true);
  assert.equal(store.getPublicOffer(offer.id).status, 'publicada');

  const leadResult = store.startPrivate({ phone: '5511999999999', offerId: offer.id, itemId: offer.items[0].id });
  store.updateLead('5511999999999', { preferences: { categoria: 'Meias', tamanho: '23-28' } });
  store.addEvent('offer_clicked', { offerId: offer.id, itemId: offer.items[0].id });
  store.addEvent('purchase_confirmed', { offerId: offer.id, itemId: offer.items[0].id, leadId: leadResult.lead.id, value: 39.9, margin: 15 });
  const metrics = store.metrics();
  assert.equal(metrics.totals.offers, 1);
  assert.equal(metrics.totals.leads, 1);
  assert.equal(metrics.totals.clicks, 1);
  assert.equal(metrics.totals.privateStarts, 1);
  assert.equal(metrics.totals.purchases, 1);
  assert.equal(metrics.totals.revenue, 39.9);
  assert.equal(store.findLeadByPhone('5511999999999').preferences.tamanho, '23-28');
  console.log('Funil de ofertas: teste concluído com sucesso.');
} finally {
  for (const candidate of [file, `${file}.tmp`]) {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}
