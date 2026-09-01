'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BlingEventStore } = require('../bling-event-store');

const testFile = path.join(__dirname, 'bling_events_test.json');
for (const file of [testFile, `${testFile}.tmp`]) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

try {
  const store = new BlingEventStore(testFile);
  const payload = {
    eventId: 'evt-stock-1',
    date: '2026-08-05T12:00:00Z',
    version: 'v1',
    event: 'virtual_stock.updated',
    companyId: 'company-test',
    data: {
      produto: { id: 12345 },
      saldoFisicoTotal: 7,
      saldoVirtualTotal: 5,
      depositos: [{ id: 1, saldoFisico: 7, saldoVirtual: 5 }],
    },
  };

  const first = store.ingest(payload);
  assert.strictEqual(first.duplicate, false);
  const duplicate = store.ingest(payload);
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(store.health().totalEvents, 1);
  assert.strictEqual(store.list({ resource: 'virtual_stock' }).events.length, 1);
  assert.strictEqual(store.eventsForProduct('12345').events[0].data.saldoVirtualTotal, 5);

  const reloaded = new BlingEventStore(testFile);
  assert.strictEqual(reloaded.health().totalEvents, 1);
  console.log('Eventos do Bling: teste concluído com sucesso.');
} finally {
  for (const file of [testFile, `${testFile}.tmp`]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
