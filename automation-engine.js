const DEFAULT_CATEGORY_ID = Number(process.env.BLING_CATEGORY_ID || 11062477);
const DEFAULT_DEPOSIT_ID = Number(process.env.BLING_DEPOSIT_ID || 14888166814);
const DEFAULT_NCM = String(process.env.BLING_DEFAULT_NCM || '6108.31.00');

function text(value) { return String(value ?? '').trim(); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function priceNumber(value) {
  if (typeof value === 'string') {
    const normalized = value.replace(/R\$/gi, '').replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
    return number(normalized);
  }
  return number(value);
}
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
function imageUrls(value) {
  const values = Array.isArray(value) ? value : [];
  return values.map(item => text(typeof item === 'string' ? item : item?.link || item?.url || item?.imagemURL || item?.src)).filter(url => /^https?:\/\//i.test(url));
}
function blingImages(product) {
  return [...new Set([
    text(product?.imagemURL),
    ...imageUrls(product?.midia?.imagens?.externas),
    ...imageUrls(product?.midia?.imagens?.internas),
    ...imageUrls(product?.midia?.imagens?.imagensURL),
  ].filter(Boolean))];
}
function composeDescriptions(catalogDescription, linxDescription) {
  const catalog = text(catalogDescription);
  const linx = text(linxDescription);
  if (!catalog) return linx;
  if (!linx) return catalog;
  const comparableCatalog = catalog.replace(/\s+/g, ' ').toLowerCase();
  const comparableLinx = linx.replace(/\s+/g, ' ').toLowerCase();
  if (comparableCatalog.includes(comparableLinx)) return catalog;
  if (comparableLinx.includes(comparableCatalog)) return linx;
  return `${catalog}\n\n${linx}`.slice(0, 10000);
}
async function catalogContent(group, requestedSku, deps) {
  if (typeof deps.catalogSearch !== 'function') return { images: [], description: '', originalPrice: 0 };
  const queries = [...new Set([requestedSku, group.parentSku, group.items[0]?.name, ...group.items.map(item => item.barcode)].filter(Boolean))];
  const found = [];
  let description = '';
  let originalPrice = 0;
  for (const query of queries.slice(0, 3)) {
    try {
      const products = await deps.catalogSearch(query);
      for (const product of Array.isArray(products) ? products : []) {
        found.push(...imageUrls(product?.imagens));
        if (!description) description = text(product?.descricao);
        if (!originalPrice) originalPrice = priceNumber(product?.precoOriginal || product?.preco);
      }
      if (found.length || description) break;
    } catch (_) { /* catálogo é uma fonte complementar */ }
  }
  return { images: [...new Set(found)], description, originalPrice };
}
function productSpecs(name) {
  const value = text(name).toLowerCase();
  if (value.includes('pijama') || value.startsWith('pj')) return { pesoLiquido: .3, pesoBruto: .3, dimensoes: { largura: 30, altura: 20, profundidade: 20, unidadeMedida: 1 } };
  if (value.includes('lancheira')) return { pesoLiquido: .5, pesoBruto: .6, dimensoes: { largura: 20.5, altura: 25, profundidade: 14.5, unidadeMedida: 1 } };
  if (value.includes('mochila')) return { pesoLiquido: 1, pesoBruto: 1.1, dimensoes: { largura: 32, altura: 43, profundidade: 18, unidadeMedida: 1 } };
  return { pesoLiquido: .2, pesoBruto: .25, dimensoes: { largura: 18, altura: 25, profundidade: 5, unidadeMedida: 1 } };
}
function measurementsFromDescription(value) {
  const source = text(value);
  const dimension = labels => {
    const match = source.match(new RegExp(`(?:${labels})\\s*(?:do produto)?\\s*[:=-]?\\s*(\\d+(?:[.,]\\d+)?)\\s*(mm|cm|m)(?![a-z])`, 'i'));
    if (!match) return 0;
    const amount = priceNumber(match[1]);
    return match[2].toLowerCase() === 'mm' ? amount / 10 : match[2].toLowerCase() === 'm' ? amount * 100 : amount;
  };
  const weight = labels => {
    const match = source.match(new RegExp(`(?:${labels})\\s*[:=-]?\\s*(\\d+(?:[.,]\\d+)?)\\s*(kg|g)(?![a-z])`, 'i'));
    if (!match) return 0;
    const amount = priceNumber(match[1]);
    return match[2].toLowerCase() === 'g' ? amount / 1000 : amount;
  };
  return { width: dimension('largura'), height: dimension('altura'), depth: dimension('comprimento|profundidade'), netWeight: weight('peso\\s*l[ií]quido'), grossWeight: weight('peso\\s*bruto') };
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
      ncm: text(product.NCM || product.Ncm || product.CodigoNCM || product.ClassificacaoFiscal),
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
  if (/^\d{8,14}$/.test(text(sku))) queries.push(`/produtos?gtins[]=${encodeURIComponent(sku)}&pagina=1&limite=100`);
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

function inheritedVariationFields(parent) {
  const fields = {};
  for (const key of ['categoria', 'fornecedor', 'unidade', 'marca', 'tipoProducao', 'condicao', 'dimensoes']) {
    if (parent?.[key] !== undefined && parent[key] !== null && parent[key] !== '') fields[key] = parent[key];
  }
  if (parent?.tributacao && typeof parent.tributacao === 'object') fields.tributacao = { ...parent.tributacao };
  return fields;
}

function variationPayload(item, fallbackName, fallbackPrice, inherited = {}) {
  const variantName = [fallbackName, item.colorName, item.size].filter(Boolean).join(' ');
  const attribute = `${item.colorName ? `Cor:${item.colorName};` : ''}Tamanho:${item.size}`;
  const tributacao = inherited.tributacao
    ? { ...inherited.tributacao }
    : { ncm: item.ncm || DEFAULT_NCM };
  return {
    ...inherited,
    nome: variantName, codigo: item.childSku, preco: item.price || fallbackPrice, gtin: item.barcode || undefined,
    situacao: 'A', tipo: 'P', formato: 'S', variacao: { nome: attribute }, tributacao,
    ...(item.image ? { midia: media([item.image]) } : {}),
  };
}

function resolveVariation(item, variations) {
  const barcode = text(item.barcode);
  if (barcode) {
    const byGtin = variations.filter(value => [value.gtin, value.gtinTributario].some(gtin => text(gtin) === barcode));
    if (byGtin.length > 1) {
      const codes = byGtin.map(value => text(value.codigo) || `ID ${value.id}`).join(', ');
      throw Object.assign(new Error(`O GTIN ${barcode} está duplicado no Bling (${codes}). Revise a duplicidade antes de sincronizar.`), { step: 'comparando' });
    }
    if (byGtin.length === 1) return { variation: byGtin[0], matchedBy: 'gtin' };
  }
  const byCode = variations.find(value => text(value.codigo).toUpperCase() === text(item.childSku).toUpperCase());
  return byCode ? { variation: byCode, matchedBy: 'codigo' } : { variation: null, matchedBy: null };
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

function applyProductEdits(payload, edits = {}) {
  const updated = { ...payload };
  if (text(edits.name)) updated.nome = text(edits.name).slice(0, 180);
  if (Number.isFinite(Number(edits.price)) && Number(edits.price) >= 0) updated.preco = Number(edits.price);
  if (typeof edits.description === 'string') updated.descricaoComplementar = edits.description.trim().slice(0, 10000);
  if (text(edits.ncm)) updated.tributacao = { ...(updated.tributacao || {}), ncm: text(edits.ncm) };
  if (Number.isInteger(Number(edits.categoryId)) && Number(edits.categoryId) > 0) updated.categoria = { id: Number(edits.categoryId) };
  if (Array.isArray(edits.images) && edits.images.length) updated.midia = media(edits.images.slice(0, 20));
  if (edits.dimensions && typeof edits.dimensions === 'object') updated.dimensoes = { largura: number(edits.dimensions.width), altura: number(edits.dimensions.height), profundidade: number(edits.dimensions.depth), unidadeMedida: 1 };
  if (Number(edits.netWeight) > 0) updated.pesoLiquido = Number(edits.netWeight);
  if (Number(edits.grossWeight) > 0) updated.pesoBruto = Number(edits.grossWeight);
  return updated;
}

async function loadGroup(sku, deps, progress) {
  progress('linx', 'running');
  const raw = await deps.consultLinx(sku);
  progress('linx', 'done'); progress('produto', 'running');
  let items = normalizeLinxProducts(raw, sku, deps.colors);
  if (!items.length) throw Object.assign(new Error(`O SKU ${sku} não foi encontrado na Linx.`), { step: 'produto' });
  const parentSku = items[0].parentSku;
  if (text(sku).toUpperCase() !== text(parentSku).toUpperCase()) {
    const fullRaw = await deps.consultLinx(parentSku);
    const fullItems = normalizeLinxProducts(fullRaw, parentSku, deps.colors);
    if (fullItems.length > items.length) items = fullItems;
  }
  progress('produto', 'done'); progress('pai', 'done'); progress('grade', 'done');
  return { parentSku, items };
}

async function automaticProductEdits(group, requestedSku, deps) {
  const first = group.items[0];
  const catalog = await catalogContent(group, requestedSku, deps);
  const descriptionValue = composeDescriptions(catalog.description, first.description);
  const detected = measurementsFromDescription(descriptionValue);
  const fallback = productSpecs(first.name);
  return {
    name: first.name,
    description: descriptionValue,
    price: catalog.originalPrice > 0 ? catalog.originalPrice : first.price,
    images: [...new Set([...catalog.images, ...group.items.map(item => item.image).filter(Boolean)])],
    ncm: first.ncm || DEFAULT_NCM,
    categoryId: DEFAULT_CATEGORY_ID,
    dimensions: {
      width: detected.width || fallback.dimensoes.largura,
      height: detected.height || fallback.dimensoes.altura,
      depth: detected.depth || fallback.dimensoes.profundidade,
    },
    netWeight: detected.netWeight || fallback.pesoLiquido,
    grossWeight: detected.grossWeight || fallback.pesoBruto,
  };
}

async function ensureProduct(group, deps, progress, updateContent = false, edits = {}) {
  progress('bling', 'running');
  let parent = await findBlingExact(deps.blingRequest, group.parentSku);
  progress('bling', 'done'); progress('comparando', 'running');
  const payload = applyProductEdits(parentPayload(group.parentSku, group.items), edits);
  let created = 0;
  let existingCount = 0;
  const warnings = [];
  if (!parent) {
    for (const item of group.items) {
      if (!item.barcode) continue;
      const identity = await findBlingExact(deps.blingRequest, item.barcode);
      if (identity) {
        throw Object.assign(new Error(`O GTIN ${item.barcode} já pertence ao produto ${identity.codigo || identity.id} no Bling. Nenhum cadastro foi criado.`), { step: 'comparando' });
      }
    }
    progress('comparando', 'done'); progress('gravando', 'running');
    const response = await deps.blingRequest('POST', '/produtos', payload);
    parent = response.data?.data || response.data;
    created = group.items.length;
  } else {
    const detailResponse = await deps.blingRequest('GET', `/produtos/${parent.id}`);
    const detail = detailResponse.data?.data || detailResponse.data;
    const existing = Array.isArray(detail?.variacoes) ? detail.variacoes : [];
    const inherited = inheritedVariationFields(detail);
    const matches = group.items.map(item => ({ item, ...resolveVariation(item, existing) }));
    existingCount = matches.filter(match => match.variation).length;
    matches.filter(match => match.variation && match.matchedBy === 'gtin' && text(match.variation.codigo) !== match.item.childSku)
      .forEach(match => warnings.push(`O GTIN ${match.item.barcode} já estava cadastrado como ${match.variation.codigo}; a variação foi preservada.`));
    const price = group.items[0].price || Math.max(...group.items.map(item => item.price), 0);
    const missing = matches.filter(match => !match.variation)
      .map(match => variationPayload(match.item, group.items[0].name, price, inherited));
    created = missing.length;
    progress('comparando', 'done'); progress('gravando', 'running');
    const hasEdits = Object.keys(edits || {}).length > 0;
    if (missing.length || updateContent || hasEdits) {
      const editableUpdate = applyProductEdits({}, edits);
      const update = { ...detail, ...(updateContent ? payload : {}), ...editableUpdate, codigo: group.parentSku, variacoes: [...existing, ...missing] };
      if (!edits.ncm && detail.tributacao) update.tributacao = detail.tributacao;
      if (!edits.categoryId && detail.categoria) update.categoria = detail.categoria;
      await deps.blingRequest('PUT', `/produtos/${parent.id}`, update);
    }
  }
  progress('gravando', 'done');
  return { parent, created, existingCount, warnings };
}

async function updateStock(group, parentId, deps, progress) {
  progress('estoque', 'running');
  const detailResponse = await deps.blingRequest('GET', `/produtos/${parentId}`);
  const detail = detailResponse.data?.data || detailResponse.data;
  const variations = Array.isArray(detail?.variacoes) ? detail.variacoes : [];
  let updated = 0; const warnings = [];
  for (const item of group.items) {
    const { variation: variant, matchedBy } = resolveVariation(item, variations);
    if (!variant?.id) { warnings.push(`Variação ${item.childSku} sem ID no Bling.`); continue; }
    if (matchedBy === 'gtin' && text(variant.codigo) !== item.childSku) warnings.push(`Estoque associado a ${variant.codigo} pelo GTIN ${item.barcode}.`);
    await deps.blingRequest('POST', '/estoques', { produto: { id: variant.id }, deposito: { id: DEFAULT_DEPOSIT_ID }, operacao: 'B', preco: item.price, quantidade: item.stock, observacoes: 'Sincronização automática Puket Cadastro Inteligente' });
    updated++;
  }
  progress('estoque', warnings.length ? 'warning' : 'done');
  return { updated, warnings };
}

async function createKit(sku, deps, progress, edits = {}) {
  const componentSkus = text(sku).split('_').filter(Boolean);
  if (componentSkus.length < 2) throw Object.assign(new Error('Informe pelo menos dois SKUs separados por underline.'), { step: 'produto' });
  const existing = await findBlingExact(deps.blingRequest, sku);
  progress('linx', 'running');
  const components = [];
  let createdComponents = 0;
  let componentStocksUpdated = 0;
  const componentWarnings = [];
  for (const componentSku of componentSkus) {
    const group = await loadGroup(componentSku, deps, () => {});
    const local = group.items.find(item => item.base === componentSku || item.childSku === componentSku || item.barcode === componentSku) || group.items[0];
    let found = await findBlingExact(deps.blingRequest, local.childSku) || await findBlingExact(deps.blingRequest, componentSku);
    if (!found) {
      const automaticEdits = await automaticProductEdits(group, componentSku, deps);
      const ensured = await ensureProduct(group, deps, () => {}, true, automaticEdits);
      createdComponents += ensured.created > 0 ? 1 : 0;
      componentWarnings.push(...ensured.warnings);
      if (!ensured.parent?.id) throw Object.assign(new Error(`O produto-base do componente ${componentSku} foi criado sem identificação no Bling.`), { step: 'bling' });
      const stock = await updateStock(group, ensured.parent.id, deps, () => {});
      componentStocksUpdated += stock.updated;
      componentWarnings.push(...stock.warnings);
      const detailResponse = await deps.blingRequest('GET', `/produtos/${ensured.parent.id}`);
      const detail = detailResponse.data?.data || detailResponse.data;
      found = resolveVariation(local, Array.isArray(detail?.variacoes) ? detail.variacoes : []).variation;
    }
    if (!found?.id) throw Object.assign(new Error(`Não foi possível identificar o componente ${componentSku} no Bling após o cadastro.`), { step: 'bling' });
    components.push({ local, bling: found });
  }
  progress('linx', 'done'); progress('produto', 'done'); progress('pai', 'done'); progress('grade', 'done'); progress('bling', 'done'); progress('comparando', 'done');
  const expectedComponents = components.map(item => ({ produto: { id: item.bling.id }, quantidade: 1 }));
  const sameStructure = structure => {
    const current = Array.isArray(structure?.componentes) ? structure.componentes : [];
    return current.length === expectedComponents.length && expectedComponents.every(expected => current.some(item => Number(item?.produto?.id) === Number(expected.produto.id) && Number(item?.quantidade) === 1));
  };
  let structureAlreadyValid = false;
  if (existing?.id) {
    try {
      const structureResponse = await deps.blingRequest('GET', `/produtos/estruturas/${existing.id}`);
      const structure = structureResponse.data?.data || structureResponse.data;
      if (sameStructure(structure)) structureAlreadyValid = true;
      else throw Object.assign(new Error(`O produto ${sku} já possui uma estrutura diferente no Bling. Nenhuma estrutura foi substituída.`), { step: 'comparando' });
    } catch (error) {
      if (error.step === 'comparando') throw error;
      if (!/[" ]status[" ]*:\s*(400|404)/i.test(error.message)) throw Object.assign(new Error(`Não foi possível validar a estrutura existente de ${sku}: ${error.message}`), { step: 'bling' });
    }
  }
  progress('gravando', 'running');
  const name = `KIT - ${components.map(item => item.local.name).join(' + ')}`.slice(0, 180);
  const images = components.map(item => item.local.image).filter(Boolean);
  const availability = Math.max(0, Math.floor(Math.min(...components.map(item => item.local.stock))));
  const structureBody = { tipoEstoque: 'V', lancamentoEstoque: 'M', componentes: expectedComponents };
  const body = applyProductEdits({ nome: name, codigo: sku, preco: components.reduce((sum, item) => sum + item.local.price, 0), tipo: 'P', situacao: 'A', formato: 'E', tipoEstoque: 'V', estrutura: structureBody, marca: 'Puket', categoria: { id: DEFAULT_CATEGORY_ID }, tributacao: { ncm: DEFAULT_NCM }, ...(images.length ? { midia: media(images) } : {}) }, edits);
  let kit = existing;
  if (kit?.id) {
    const detailResponse = await deps.blingRequest('GET', `/produtos/${kit.id}`);
    const detail = detailResponse.data?.data || detailResponse.data;
    await deps.blingRequest('PUT', `/produtos/${kit.id}`, { ...detail, ...body, formato: 'E' });
  } else {
    const response = await deps.blingRequest('POST', '/produtos', body);
    kit = response.data?.data || response.data;
  }
  if (!kit?.id) throw Object.assign(new Error('O Bling não retornou o ID do produto do kit.'), { step: 'gravando' });
  if (!structureAlreadyValid) {
    await deps.blingRequest('PUT', `/produtos/estruturas/${kit.id}`, structureBody);
    const verificationResponse = await deps.blingRequest('GET', `/produtos/estruturas/${kit.id}`);
    const verified = verificationResponse.data?.data || verificationResponse.data;
    if (!sameStructure(verified)) throw Object.assign(new Error(`O Bling não confirmou a estrutura do kit ${sku}.`), { step: 'gravando' });
  }
  progress('gravando', 'done'); progress('estoque', 'done');
  return { parentSku: sku, product: name, created: existing ? 0 : 1, createdComponents, existing: Boolean(existing), variations: components.length, stockUpdated: componentStocksUpdated, kitAvailability: availability, images: images.length, warnings: componentWarnings };
}

async function previewKit(sku, deps) {
  const componentSkus = text(sku).split('_').filter(Boolean);
  if (componentSkus.length < 2) throw Object.assign(new Error('Informe pelo menos dois SKUs separados por underline.'), { step: 'produto' });
  const existingKit = await findBlingExact(deps.blingRequest, sku);
  const components = [];
  const warnings = [];
  for (const componentSku of componentSkus) {
    const group = await loadGroup(componentSku, deps, () => {});
    const local = group.items.find(item => item.base === componentSku || item.childSku === componentSku || item.barcode === componentSku) || group.items[0];
    let found = await findBlingExact(deps.blingRequest, local.childSku) || await findBlingExact(deps.blingRequest, componentSku);
    let status = found ? 'existing' : 'missing';
    if (!found && local.barcode) {
      const elsewhere = await findBlingExact(deps.blingRequest, local.barcode);
      if (elsewhere) { found = elsewhere; status = 'duplicate'; warnings.push(`O GTIN ${local.barcode} já pertence a ${elsewhere.codigo || elsewhere.id}.`); }
    }
    components.push({ requestedSku: componentSku, parentSku: group.parentSku, childSku: local.childSku, barcode: local.barcode, name: local.name, image: local.image, price: local.price, stock: local.stock, status, blingId: found?.id || null, blingSku: text(found?.codigo) });
  }
  let structureStatus = existingKit ? 'missing' : 'new';
  let existingDetail = null;
  if (existingKit?.id) {
    const detailResponse = await deps.blingRequest('GET', `/produtos/${existingKit.id}`);
    existingDetail = detailResponse.data?.data || detailResponse.data;
    try {
      const response = await deps.blingRequest('GET', `/produtos/estruturas/${existingKit.id}`);
      const structure = response.data?.data || response.data;
      const expectedIds = components.map(item => Number(item.blingId)).filter(Boolean);
      const current = Array.isArray(structure?.componentes) ? structure.componentes : [];
      structureStatus = expectedIds.length === components.length && current.length === expectedIds.length && expectedIds.every(id => current.some(item => Number(item?.produto?.id) === id && Number(item?.quantidade) === 1)) ? 'valid' : 'conflict';
      if (structureStatus === 'conflict') warnings.push(`O produto ${sku} já possui uma estrutura diferente no Bling.`);
    } catch (error) {
      if (!/[" ]status[" ]*:\s*(400|404)/i.test(error.message)) throw error;
    }
  }
  const suggestedName = `KIT - ${components.map(item => item.name).join(' + ')}`.slice(0, 180);
  const name = text(existingDetail?.nome) || suggestedName;
  const specs = productSpecs(name);
  const images = [...new Set([...components.map(item => item.image).filter(Boolean), ...blingImages(existingDetail)])];
  return { kind: 'kit', operation: 'criar-kit', requestedSku: sku, canApprove: !warnings.length, kit: { sku, exists: structureStatus === 'valid', productExists: Boolean(existingKit), structureStatus, name, description: text(existingDetail?.descricaoComplementar) || `Kit composto por:\n${components.map(item => `• ${item.name}`).join('\n')}`, price: number(existingDetail?.preco) || components.reduce((sum, item) => sum + item.price, 0), images, ncm: text(existingDetail?.tributacao?.ncm || DEFAULT_NCM), categoryId: existingDetail?.categoria?.id || DEFAULT_CATEGORY_ID, dimensions: { width: number(existingDetail?.dimensoes?.largura) || specs.dimensoes.largura, height: number(existingDetail?.dimensoes?.altura) || specs.dimensoes.altura, depth: number(existingDetail?.dimensoes?.profundidade) || specs.dimensoes.profundidade, netWeight: number(existingDetail?.pesoLiquido) || specs.pesoLiquido, grossWeight: number(existingDetail?.pesoBruto) || specs.pesoBruto }, availability: Math.max(0, Math.floor(Math.min(...components.map(item => item.stock)))) }, components, warnings };
}

async function previewAutomation({ operation, sku }, deps) {
  const normalizedSku = text(sku).toUpperCase();
  if (!normalizedSku) throw new Error('Informe o SKU.');
  if (operation === 'criar-kit') return previewKit(normalizedSku, deps);

  const group = await loadGroup(normalizedSku, deps, () => {});
  const parent = await findBlingExact(deps.blingRequest, group.parentSku);
  let detail = null;
  let existingVariations = [];
  if (parent?.id) {
    const response = await deps.blingRequest('GET', `/produtos/${parent.id}`);
    detail = response.data?.data || response.data;
    existingVariations = Array.isArray(detail?.variacoes) ? detail.variacoes : [];
  }

  const warnings = [];
  const variations = [];
  for (const item of group.items) {
    let match = { variation: null, matchedBy: null };
    try {
      match = resolveVariation(item, existingVariations);
    } catch (error) {
      variations.push({ ...item, status: 'duplicate', blingSku: '', blingId: null, message: error.message });
      warnings.push(error.message);
      continue;
    }
    if (!match.variation && !parent && item.barcode) {
      const elsewhere = await findBlingExact(deps.blingRequest, item.barcode);
      if (elsewhere) {
        const message = `O GTIN ${item.barcode} já pertence a ${elsewhere.codigo || elsewhere.id} no Bling.`;
        variations.push({ ...item, status: 'duplicate', blingSku: text(elsewhere.codigo), blingId: elsewhere.id || null, message });
        warnings.push(message);
        continue;
      }
    }
    const preserved = match.variation;
    variations.push({
      ...item,
      status: preserved ? 'existing' : 'new',
      blingSku: preserved ? text(preserved.codigo) : '',
      blingId: preserved?.id || null,
      message: preserved && match.matchedBy === 'gtin' && text(preserved.codigo) !== item.childSku
        ? `Será preservada como ${preserved.codigo}, identificada pelo GTIN.`
        : '',
    });
  }

  const duplicateCount = variations.filter(item => item.status === 'duplicate').length;
  const newCount = variations.filter(item => item.status === 'new').length;
  const existingCount = variations.filter(item => item.status === 'existing').length;
  const first = group.items[0];
  const catalog = await catalogContent(group, normalizedSku, deps);
  const generatedImages = group.items.map(item => item.image).filter(Boolean);
  const images = [...new Set([...catalog.images, ...generatedImages, ...blingImages(detail)])];
  const composedDescription = composeDescriptions(catalog.description, first.description);
  const suggestedPrice = catalog.originalPrice > 0 ? catalog.originalPrice : first.price;
  const detected = measurementsFromDescription(composedDescription);
  const fallbackSpecs = productSpecs(first.name);
  const dimensions = {
    width: detected.width || number(detail?.dimensoes?.largura) || fallbackSpecs.dimensoes.largura,
    height: detected.height || number(detail?.dimensoes?.altura) || fallbackSpecs.dimensoes.altura,
    depth: detected.depth || number(detail?.dimensoes?.profundidade) || fallbackSpecs.dimensoes.profundidade,
    netWeight: detected.netWeight || number(detail?.pesoLiquido) || fallbackSpecs.pesoLiquido,
    grossWeight: detected.grossWeight || number(detail?.pesoBruto) || fallbackSpecs.pesoBruto,
    detected: Boolean(detected.width || detected.height || detected.depth || detected.netWeight || detected.grossWeight),
  };
  return {
    kind: 'product',
    operation,
    requestedSku: normalizedSku,
    parentExists: Boolean(parent),
    canApprove: duplicateCount === 0,
    product: {
      parentSku: group.parentSku,
      name: first.name,
      description: composedDescription,
      catalogDescription: catalog.description,
      linxDescription: first.description,
      image: first.image,
      images,
      price: suggestedPrice,
      catalogPrice: catalog.originalPrice,
      linxPrice: first.price,
      dimensions,
      ncm: text(detail?.tributacao?.ncm || first.ncm || DEFAULT_NCM),
      categoryId: detail?.categoria?.id || DEFAULT_CATEGORY_ID,
      brand: text(detail?.marca || 'Puket'),
      bling: detail ? {
        name: text(detail.nome),
        description: text(detail.descricaoComplementar || detail.descricaoCurta),
        price: number(detail.preco),
        ncm: text(detail.tributacao?.ncm),
        categoryId: detail.categoria?.id || null,
        image: blingImages(detail)[0] || '',
        images: blingImages(detail),
      } : null,
    },
    summary: { total: variations.length, existing: existingCount, toCreate: newCount, duplicates: duplicateCount },
    variations,
    warnings,
  };
}

async function executeAutomation({ operation, sku, edits = {} }, deps, progress = () => {}) {
  const normalizedSku = text(sku).toUpperCase();
  if (!normalizedSku) throw new Error('Informe o SKU.');
  if (operation === 'criar-kit') return createKit(normalizedSku, deps, progress, edits);
  const group = await loadGroup(normalizedSku, deps, progress);
  const readOnly = operation === 'verificar-cadastro';
  if (readOnly) {
    progress('bling', 'running'); const existing = await findBlingExact(deps.blingRequest, group.parentSku); progress('bling', 'done'); progress('comparando', 'done');
    return { parentSku: group.parentSku, product: group.items[0].name, created: 0, existing: Boolean(existing), variations: group.items.length, stockUpdated: 0, images: group.items.filter(item => item.image).length, warnings: existing ? [] : ['Produto-pai ainda não existe no Bling.'] };
  }
  const updateContent = operation === 'atualizar-conteudo' || operation === 'sincronizar-tudo';
  const ensured = await ensureProduct(group, deps, progress, updateContent, edits);
  let stock = { updated: 0, warnings: [] };
  if (['atualizar-estoque', 'sincronizar-tudo', 'cadastrar-produto', 'variacoes-ausentes'].includes(operation)) stock = await updateStock(group, ensured.parent.id, deps, progress);
  return { parentSku: group.parentSku, product: group.items[0].name, created: ensured.created, existing: ensured.created === 0, variations: group.items.length, stockUpdated: stock.updated, images: group.items.filter(item => item.image).length, warnings: [...ensured.warnings, ...stock.warnings] };
}

module.exports = { executeAutomation, previewAutomation };
