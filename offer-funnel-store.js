'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENT_LIMIT = 50000;
const ALLOWED_OFFER_STATUS = new Set(['rascunho', 'aprovada', 'rejeitada', 'na_fila', 'publicada', 'encerrada']);

function nowIso() { return new Date().toISOString(); }
function cleanText(value, max = 500) { return String(value || '').trim().slice(0, max); }
function cleanPhone(value) { return String(value || '').replace(/\D/g, '').slice(-15); }
function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function id(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

class OfferFunnelStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, 'offer_funnel.json');
    this.state = { offers: [], leads: [], events: [], publicationQueue: [] };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.state = {
        offers: Array.isArray(parsed.offers) ? parsed.offers : [],
        leads: Array.isArray(parsed.leads) ? parsed.leads : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        publicationQueue: Array.isArray(parsed.publicationQueue) ? parsed.publicationQueue : [],
      };
    } catch (error) {
      console.error('[FUNIL] Falha ao carregar dados:', error.message);
    }
  }

  save() {
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.filePath);
  }

  addEvent(type, data = {}) {
    const event = {
      id: id('EVT'),
      type: cleanText(type, 80),
      occurredAt: nowIso(),
      offerId: cleanText(data.offerId, 80) || null,
      itemId: cleanText(data.itemId, 80) || null,
      leadId: cleanText(data.leadId, 80) || null,
      groupId: cleanText(data.groupId, 120) || null,
      campaign: cleanText(data.campaign, 120) || null,
      value: number(data.value, 0),
      margin: number(data.margin, 0),
      metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    };
    this.state.events.push(event);
    if (this.state.events.length > EVENT_LIMIT) this.state.events.splice(0, this.state.events.length - EVENT_LIMIT);
    this.save();
    return event;
  }

  normalizeItems(items) {
    if (!Array.isArray(items) || !items.length) throw new Error('A oferta precisa ter pelo menos um produto.');
    return items.map((item, index) => {
      const sku = cleanText(item.sku, 100);
      const name = cleanText(item.name || item.nome, 180);
      if (!sku || !/^[A-Za-z0-9._-]+$/.test(sku)) throw new Error(`SKU inválido no produto ${index + 1}.`);
      if (!name) throw new Error(`Informe o nome do produto ${index + 1}.`);
      const price = number(item.price ?? item.preco, -1);
      if (price < 0) throw new Error(`Preço inválido no produto ${index + 1}.`);
      return {
        id: cleanText(item.id, 80) || id('ITEM'),
        sku,
        name,
        price,
        image: cleanText(item.image || item.imagem, 1200),
        description: cleanText(item.description || item.descricao, 500),
        options: Array.isArray(item.options) ? item.options.map(option => cleanText(option, 80)).filter(Boolean).slice(0, 30) : [],
      };
    });
  }

  createOffer(input = {}) {
    const name = cleanText(input.name || input.nome, 180);
    const cluster = cleanText(input.cluster, 100);
    const message = cleanText(input.message || input.mensagem, 3500);
    const groupId = cleanText(input.groupId || input.grupoId, 120);
    if (!name || !cluster || !message || !groupId) throw new Error('Nome, cluster, mensagem e grupo são obrigatórios.');
    const offer = {
      id: id('OFR'),
      name,
      cluster,
      subcluster: cleanText(input.subcluster, 100),
      campaign: cleanText(input.campaign || input.campanha, 120),
      groupId,
      message,
      validUntil: input.validUntil || input.validade || null,
      status: 'rascunho',
      items: this.normalizeItems(input.items || input.produtos),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      approvedAt: null,
      publishedAt: null,
      stockValidation: [],
    };
    this.state.offers.push(offer);
    this.save();
    this.addEvent('offer_created', { offerId: offer.id, groupId, campaign: offer.campaign, metadata: { cluster } });
    return offer;
  }

  listOffers(status) {
    return this.state.offers
      .filter(offer => !status || offer.status === status)
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  getOffer(offerId) {
    return this.state.offers.find(offer => offer.id === offerId) || null;
  }

  getPublicOffer(offerId) {
    const offer = this.getOffer(offerId);
    if (!offer || !['aprovada', 'na_fila', 'publicada'].includes(offer.status)) return null;
    if (offer.validUntil && Number.isFinite(Date.parse(offer.validUntil)) && Date.parse(offer.validUntil) < Date.now()) return null;
    return {
      id: offer.id,
      name: offer.name,
      cluster: offer.cluster,
      subcluster: offer.subcluster,
      message: offer.message,
      validUntil: offer.validUntil,
      status: offer.status,
      items: offer.items,
    };
  }

  setOfferStatus(offerId, status, stockValidation = []) {
    if (!ALLOWED_OFFER_STATUS.has(status)) throw new Error('Status de oferta inválido.');
    const offer = this.getOffer(offerId);
    if (!offer) throw new Error('Oferta não encontrada.');
    if (status === 'aprovada' && offer.status !== 'rascunho') throw new Error('Somente rascunhos podem ser aprovados.');
    if (status === 'rejeitada' && !['rascunho', 'aprovada'].includes(offer.status)) throw new Error('Esta oferta não pode ser rejeitada agora.');
    offer.status = status;
    offer.updatedAt = nowIso();
    if (status === 'aprovada') {
      offer.approvedAt = nowIso();
      offer.stockValidation = stockValidation;
    }
    this.save();
    this.addEvent(`offer_${status}`, { offerId, groupId: offer.groupId, campaign: offer.campaign });
    return offer;
  }

  queuePublication(offerId) {
    const offer = this.getOffer(offerId);
    if (!offer) throw new Error('Oferta não encontrada.');
    if (offer.status !== 'aprovada') throw new Error('Somente ofertas aprovadas podem ser publicadas.');
    if (offer.validUntil && Number.isFinite(Date.parse(offer.validUntil)) && Date.parse(offer.validUntil) < Date.now()) {
      throw new Error('A oferta está vencida.');
    }
    if (this.state.publicationQueue.some(entry => entry.offerId === offerId && entry.status === 'pendente')) {
      throw new Error('A oferta já está na fila de publicação.');
    }
    const entry = { id: id('PUB'), offerId, status: 'pendente', createdAt: nowIso(), processedAt: null, error: null };
    this.state.publicationQueue.push(entry);
    offer.status = 'na_fila';
    offer.updatedAt = nowIso();
    this.save();
    this.addEvent('offer_queued', { offerId, groupId: offer.groupId, campaign: offer.campaign });
    return entry;
  }

  nextPublication() {
    const entry = this.state.publicationQueue.find(item => item.status === 'pendente');
    if (!entry) return null;
    const offer = this.getOffer(entry.offerId);
    if (!offer) return null;
    return { entry, offer };
  }

  finishPublication(entryId, success, error) {
    const entry = this.state.publicationQueue.find(item => item.id === entryId);
    if (!entry) throw new Error('Publicação não encontrada.');
    const offer = this.getOffer(entry.offerId);
    entry.status = success ? 'publicada' : 'erro';
    entry.processedAt = nowIso();
    entry.error = success ? null : cleanText(error, 1000);
    if (offer) {
      offer.status = success ? 'publicada' : 'aprovada';
      offer.publishedAt = success ? nowIso() : offer.publishedAt;
      offer.updatedAt = nowIso();
    }
    this.save();
    this.addEvent(success ? 'offer_published' : 'offer_publish_failed', {
      offerId: entry.offerId,
      groupId: offer?.groupId,
      campaign: offer?.campaign,
      metadata: success ? {} : { error: entry.error },
    });
    return { entry, offer };
  }

  findLeadByPhone(phone) {
    const normalized = cleanPhone(phone);
    return this.state.leads.find(lead => lead.phone === normalized) || null;
  }

  startPrivate(input = {}) {
    const phone = cleanPhone(input.phone);
    const offer = this.getPublicOffer(cleanText(input.offerId, 80));
    if (!phone) throw new Error('Telefone inválido.');
    if (!offer) throw new Error('Oferta indisponível.');
    const itemId = cleanText(input.itemId, 80);
    if (itemId && !offer.items.some(item => item.id === itemId)) throw new Error('Produto não pertence à oferta.');
    let lead = this.findLeadByPhone(phone);
    if (!lead) {
      lead = {
        id: id('LEAD'),
        phone,
        preferences: {},
        activeOfferId: offer.id,
        activeItemId: itemId || null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        optedOutAt: null,
      };
      this.state.leads.push(lead);
    } else {
      lead.activeOfferId = offer.id;
      lead.activeItemId = itemId || null;
      lead.updatedAt = nowIso();
      lead.optedOutAt = null;
    }
    this.save();
    this.addEvent('private_started', {
      offerId: offer.id,
      itemId: itemId || null,
      leadId: lead.id,
      groupId: this.getOffer(offer.id)?.groupId,
      campaign: this.getOffer(offer.id)?.campaign,
    });
    return { lead, offer };
  }

  updateLead(phone, input = {}) {
    const lead = this.findLeadByPhone(phone);
    if (!lead) throw new Error('Lead não encontrado.');
    const allowed = ['categoria', 'subcategoria', 'faixaEtaria', 'tamanho', 'tema', 'cor', 'faixaPreco', 'ocasiao', 'frequencia'];
    const preferences = input.preferences && typeof input.preferences === 'object' ? input.preferences : {};
    for (const key of allowed) {
      if (preferences[key] !== undefined && preferences[key] !== null && String(preferences[key]).trim()) {
        lead.preferences[key] = cleanText(preferences[key], 120);
      }
    }
    if (input.activeItemId !== undefined) lead.activeItemId = cleanText(input.activeItemId, 80) || null;
    if (input.optedOut) lead.optedOutAt = nowIso();
    lead.updatedAt = nowIso();
    this.save();
    this.addEvent(input.optedOut ? 'lead_opted_out' : 'lead_profile_updated', {
      leadId: lead.id,
      offerId: lead.activeOfferId,
      itemId: lead.activeItemId,
      metadata: { fields: Object.keys(preferences).filter(key => allowed.includes(key)) },
    });
    return lead;
  }

  metrics() {
    const count = type => this.state.events.filter(event => event.type === type).length;
    const purchases = this.state.events.filter(event => event.type === 'purchase_confirmed');
    const byCluster = {};
    for (const offer of this.state.offers) {
      const events = this.state.events.filter(event => event.offerId === offer.id);
      const bucket = byCluster[offer.cluster] || { offers: 0, clicks: 0, privateStarts: 0, purchases: 0, revenue: 0, margin: 0 };
      bucket.offers += 1;
      bucket.clicks += events.filter(event => event.type === 'offer_clicked').length;
      bucket.privateStarts += events.filter(event => event.type === 'private_started').length;
      const clusterPurchases = events.filter(event => event.type === 'purchase_confirmed');
      bucket.purchases += clusterPurchases.length;
      bucket.revenue += clusterPurchases.reduce((sum, event) => sum + number(event.value), 0);
      bucket.margin += clusterPurchases.reduce((sum, event) => sum + number(event.margin), 0);
      byCluster[offer.cluster] = bucket;
    }
    return {
      updatedAt: nowIso(),
      totals: {
        offers: this.state.offers.length,
        publishedOffers: this.state.offers.filter(offer => offer.status === 'publicada').length,
        leads: this.state.leads.length,
        clicks: count('offer_clicked'),
        privateStarts: count('private_started'),
        productSelections: count('product_selected'),
        paymentSent: count('payment_sent'),
        purchases: purchases.length,
        revenue: purchases.reduce((sum, event) => sum + number(event.value), 0),
        margin: purchases.reduce((sum, event) => sum + number(event.margin), 0),
      },
      byCluster,
    };
  }
}

module.exports = { OfferFunnelStore, cleanPhone };
