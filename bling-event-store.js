'use strict';

const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 10000;
const ALLOWED_RESOURCES = new Set([
  'order',
  'product',
  'stock',
  'virtual_stock',
  'product_supplier',
  'invoice',
  'consumer_invoice',
]);
const ALLOWED_ACTIONS = new Set(['created', 'updated', 'deleted']);

function text(value, limit = 180) {
  return String(value ?? '').trim().slice(0, limit);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class BlingEventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      events: [],
      latestByResource: {},
      latestByProduct: {},
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.state = {
        events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : [],
        latestByResource: parsed.latestByResource && typeof parsed.latestByResource === 'object' ? parsed.latestByResource : {},
        latestByProduct: parsed.latestByProduct && typeof parsed.latestByProduct === 'object' ? parsed.latestByProduct : {},
        createdAt: parsed.createdAt || new Date().toISOString(),
        updatedAt: parsed.updatedAt || null,
      };
    } catch (error) {
      throw new Error(`Falha ao carregar eventos do Bling: ${error.message}`);
    }
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temporary, this.filePath);
  }

  ingest(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload de webhook inválido.');
    const eventId = text(payload.eventId, 100);
    const eventName = text(payload.event, 80);
    const [resource, action] = eventName.split('.');
    if (!eventId) throw new Error('Webhook sem eventId.');
    if (!ALLOWED_RESOURCES.has(resource) || !ALLOWED_ACTIONS.has(action)) throw new Error(`Evento do Bling não suportado: ${eventName || 'vazio'}.`);

    const duplicate = this.state.events.find(event => event.eventId === eventId);
    if (duplicate) return { accepted: true, duplicate: true, event: clone(duplicate) };

    const now = new Date().toISOString();
    const productId = text(payload.data?.produto?.id || (resource === 'product' ? payload.data?.id : ''), 80) || null;
    const event = {
      eventId,
      event: eventName,
      resource,
      action,
      companyId: text(payload.companyId, 100) || null,
      occurredAt: text(payload.date, 60) || now,
      receivedAt: now,
      productId,
      data: payload.data && typeof payload.data === 'object' ? clone(payload.data) : {},
      processingStatus: 'recebido',
    };

    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    this.state.latestByResource[resource] = {
      eventId,
      event: eventName,
      occurredAt: event.occurredAt,
      receivedAt: now,
    };
    if (productId) {
      this.state.latestByProduct[productId] = {
        eventId,
        event: eventName,
        occurredAt: event.occurredAt,
        receivedAt: now,
        data: event.data,
      };
    }
    this.state.updatedAt = now;
    this.save();
    return { accepted: true, duplicate: false, event: clone(event) };
  }

  list(filters = {}) {
    const resource = text(filters.resource, 40);
    const productId = text(filters.productId, 80);
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
    const events = this.state.events
      .filter(event => !resource || event.resource === resource)
      .filter(event => !productId || event.productId === productId)
      .slice(-limit)
      .reverse();
    return { total: events.length, events: clone(events) };
  }

  eventsForProduct(productId, limit = 20) {
    return this.list({ productId, limit });
  }

  health() {
    const counts = {};
    for (const event of this.state.events) counts[event.resource] = (counts[event.resource] || 0) + 1;
    const lastReceivedAt = this.state.events.length ? this.state.events[this.state.events.length - 1].receivedAt : null;
    return {
      configured: true,
      totalEvents: this.state.events.length,
      lastReceivedAt,
      latestByResource: clone(this.state.latestByResource),
      counts,
      updatedAt: this.state.updatedAt,
    };
  }
}

module.exports = { BlingEventStore, ALLOWED_RESOURCES };
