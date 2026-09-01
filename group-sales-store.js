'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }
function cleanPhone(value) { return String(value || '').replace(/\D/g, '').slice(-15); }
function makeId(prefix) { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }

class GroupSalesStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, 'group_sales.json');
    this.state = { conversations: [], checkouts: [], events: [] };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.state = {
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
        checkouts: Array.isArray(parsed.checkouts) ? parsed.checkouts : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch (error) {
      console.error('[VENDAS-GRUPO] Falha ao carregar dados:', error.message);
    }
  }

  save() {
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.filePath);
  }

  event(type, data = {}) {
    const event = { id: makeId('EVT'), type, occurredAt: nowIso(), ...data };
    this.state.events.push(event);
    if (this.state.events.length > 10000) this.state.events.splice(0, this.state.events.length - 10000);
    this.save();
    return event;
  }

  start(phone, offerId, itemId) {
    const normalized = cleanPhone(phone);
    if (!normalized) throw new Error('Telefone inválido.');
    let conversation = this.state.conversations.find(item => item.phone === normalized);
    const base = {
      phone: normalized, offerId, itemId: itemId || null, state: 'OFERTA_IDENTIFICADA',
      quantity: null, delivery: null, checkoutToken: null, updatedAt: nowIso(),
    };
    if (conversation) Object.assign(conversation, base);
    else {
      conversation = { id: makeId('CVS'), createdAt: nowIso(), ...base };
      this.state.conversations.push(conversation);
    }
    this.save();
    this.event('conversation_started', { phone: normalized, offerId, itemId: itemId || null });
    return conversation;
  }

  getConversation(phone) {
    return this.state.conversations.find(item => item.phone === cleanPhone(phone)) || null;
  }

  update(phone, patch = {}) {
    const conversation = this.getConversation(phone);
    if (!conversation) throw new Error('Conversa não iniciada por uma oferta.');
    Object.assign(conversation, patch, { updatedAt: nowIso() });
    this.save();
    return conversation;
  }

  createCheckout(conversation, item) {
    if (conversation.checkoutToken) {
      const existing = this.getCheckout(conversation.checkoutToken);
      if (existing && existing.status === 'aguardando_confirmacao') return existing;
    }
    const quantity = Number(conversation.quantity || 0);
    const checkout = {
      id: makeId('CHK'), token: crypto.randomBytes(18).toString('hex'), phone: conversation.phone,
      offerId: conversation.offerId, itemId: item.id, sku: item.sku, name: item.name,
      image: item.image || '', unitPrice: Number(item.price || 0), quantity,
      subtotal: Number(item.price || 0) * quantity, delivery: conversation.delivery,
      status: 'aguardando_confirmacao', createdAt: nowIso(), confirmedAt: null,
    };
    this.state.checkouts.push(checkout);
    conversation.checkoutToken = checkout.token;
    conversation.state = 'CHECKOUT_GERADO';
    conversation.updatedAt = nowIso();
    this.save();
    this.event('checkout_created', { phone: conversation.phone, offerId: conversation.offerId, itemId: item.id, checkoutId: checkout.id, value: checkout.subtotal });
    return checkout;
  }

  getCheckout(token) { return this.state.checkouts.find(item => item.token === String(token || '')) || null; }

  confirmCheckout(token) {
    const checkout = this.getCheckout(token);
    if (!checkout) throw new Error('Checkout não encontrado.');
    if (checkout.status === 'confirmado_teste') return checkout;
    checkout.status = 'confirmado_teste';
    checkout.confirmedAt = nowIso();
    const conversation = this.getConversation(checkout.phone);
    if (conversation) {
      conversation.state = 'CLIENTE_CONFIRMOU';
      conversation.updatedAt = nowIso();
    }
    this.save();
    this.event('checkout_test_confirmed', { phone: checkout.phone, offerId: checkout.offerId, itemId: checkout.itemId, checkoutId: checkout.id, value: checkout.subtotal });
    return checkout;
  }

  listConversations() { return this.state.conversations.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

  listEvents(limit = 100) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.state.events.slice(-safeLimit).reverse();
  }

  metrics() {
    const byState = this.state.conversations.reduce((result, conversation) => {
      result[conversation.state] = (result[conversation.state] || 0) + 1;
      return result;
    }, {});
    const countEvents = type => this.state.events.filter(event => event.type === type).length;
    const confirmed = this.state.checkouts.filter(checkout => checkout.status === 'confirmado_teste');
    return {
      updatedAt: nowIso(),
      totals: {
        conversations: this.state.conversations.length,
        activeConversations: this.state.conversations.filter(item => !['ENCERRADA', 'CLIENTE_CONFIRMOU'].includes(item.state)).length,
        productSelections: countEvents('product_selected'),
        checkouts: this.state.checkouts.length,
        confirmedCheckouts: confirmed.length,
        handoffs: countEvents('human_handoff') + countEvents('shipping_handoff') + countEvents('question_handoff'),
        confirmedValue: confirmed.reduce((sum, checkout) => sum + Number(checkout.subtotal || 0), 0),
      },
      byState,
    };
  }
}

module.exports = { GroupSalesStore, cleanPhone };
