const DEFAULT_CATEGORY_ID = Number(process.env.BLING_CATEGORY_ID || 11062477);
const DEFAULT_DEPOSIT_ID = Number(process.env.BLING_DEPOSIT_ID || 14888166814);
const DEFAULT_NCM = String(process.env.BLING_DEFAULT_NCM || '6108.31.00');

function text(value) { return String(value ?? '').trim(); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function pickBarcode(product) {
  const codes = Array.isArray(product.Codebars) ? product.Codebars : [];
  return text(codes.find(item => item?.Principal)?.Codebar || codes[0]?.Codebar || product.Codebar);
}
function description(product) {
  return ['Descricao', 'DescricaoProduto', 'DescricaoCompleta', 'DescricaoDetalhada', 'Detalhes', 'Observacao']
    .map(key => text(product[key])).find(Boolean) || '';
}
function media(urls) {
  const imagensURL = [...new Set(urls)].filter(url => /^https?:\/\//i.test(url)).map(link => ({ link }));
  return imagensURL.length ? { imagens: { imagensURL } } : undefined;
}
function productSpecs(name) {
  const value = text(name).toLowerCase();
  if (value.includes('pijama') || value.startsWith('pj')) return { pesoLiquido: .3, pesoBruto: .3, dimensoes: { largura: 30, altura: 20, profundidade: 20, unidadeMedida: 1 } };
  if (value.includes('lancheira')) return { pesoLiquido: .5, pesoBruto: .6, dimensoes: { largura: 20.5, altura: 25, profundidade: 14.5, unidadeMedida: 1 } };
  if (value.includes('mochila')) return { pesoLiquido: 1, pesoBruto: 1.1, dimensoes: { largura: 32, altura: 43, profundidade: 18, unidadeMedida: 1 } };
  return { pesoLiquido: .2, pesoBruto: .25, dimensoes: { largura: 18, altura: 25, profundidade: 5, unidadeMedida: 1 } };
}

function normalizeLinxProducts(raw, requestedSku, colors) {
  const products = Array.isArray(raw?.Produtos) ? raw.Produtos : Array.isArray(raw) ? raw : [];
  const requested = text(requestedSku).toUpperCase();
  const normalized = products.map(product => {
    const auxiliary = text(product.CodigoAuxiliar);
    const base = auxiliary.slice(0, 12);
    const parentSku = base.length >= 9 ? base.slice(0, 9) : text(product.Referencia || requestedSku);
    const colorCode = base.length >= 12 ? base.slice(9, 12) : '';
    const colorName = text(colors[colorCode] || colorCode);
    const size = text(auxiliary.slice(12) || product.Tamanho || 'UN');
    const barcode = pickBarcode(product);
    const childSku = base.length >= 12
      ? `${parentSku}_${colorName}_${size}`.toUpperCase().replace(/\s+/g, '')
      : text(barcode || auxiliary || product.Referencia);
    return {
      parentSku, childSku, base, colorName, size, barcode,
      name: text(product.NomeProduto || product.DescricaoProduto || parentSku),
      description: description(product),
      price: number(product.PrecoVenda),
      stock: number(product.Saldo),
      image: base ? `https://storage.googleapis.com/cdnportalservicos/Files/B2C2/${base}_1.png` : '',
    };
  }).filter(item => item.parentSku && item.childSku);
  const exactParent = normalized.filter(item => item.parentSku.toUpperCase() === requested || item.base.toUpperCase().startsWith(requested));
  const result = exactParent.length ? exactParent : normalized;
  const unique = new Map();
  result.forEach(item => unique.set(item.childSku, item));
  return [...unique.values()];
}

async function findBlingExact(blingRequest, sku) {
  const queries = [`/produtos?codigo=${encodeURIComponent(sku)}&pagina=1&limite=100`, `/produtos?codigos[]=${encodeURIComponent(sku)}&pagina=1&limite=100`];
  for (const query of queries) {
    try {
      const response = await blingRequest('GET', query);
      const products = Array.isArray(response.data?.data) ? response.data.data : [];
      const exact = products.find(item => [item.codigo, item.gtin, item.gtinTributario].some(value => text(value) === sku));
      if (exact) return exact;
    } catch (_) { /* try documented alternative */ }
  }
  return null;
}

function variationPayload(item, fallbackName, fallbackPrice) {
  const variantName = [fallbackName, item.colorName, item.size].filter(Boolean).join(' ');
  const attribute = `${item.colorName ? `Cor:${item.colorName};` : ''}Tamanho:${item.size}`;
  return {
    nome: variantName, codigo: item.childSku, preco: item.price || fallbackPrice, gtin: item.barcode || undefined,
    situacao: 'A', tipo: 'P', formato: 'S', variacao: { nome: attribute }, tributacao: { ncm: DEFAULT_NCM },
    ...(item.image ? { midia: media([item.image]) } : {}),
  };
}

function parentPayload(parentSku, items) {
  const first = items[0];
  const specs = productSpecs(first.name);
  const images = items.map(item => item.image).filter(Boolean);
  const price = first.price || Math.max(...items.map(item => item.price), 0);
  return {
    nome: first.name, codigo: parentSku, preco: price, tipo: 'P', situacao: 'A', formato: 'V', marca: 'Puket',
    pesoLiquido: specs.pesoLiquido, pesoBruto: specs.pesoBruto, volumes: 1, itensPorCaixa: 1,
    tipoProducao: 'P', tipoEstoque: 'F', condicao: 0, freteGratis: false,
    categoria: { id: DEFAULT_CATEGORY_ID }, dimensoes: specs.dimensoes, tributacao: { ncm: DEFAULT_NCM },
    ...(first.description ? { descricaoComplementar: first.description } : {}),
    ...(images.length ? { midia: media(images) } : {}),
    variacoes: items.map(item => variationPayload(item, first.name, price)),
  };
}

async function loadGroup(sku, deps, progress) {
  progress('linx', 'running');
  const raw = await deps.consultLinx(sku);
  progress('linx', 'done'); progress('produto', 'running');
  const items = normalizeLinxProducts(raw, sku, deps.colors);
  if (!items.length) throw Object.assign(new Error(`O SKU ${sku} não foi encontrado na Linx.`), { step: 'produto' });
  const parentSku = items[0].parentSku;
  progress('produto', 'done'); progress('pai', 'done'); progress('grade', 'done');
  return { parentSku, items };
}

async function ensureProduct(group, deps, progress, updateContent = false) {
  progress('bling', 'running');
  let parent = await findBlingExact(deps.blingRequest, group.parentSku);
  progress('bling', 'done'); progress('comparando', 'running');
  const payload = parentPayload(group.parentSku, group.items);
  let created = 0;
  let existingCount = 0;
  if (!parent) {
    progress('comparando', 'done'); progress('gravando', 'running');
    const response = await deps.blingRequest('POST', '/produtos', payload);
    parent = response.data?.data || response.data;
    created = group.items.length;
  } else {
    const detailResponse = await deps.blingRequest('GET', `/produtos/${parent.id}`);
    const detail = detailResponse.data?.data || detailResponse.data;
    const existing = Array.isArray(detail?.variacoes) ? detail.variacoes : [];
    const existingCodes = new Set(existing.map(item => text(item.codigo)));
    existingCount = group.items.filter(item => existingCodes.has(item.childSku)).length;
    const missing = payload.variacoes.filter(item => !existingCodes.has(item.codigo));
    created = missing.length;
    progress('comparando', 'done'); progress('gravando', 'running');
    if (missing.length || updateContent) {
      const update = { ...detail, ...(updateContent ? payload : {}), codigo: group.parentSku, variacoes: [...existing, ...missing] };
      await deps.blingRequest('PUT', `/produtos/${parent.id}`, update);
    }
  }
  progress('gravando', 'done');
  return { parent, created, existingCount };
}

async function updateStock(group, parentId, deps, progress) {
  progress('estoque', 'running');
  const detailResponse = await deps.blingRequest('GET', `/produtos/${parentId}`);
  const detail = detailResponse.data?.data || detailResponse.data;
  const variations = Array.isArray(detail?.variacoes) ? detail.variacoes : [];
  let updated = 0; const warnings = [];
  for (const item of group.items) {
    const variant = variations.find(value => text(value.codigo) === item.childSku || text(value.gtin) === item.barcode);
    if (!variant?.id) { warnings.push(`Variação ${item.childSku} sem ID no Bling.`); continue; }
    await deps.blingRequest('POST', '/estoques', { produto: { id: variant.id }, deposito: { id: DEFAULT_DEPOSIT_ID }, operacao: 'B', preco: item.price, quantidade: item.stock, observacoes: 'Sincronização automática Puket Cadastro Inteligente' });
    updated++;
  }
  progress('estoque', warnings.length ? 'warning' : 'done');
  return { updated, warnings };
}

async function createKit(sku, deps, progress) {
  const componentSkus = text(sku).split('_').filter(Boolean);
  if (componentSkus.length < 2) throw Object.assign(new Error('Informe pelo menos dois SKUs separados por underline.'), { step: 'produto' });
  progress('linx', 'running');
  const components = [];
  for (const componentSku of componentSkus) {
    const group = await loadGroup(componentSku, deps, () => {});
    const local = group.items.find(item => item.base === componentSku || item.childSku === componentSku || item.barcode === componentSku) || group.items[0];
    const found = await findBlingExact(deps.blingRequest, local.childSku) || await findBlingExact(deps.blingRequest, componentSku);
    if (!found) throw Object.assign(new Error(`O componente ${componentSku} ainda não existe no Bling.`), { step: 'bling' });
    components.push({ local, bling: found });
  }
  progress('linx', 'done'); progress('produto', 'done'); progress('pai', 'done'); progress('grade', 'done'); progress('bling', 'done'); progress('comparando', 'done');
  const existing = await findBlingExact(deps.blingRequest, sku);
  if (existing) return { parentSku: sku, product: existing.nome, created: 0, existing: true, variations: components.length, stockUpdated: 0, images: 0, warnings: ['O kit já existia no Bling.'] };
  progress('gravando', 'running');
  const name = `KIT - ${components.map(item => item.local.name).join(' + ')}`.slice(0, 180);
  const images = components.map(item => item.local.image).filter(Boolean);
  const availability = Math.max(0, Math.floor(Math.min(...components.map(item => item.local.stock))));
  const body = { nome: name, codigo: sku, preco: components.reduce((sum, item) => sum + item.local.price, 0), tipo: 'P', situacao: 'A', formato: 'S', marca: 'Puket', tipoEstoque: 'F', categoria: { id: DEFAULT_CATEGORY_ID }, tributacao: { ncm: DEFAULT_NCM }, ...(images.length ? { midia: media(images) } : {}), estrutura: { tipoEstoque: 'F', componentes: components.map(item => ({ produto: { id: item.bling.id }, quantidade: 1 })) } };
  const response = await deps.blingRequest('POST', '/produtos', body);
  const kit = response.data?.data || response.data;
  progress('gravando', 'done'); progress('estoque', 'running');
  if (availability > 0 && kit?.id) await deps.blingRequest('POST', '/estoques', { produto: { id: kit.id }, deposito: { id: DEFAULT_DEPOSIT_ID }, operacao: 'B', preco: body.preco, quantidade: availability, observacoes: 'Estoque automático do kit' });
  progress('estoque', 'done');
  return { parentSku: sku, product: name, created: 1, existing: false, variations: components.length, stockUpdated: availability > 0 ? 1 : 0, images: images.length, warnings: [] };
}

async function executeAutomation({ operation, sku }, deps, progress = () => {}) {
  const normalizedSku = text(sku).toUpperCase();
  if (!normalizedSku) throw new Error('Informe o SKU.');
  if (operation === 'criar-kit') return createKit(normalizedSku, deps, progress);
  const group = await loadGroup(normalizedSku, deps, progress);
  const readOnly = operation === 'verificar-cadastro';
  if (readOnly) {
    progress('bling', 'running'); const existing = await findBlingExact(deps.blingRequest, group.parentSku); progress('bling', 'done'); progress('comparando', 'done');
    return { parentSku: group.parentSku, product: group.items[0].name, created: 0, existing: Boolean(existing), variations: group.items.length, stockUpdated: 0, images: group.items.filter(item => item.image).length, warnings: existing ? [] : ['Produto-pai ainda não existe no Bling.'] };
  }
  const updateContent = operation === 'atualizar-conteudo' || operation === 'sincronizar-tudo';
  const ensured = await ensureProduct(group, deps, progress, updateContent);
  let stock = { updated: 0, warnings: [] };
  if (['atualizar-estoque', 'sincronizar-tudo', 'cadastrar-produto', 'variacoes-ausentes'].includes(operation)) stock = await updateStock(group, ensured.parent.id, deps, progress);
  return { parentSku: group.parentSku, product: group.items[0].name, created: ensured.created, existing: ensured.created === 0, variations: group.items.length, stockUpdated: stock.updated, images: group.items.filter(item => item.image).length, warnings: stock.warnings };
}

module.exports = { executeAutomation };
