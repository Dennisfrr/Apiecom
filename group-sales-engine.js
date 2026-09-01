'use strict';

function money(value) { return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function normalize(text) { return String(text || '').trim().toUpperCase(); }

class GroupSalesEngine {
  constructor({ store, getOffer, checkStock, publicBaseUrl }) {
    this.store = store;
    this.getOffer = getOffer;
    this.checkStock = checkStock;
    this.publicBaseUrl = String(publicBaseUrl || '').replace(/\/$/, '');
  }

  menu(offer, selected) {
    return [
      `Olá! Encontrei a oferta *${offer.name}*.`,
      selected ? `Você escolheu *${selected.name}* — ${money(selected.price)}.` : '',
      '', '1. Comprar este produto', '2. Ver todos os produtos da oferta', '3. Tirar uma dúvida', '9. Falar com atendente', '0. Encerrar',
    ].filter(Boolean).join('\n');
  }

  async start({ phone, offerId, itemId }) {
    const offer = this.getOffer(offerId);
    if (!offer) throw new Error('Oferta indisponível.');
    const selected = itemId ? offer.items.find(item => item.id === itemId) : null;
    if (itemId && !selected) throw new Error('Produto não pertence à oferta.');
    this.store.start(phone, offer.id, selected?.id || null);
    return { reply: this.menu(offer, selected), state: 'OFERTA_IDENTIFICADA' };
  }

  async handle({ phone, text }) {
    const conversation = this.store.getConversation(phone);
    if (!conversation) throw new Error('Abra uma oferta do grupo para iniciar o atendimento.');
    const offer = this.getOffer(conversation.offerId);
    if (!offer) throw new Error('Esta oferta não está mais disponível.');
    const input = normalize(text);
    if (input === 'MENU') {
      const selected = offer.items.find(item => item.id === conversation.itemId);
      this.store.update(phone, { state: 'OFERTA_IDENTIFICADA' });
      return { reply: this.menu(offer, selected), state: 'OFERTA_IDENTIFICADA' };
    }
    if (['0', 'SAIR', 'CANCELAR'].includes(input)) {
      this.store.update(phone, { state: 'ENCERRADA' });
      return { reply: 'Atendimento encerrado. Quando quiser voltar, abra novamente uma oferta do grupo.', state: 'ENCERRADA' };
    }
    if (['9', 'ATENDENTE'].includes(input)) {
      this.store.update(phone, { state: 'AGUARDANDO_ATENDENTE' });
      this.store.event('human_handoff', { phone: conversation.phone, offerId: offer.id, itemId: conversation.itemId });
      return { reply: 'Certo. Registrei seu pedido para uma atendente continuar por aqui.', state: 'AGUARDANDO_ATENDENTE', handoff: true };
    }

    if (conversation.state === 'OFERTA_IDENTIFICADA') {
      if (input === '2') {
        this.store.update(phone, { state: 'ESCOLHENDO_PRODUTO' });
        return { reply: ['Escolha um produto:', ...offer.items.slice(0, 9).map((item, index) => `${index + 1}. ${item.name} — ${money(item.price)}`), '', '9. Atendente', '0. Encerrar'].join('\n'), state: 'ESCOLHENDO_PRODUTO' };
      }
      if (input === '3') {
        this.store.update(phone, { state: 'AGUARDANDO_DUVIDA' });
        return { reply: 'Digite sua dúvida sobre esta oferta. Se eu não tiver a informação confirmada, encaminharei para uma atendente.', state: 'AGUARDANDO_DUVIDA' };
      }
      if (input !== '1') return { reply: 'Responda com 1, 2, 3, 9 ou 0.', state: conversation.state };
      if (!conversation.itemId && offer.items.length !== 1) {
        this.store.update(phone, { state: 'ESCOLHENDO_PRODUTO' });
        return { reply: ['Escolha um produto:', ...offer.items.slice(0, 9).map((item, index) => `${index + 1}. ${item.name} — ${money(item.price)}`), '', '9. Atendente', '0. Encerrar'].join('\n'), state: 'ESCOLHENDO_PRODUTO' };
      }
      const itemId = conversation.itemId || offer.items[0].id;
      this.store.update(phone, { itemId, state: 'ESCOLHENDO_QUANTIDADE' });
      return { reply: 'Quantas unidades você deseja?\n\n1. Uma\n2. Duas\n3. Três\n4. Outra quantidade\n8. Voltar\n9. Atendente\n0. Encerrar', state: 'ESCOLHENDO_QUANTIDADE' };
    }

    if (conversation.state === 'ESCOLHENDO_PRODUTO') {
      const index = Number(input) - 1;
      const item = offer.items[index];
      if (!item) return { reply: `Escolha um número de 1 a ${Math.min(offer.items.length, 9)}.`, state: conversation.state };
      this.store.update(phone, { itemId: item.id, state: 'ESCOLHENDO_QUANTIDADE' });
      this.store.event('product_selected', { phone: conversation.phone, offerId: offer.id, itemId: item.id });
      return { reply: `Você escolheu *${item.name}*.\n\nQuantas unidades?\n1. Uma\n2. Duas\n3. Três\n4. Outra quantidade\n8. Voltar\n9. Atendente\n0. Encerrar`, state: 'ESCOLHENDO_QUANTIDADE' };
    }

    if (conversation.state === 'ESCOLHENDO_QUANTIDADE') {
      if (input === '8') { this.store.update(phone, { state: 'OFERTA_IDENTIFICADA' }); return { reply: this.menu(offer, offer.items.find(item => item.id === conversation.itemId)), state: 'OFERTA_IDENTIFICADA' }; }
      if (input === '4') { this.store.update(phone, { state: 'QUANTIDADE_LIVRE' }); return { reply: 'Digite a quantidade desejada (de 1 a 20).', state: 'QUANTIDADE_LIVRE' }; }
      if (!['1', '2', '3'].includes(input)) return { reply: 'Responda com 1, 2, 3, 4, 8, 9 ou 0.', state: conversation.state };
      return this.setQuantity(phone, offer, Number(input));
    }

    if (conversation.state === 'QUANTIDADE_LIVRE') {
      const quantity = Number(input);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return { reply: 'Digite uma quantidade inteira entre 1 e 20.', state: conversation.state };
      return this.setQuantity(phone, offer, quantity);
    }

    if (conversation.state === 'ESCOLHENDO_ENTREGA') {
      if (input === '1') {
        this.store.update(phone, { delivery: 'retirada', state: 'REVISANDO_CARRINHO' });
        return this.review(phone, offer);
      }
      if (input === '2') {
        this.store.update(phone, { state: 'AGUARDANDO_ATENDENTE' });
        this.store.event('shipping_handoff', { phone: conversation.phone, offerId: offer.id, itemId: conversation.itemId });
        return { reply: 'Uma atendente vai calcular o frete e continuar com você. Nada foi cobrado.', state: 'AGUARDANDO_ATENDENTE', handoff: true };
      }
      return { reply: 'Escolha 1 para retirada ou 2 para entrega.', state: conversation.state };
    }

    if (conversation.state === 'REVISANDO_CARRINHO') {
      if (input === '1') {
        const current = this.store.getConversation(phone);
        const item = offer.items.find(candidate => candidate.id === current.itemId);
        await this.ensureStock(item, current.quantity);
        const checkout = this.store.createCheckout(current, item);
        return { reply: `Seu checkout de teste está pronto:\n${this.publicBaseUrl}/checkout/${checkout.token}\n\nNenhum pagamento ou pedido no Bling será criado neste MVP.`, state: 'CHECKOUT_GERADO', checkoutUrl: `${this.publicBaseUrl}/checkout/${checkout.token}` };
      }
      if (input === '2') { this.store.update(phone, { state: 'ESCOLHENDO_QUANTIDADE' }); return { reply: 'Informe novamente:\n1. Uma\n2. Duas\n3. Três\n4. Outra quantidade', state: 'ESCOLHENDO_QUANTIDADE' }; }
      return { reply: 'Responda 1 para gerar o checkout, 2 para alterar ou 0 para cancelar.', state: conversation.state };
    }

    if (conversation.state === 'AGUARDANDO_DUVIDA') {
      this.store.update(phone, { state: 'AGUARDANDO_ATENDENTE' });
      this.store.event('question_handoff', { phone: conversation.phone, offerId: offer.id, itemId: conversation.itemId, message: String(text).slice(0, 500) });
      return { reply: 'Recebi sua dúvida e encaminhei para uma atendente. Ela continuará por aqui.', state: 'AGUARDANDO_ATENDENTE', handoff: true };
    }

    if (conversation.state === 'CHECKOUT_GERADO') return { reply: `Seu checkout continua disponível em ${this.publicBaseUrl}/checkout/${conversation.checkoutToken}\nDigite MENU para recomeçar.`, state: conversation.state };
    return { reply: 'Digite MENU para ver as opções ou ATENDENTE para falar com uma pessoa.', state: conversation.state };
  }

  async ensureStock(item, quantity) {
    const stock = await this.checkStock(item.sku);
    if (stock.duplicate) throw new Error('Este produto precisa de revisão no cadastro antes da venda.');
    if (!Number.isFinite(stock.available) || stock.available < quantity) throw new Error(`Estoque insuficiente para ${item.name}.`);
  }

  async setQuantity(phone, offer, quantity) {
    const conversation = this.store.getConversation(phone);
    const item = offer.items.find(candidate => candidate.id === conversation.itemId);
    if (!item) throw new Error('Escolha um produto antes da quantidade.');
    await this.ensureStock(item, quantity);
    this.store.update(phone, { quantity, state: 'ESCOLHENDO_ENTREGA' });
    return { reply: `Temos ${quantity} unidade(s) disponível(is). Como deseja receber?\n\n1. Retirar na loja\n2. Entrega (frete calculado por atendente)\n9. Atendente\n0. Encerrar`, state: 'ESCOLHENDO_ENTREGA' };
  }

  review(phone, offer) {
    const conversation = this.store.getConversation(phone);
    const item = offer.items.find(candidate => candidate.id === conversation.itemId);
    return { reply: `Revise seu carrinho:\n\n${item.name}\nQuantidade: ${conversation.quantity}\nSubtotal: ${money(item.price * conversation.quantity)}\nEntrega: retirada na loja\n\n1. Gerar checkout de teste\n2. Alterar quantidade\n9. Atendente\n0. Cancelar`, state: 'REVISANDO_CARRINHO' };
  }
}

module.exports = { GroupSalesEngine };
