require('dotenv').config();

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const urlMod = require('url');
const nodehttps = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
const { OfferFunnelStore } = require('./offer-funnel-store');
const { BlingEventStore } = require('./bling-event-store');
const { GroupSalesStore } = require('./group-sales-store');
const { GroupSalesEngine } = require('./group-sales-engine');

// Credenciais externas são configuradas no ambiente (localmente pelo .env e,
// em produção, pelo painel da hospedagem). Nunca coloque chaves neste arquivo.
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();

// Chave do Assistente de Estoque. Defina DEEPSEEK_API_KEY no ambiente antes
// de iniciar o servidor; a chave nunca é enviada para o navegador.
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEEPSEEK_CONFIG_FILE = path.join(__dirname, 'deepseek_config.json');

function obterChaveDeepSeek() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const config = JSON.parse(fs.readFileSync(DEEPSEEK_CONFIG_FILE, 'utf8'));
    if (typeof config.apiKey === 'string' && config.apiKey.trim()) return config.apiKey.trim();
  } catch (_) { /* arquivo local ainda não foi configurado */ }
  // O Windows só entrega novas variáveis de ambiente a processos abertos depois
  // da alteração. Esta leitura permite que o painel encontre a chave do usuário
  // mesmo quando ele for aberto por um atalho já existente.
  if (process.platform === 'win32') {
    try {
      const saida = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'DEEPSEEK_API_KEY'], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const linha = saida.split(/\r?\n/).find(valor => /DEEPSEEK_API_KEY\s+REG_\w+\s+/i.test(valor));
      if (linha) return linha.replace(/^.*?REG_\w+\s+/i, '').trim();
    } catch (_) { /* a chave ainda não foi configurada */ }
  }
  return '';
}

// ── Catálogo Puket (Grupo Único) ──
const CATALOGO_CLIENT_ID = '356862';

// ── Token JWT fixo ──
const LINX_FALLBACK_TOKEN = String(process.env.LINX_TOKEN || '').trim();
const LINX_LOGIN = String(process.env.LINX_LOGIN || '').trim();
const LINX_PASSWORD = String(process.env.LINX_PASSWORD || '');
const LINX_PORTAL_ID = Number(process.env.LINX_PORTAL_ID || 7776);
const LINX_COMPANY_ID = Number(process.env.LINX_COMPANY_ID || 1);

let linxAccessToken = LINX_FALLBACK_TOKEN;
let linxLoginPromise = null;

function jwtExpiresSoon(token, marginMs = 2 * 60 * 1000) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return !payload.exp || (payload.exp * 1000) <= Date.now() + marginMs;
  } catch (_) {
    return true;
  }
}

function linxJsonRequest({ hostname, apiPath, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const jsonBody = JSON.stringify(body || {});
    const request = nodehttps.request({
      hostname,
      path: apiPath,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(jsonBody),
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        ...headers,
      },
      timeout: 30000,
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ data, headers: response.headers, status: response.statusCode });
        } else {
          const detail = data?.Mensagem || data?.message || data?.error || data?.raw || `HTTP ${response.statusCode}`;
          const error = new Error(`Linx: ${detail}`);
          error.statusCode = response.statusCode;
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Tempo esgotado ao autenticar no Linx')));
    request.on('error', reject);
    request.write(jsonBody);
    request.end();
  });
}

async function loginLinx() {
  if (!LINX_LOGIN || !LINX_PASSWORD) {
    if (linxAccessToken && !jwtExpiresSoon(linxAccessToken)) return linxAccessToken;
    throw new Error('Configure LINX_LOGIN e LINX_PASSWORD.');
  }

  const loginResponse = await linxJsonRequest({
    hostname: 'erpadmin-prod.microvix.com.br',
    apiPath: '/api/Autenticacao/Login',
    body: { Login: LINX_LOGIN, Senha: LINX_PASSWORD, EhPos: false },
  });

  const temporaryToken = String(loginResponse.data?.TokenTemporario || '').trim();
  if (!temporaryToken) throw new Error('O login do Linx não retornou TokenTemporario.');

  const cookies = (loginResponse.headers['set-cookie'] || [])
    .map(cookie => String(cookie).split(';')[0])
    .join('; ');
  const selectionResponse = await linxJsonRequest({
    hostname: 'erpadmin-prod.microvix.com.br',
    apiPath: '/api/Autenticacao/SelecionarEmpresa',
    headers: {
      authtoken: temporaryToken,
      ...(cookies ? { cookie: cookies } : {}),
    },
    body: { IdPortal: LINX_PORTAL_ID, IdEmpresa: LINX_COMPANY_ID, Produtos: [] },
  });

  const token = String(selectionResponse.data?.TokenJWT || '').trim();
  if (!token) throw new Error('A seleção de empresa do Linx não retornou TokenJWT.');
  linxAccessToken = token;
  console.log(`[Linx] Login renovado para portal ${LINX_PORTAL_ID}, empresa ${LINX_COMPANY_ID}.`);
  return token;
}

async function getLinxToken(forceRefresh = false) {
  if (!forceRefresh && linxAccessToken && !jwtExpiresSoon(linxAccessToken)) return linxAccessToken;
  if (!linxLoginPromise) {
    linxLoginPromise = loginLinx().finally(() => { linxLoginPromise = null; });
  }
  return linxLoginPromise;
}

// ── Bling OAuth2 ──
const BLING_CLIENT_ID = String(process.env.BLING_CLIENT_ID || '').trim();
const BLING_CLIENT_SECRET = String(process.env.BLING_CLIENT_SECRET || '').trim();
const BLING_REDIRECT_URI = String(process.env.BLING_REDIRECT_URI || 'https://localhost:3030/bling/callback').trim();
const BLING_TOKENS_FILE = path.join(__dirname, 'bling_tokens.json');
const BLING_WEBHOOK_SECRET = String(process.env.BLING_WEBHOOK_SECRET || BLING_CLIENT_SECRET || '').trim();

let blingTokens = { access_token: null, refresh_token: null, expires_at: 0 };

function loadBlingTokens() {
  try {
    if (fs.existsSync(BLING_TOKENS_FILE)) {
      blingTokens = JSON.parse(fs.readFileSync(BLING_TOKENS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Erro ao ler bling_tokens.json:', e.message); }
}
function saveBlingTokens() {
  fs.writeFileSync(BLING_TOKENS_FILE, JSON.stringify(blingTokens, null, 2));
}
loadBlingTokens();

function blingTokenRequest(bodyParams) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(bodyParams).toString();
    const auth = Buffer.from(BLING_CLIENT_ID + ':' + BLING_CLIENT_SECRET).toString('base64');
    const req = https.request({
      hostname: 'www.bling.com.br',
      path: '/Api/v3/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + auth,
        'enable-jwt': '1',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            blingTokens.access_token = json.access_token;
            blingTokens.refresh_token = json.refresh_token;
            blingTokens.expires_at = Date.now() + (json.expires_in * 1000) - 60000;
            saveBlingTokens();
            resolve(json);
          } else {
            reject(new Error(json.error_description || json.error || 'Token error'));
          }
        } catch (e) { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function refreshBlingToken() {
  if (!blingTokens.refresh_token) throw new Error('Sem refresh_token. Autorize primeiro em /bling/auth');
  return blingTokenRequest({ grant_type: 'refresh_token', refresh_token: blingTokens.refresh_token });
}

// ── Rate Limiter para Bling (max 3 req/s) ──
const blingQueue = [];
let blingProcessing = false;
function enqueueBling(fn) {
  return new Promise((resolve, reject) => {
    blingQueue.push({ fn, resolve, reject });
    if (!blingProcessing) processBlingQueue();
  });
}
async function processBlingQueue() {
  blingProcessing = true;
  while (blingQueue.length > 0) {
    const { fn, resolve, reject } = blingQueue.shift();
    try { resolve(await fn()); } catch (e) { reject(e); }
    await new Promise(r => setTimeout(r, 350));
  }
  blingProcessing = false;
}

// ── Helper: request autenticado ao Bling ──
function blingRequest(method, apiPath, body) {
  return enqueueBling(async () => {
    if (!blingTokens.access_token) throw new Error('Não autenticado no Bling');
    if (Date.now() >= blingTokens.expires_at) {
      console.log('[Bling] Token expirado, refreshing...');
      await refreshBlingToken();
    }
    const execute = () => new Promise((resolve, reject) => {
      const jsonBody = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: 'api.bling.com.br',
        path: '/Api/v3' + apiPath,
        method,
        headers: {
          'Authorization': 'Bearer ' + blingTokens.access_token,
          'enable-jwt': '1',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(jsonBody ? { 'Content-Length': Buffer.byteLength(jsonBody) } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data: parsed });
          } else if (res.statusCode === 401) {
            reject(new Error('TOKEN_EXPIRED'));
          } else {
            reject(new Error(JSON.stringify({ status: res.statusCode, body: parsed })));
          }
        });
      });
      req.on('error', reject);
      if (jsonBody) req.write(jsonBody);
      req.end();
    });
    try {
      return await execute();
    } catch (error) {
      if (error.message !== 'TOKEN_EXPIRED') throw error;
      console.log('[Bling] API respondeu 401; renovando token e repetindo a requisição uma vez...');
      await refreshBlingToken();
      return execute();
    }
  });
}

const PORT = Number(process.env.PORT || 3030);
const ROOT = __dirname;
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
const SERVE_FRONTEND = String(process.env.SERVE_FRONTEND ?? (!IS_PRODUCTION)).toLowerCase() === 'true';
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

function allowedOrigin(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin) return '';
  if (!IS_PRODUCTION && ALLOWED_ORIGINS.length === 0) return origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : '';
}
const FUNNEL_ADMIN_TOKEN = String(process.env.FUNNEL_ADMIN_TOKEN || process.env.AGENT_PASSWORD || '').trim();
let funnelSalesNumber = String(process.env.FUNNEL_SALES_NUMBER || '').replace(/\D/g, '');
let groupSalesNumber = String(process.env.GROUP_SALES_NUMBER || '').replace(/\D/g, '');
let funnelGroups = [];
let groupAgentRuntimeStatus = {
  state: 'offline', session: String(process.env.WPP_GROUP_SESSION || 'vendas-grupo-puket'),
  salesNumber: groupSalesNumber || null, qrDataUrl: null, message: 'Agente comercial ainda não conectado.',
  updatedAt: null, lastSeenAt: null,
};
const FUNNEL_PUBLIC_URL_CONFIGURED = Boolean(String(process.env.FUNNEL_PUBLIC_BASE_URL || '').trim());
const FUNNEL_PUBLIC_BASE_URL = String(process.env.FUNNEL_PUBLIC_BASE_URL || `https://localhost:${PORT}`).replace(/\/$/, '');
const offerFunnel = new OfferFunnelStore(path.join(ROOT, 'offer_funnel.json'));
const blingEvents = new BlingEventStore(path.join(ROOT, 'bling_events.json'));
const groupSalesStore = new GroupSalesStore(path.join(ROOT, 'group_sales.json'));
const GROUP_AGENT_TOKEN = String(process.env.GROUP_AGENT_TOKEN || '').trim();
const GROUP_PUBLIC_BASE_URL = String(process.env.GROUP_PUBLIC_BASE_URL || FUNNEL_PUBLIC_BASE_URL).replace(/\/$/, '');
const groupSalesEngine = new GroupSalesEngine({
  store: groupSalesStore,
  getOffer: offerId => offerFunnel.getPublicOffer(offerId),
  checkStock: consultarDisponibilidadeBling,
  publicBaseUrl: GROUP_PUBLIC_BASE_URL,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

// ── Estado Global do Inventário ──
const DB_FILE = path.join(ROOT, 'database.json');
const PENDING_ACTIONS_FILE = path.join(ROOT, 'pending_actions.json');
let globalInventory = [];
let pendingActions = [];

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      globalInventory = JSON.parse(data);
    }
  } catch (err) {
    console.error('Erro ao ler database.json:', err);
  }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(globalInventory, null, 2));
}

function loadPendingActions() {
  try {
    if (fs.existsSync(PENDING_ACTIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_ACTIONS_FILE, 'utf8'));
      pendingActions = Array.isArray(data) ? data : [];
    }
  } catch (err) {
    console.error('Erro ao ler pending_actions.json:', err.message);
    pendingActions = [];
  }
}

function savePendingActions() {
  fs.writeFileSync(PENDING_ACTIONS_FILE, JSON.stringify(pendingActions, null, 2));
}

loadPendingActions();

function normalizarNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function localizarProdutoLocal(codigo) {
  const busca = String(codigo || '').trim();
  if (!busca) return null;
  return globalInventory.find(item => !item.isKit && [
    item.codBase,
    item.codebar,
    item.referencia,
    item.skuPai,
    item.skuFilho,
  ].some(valor => String(valor || '').trim() === busca)) || null;
}

async function consultarProdutoLinxInterno(codigo, retry = true) {
  const token = await getLinxToken();
  return new Promise((resolve, reject) => {
    const busca = String(codigo || '').trim();
    const body = JSON.stringify({
      CodigoProduto: busca,
      NomeProduto: busca,
      Referencia: busca,
      Codebar: busca,
      CodigoAuxiliar: busca,
      CodigoIntegracaoOMS: busca,
      IdsSetores: [],
      ApenasComPromocao: false,
      IncluirDesativados: false,
      ApenasComSaldoPositivo: false,
    });
    const request = nodehttps.request({
      hostname: 'suprimentoswebapi-prod.microvix.com.br',
      path: '/api/ListagemProdutos/PesquisarProdutos',
      method: 'POST',
      headers: {
        accept: '*/*',
        authorization: token,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
      timeout: 30000,
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(data);
        else if (response.statusCode === 401 && retry) {
          getLinxToken(true)
            .then(() => consultarProdutoLinxInterno(codigo, false))
            .then(resolve, reject);
        } else reject(new Error(data?.error || data?.raw || `Linx respondeu ${response.statusCode}`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('Tempo esgotado ao consultar o Linx')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function buscarProdutoBlingExato(codigo) {
  const busca = String(codigo || '').trim();
  if (!busca) return null;
  const consultas = [
    `/produtos?codigo=${encodeURIComponent(busca)}&pagina=1&limite=100`,
    `/produtos?codigos[]=${encodeURIComponent(busca)}&pagina=1&limite=100`,
  ];
  if (/^\d{8,14}$/.test(busca)) {
    consultas.push(`/produtos?gtins[]=${encodeURIComponent(busca)}&pagina=1&limite=100`);
  }

  for (const consulta of consultas) {
    try {
      const resposta = await blingRequest('GET', consulta);
      const produtos = Array.isArray(resposta.data?.data) ? resposta.data.data : [];
      const produto = produtos.find(item => [
        item.codigo,
        item.gtin,
        item.gtinTributario,
      ].some(valor => String(valor || '').trim() === busca));
      if (produto) return produto;
    } catch (_) {
      // Tenta a próxima forma documentada de pesquisa.
    }
  }
  return null;
}

function resumirProdutoBling(produto, identificadorConsultado) {
  return {
    id: produto.id,
    idProdutoPai: produto.idProdutoPai || null,
    codigo: String(produto.codigo || ''),
    nome: String(produto.nome || ''),
    formato: String(produto.formato || ''),
    situacao: String(produto.situacao || ''),
    preco: normalizarNumero(produto.preco),
    saldoVirtualInformado: normalizarNumero(produto.estoque?.saldoVirtualTotal),
    identificadorConsultado,
  };
}

async function resolverIdentidadeProduto(codigo) {
  const entrada = String(codigo || '').trim();
  if (!entrada) throw new Error('Informe um SKU, referência ou GTIN.');

  const local = localizarProdutoLocal(entrada);
  const codigoLinx = String(local?.codBase || local?.referencia || entrada).trim();
  let linx = null;
  let erroLinx = null;
  try {
    const respostaLinx = await consultarProdutoLinxInterno(codigoLinx);
    linx = Array.isArray(respostaLinx?.Produtos) ? respostaLinx.Produtos[0] || null : null;
  } catch (erro) {
    erroLinx = erro.message;
  }

  const identificadores = [];
  const adicionarIdentificador = (valor, origem) => {
    const normalizado = String(valor || '').trim();
    if (!normalizado) return;
    const existente = identificadores.find(item => item.valor === normalizado);
    if (existente) {
      if (!existente.origens.includes(origem)) existente.origens.push(origem);
      return;
    }
    identificadores.push({ valor: normalizado, origens: [origem] });
  };

  adicionarIdentificador(entrada, 'entrada');
  adicionarIdentificador(local?.skuFilho, 'sku_variacao_bling');
  adicionarIdentificador(local?.codBase, 'sku_original_linx');
  adicionarIdentificador(local?.codebar, 'gtin');
  adicionarIdentificador(local?.referencia, 'referencia');
  adicionarIdentificador(local?.skuPai, 'sku_pai');
  adicionarIdentificador(linx?.CodigoAuxiliar, 'codigo_auxiliar_linx');
  adicionarIdentificador(linx?.Referencia, 'referencia_linx');
  for (const codebar of Array.isArray(linx?.Codebars) ? linx.Codebars : []) {
    adicionarIdentificador(codebar?.Codebar, 'gtin_linx');
  }

  const encontradosPorId = new Map();
  for (const identificador of identificadores.slice(0, 8)) {
    const produto = await buscarProdutoBlingExato(identificador.valor);
    if (produto?.id && !encontradosPorId.has(String(produto.id))) {
      encontradosPorId.set(String(produto.id), resumirProdutoBling(produto, identificador.valor));
    }
  }

  const produtosBling = Array.from(encontradosPorId.values());
  const skuVariacao = String(local?.skuFilho || '');
  const skuOriginal = String(local?.codBase || entrada);
  const preferido = produtosBling.find(item => item.codigo === skuVariacao)
    || produtosBling.find(item => item.codigo === entrada)
    || produtosBling.find(item => item.codigo === skuOriginal)
    || produtosBling.find(item => item.formato !== 'V')
    || produtosBling[0]
    || null;
  const operacionais = produtosBling.filter(item => item.formato !== 'V');
  const duplicidadeDetectada = operacionais.length > 1;

  return {
    entrada,
    confianca: local && preferido ? 'alta' : (local || preferido || linx ? 'media' : 'baixa'),
    identidadeCanonica: {
      skuOriginalLinx: local?.codBase || codigoLinx,
      referenciaLinx: local?.referencia || linx?.Referencia || null,
      skuPai: local?.skuPai || null,
      skuVariacaoBling: local?.skuFilho || null,
      gtin: local?.codebar || linx?.Codebars?.find(item => item?.Principal)?.Codebar || null,
      idBlingPreferido: preferido?.id || null,
      codigoBlingPreferido: preferido?.codigo || null,
    },
    inventarioLocal: local ? {
      nome: local.nome,
      quantidade: normalizarNumero(local.qtd),
      preco: normalizarNumero(local.preco),
      cor: local.corNome || null,
      tamanho: local.tamanho || null,
    } : null,
    linx: linx ? {
      codigoProduto: linx.CodigoProduto,
      nome: linx.NomeProduto,
      referencia: linx.Referencia,
      codigoAuxiliar: linx.CodigoAuxiliar,
      saldo: normalizarNumero(linx.Saldo),
      saldoPortal: normalizarNumero(linx.SaldoPortal),
      saldoEmTransito: normalizarNumero(linx.SaldoEmTransito),
      precoVenda: normalizarNumero(linx.PrecoVenda),
      precoCusto: normalizarNumero(linx.PrecoCusto),
      desativado: Boolean(linx.Desativado),
    } : null,
    erroLinx,
    produtosBling,
    produtoBlingPreferido: preferido,
    duplicidadeDetectada,
    alerta: duplicidadeDetectada
      ? 'Mais de um produto operacional do Bling representa o mesmo item. Revise antes de alterar estoque.'
      : null,
  };
}

async function consultarSaldoBlingPorProduto(produto) {
  if (!produto?.id) return null;
  try {
    const resposta = await blingRequest('GET', `/estoques/saldos?idsProdutos[]=${encodeURIComponent(produto.id)}&pagina=1&limite=100`);
    const saldos = Array.isArray(resposta.data?.data) ? resposta.data.data : [];
    const saldo = saldos.find(item => String(item?.produto?.id || '') === String(produto.id)) || saldos[0] || null;
    return {
      saldoFisicoTotal: normalizarNumero(saldo?.saldoFisicoTotal),
      saldoVirtualTotal: normalizarNumero(saldo?.saldoVirtualTotal),
      depositos: (Array.isArray(saldo?.depositos) ? saldo.depositos : []).map(deposito => ({
        id: deposito.id,
        saldoFisico: normalizarNumero(deposito.saldoFisico),
        saldoVirtual: normalizarNumero(deposito.saldoVirtual),
      })),
    };
  } catch (erro) {
    return { erro: erro.message, saldoFisicoTotal: 0, saldoVirtualTotal: 0, depositos: [] };
  }
}

async function consultarDisponibilidadeBling(codigo) {
  const busca = String(codigo || '').trim();
  if (!busca) return { available: NaN, duplicate: false, product: null };
  const resposta = await blingRequest('GET', `/produtos?codigo=${encodeURIComponent(busca)}&pagina=1&limite=100`);
  const produtos = (Array.isArray(resposta.data?.data) ? resposta.data.data : [])
    .filter(item => String(item.codigo || '').trim() === busca && String(item.formato || '') !== 'V');
  if (produtos.length !== 1) {
    return { available: NaN, duplicate: produtos.length > 1, product: produtos[0] || null };
  }
  const saldo = await consultarSaldoBlingPorProduto(produtos[0]);
  if (saldo?.erro) throw new Error(`Não foi possível consultar o saldo no Bling: ${saldo.erro}`);
  return { available: Number(saldo?.saldoVirtualTotal), duplicate: false, product: produtos[0] };
}

async function compararEstoqueReal(codigo) {
  const identidade = await resolverIdentidadeProduto(codigo);
  const saldosBling = [];
  for (const produto of identidade.produtosBling.filter(item => item.formato !== 'V')) {
    saldosBling.push({
      produto,
      saldo: await consultarSaldoBlingPorProduto(produto),
      preferido: String(produto.id) === String(identidade.identidadeCanonica.idBlingPreferido),
    });
  }
  const registroPreferido = saldosBling.find(item => item.preferido) || saldosBling[0] || null;
  const saldoLinx = normalizarNumero(identidade.linx?.saldo);
  const saldoBling = normalizarNumero(registroPreferido?.saldo?.saldoVirtualTotal);
  const diferenca = registroPreferido ? saldoBling - saldoLinx : null;
  const alertas = [];
  if (!identidade.linx) alertas.push('Produto não localizado no Linx.');
  if (!registroPreferido) alertas.push('Produto operacional não localizado no Bling.');
  if (identidade.duplicidadeDetectada) alertas.push('Duplicidade no Bling: existem múltiplos produtos operacionais para o mesmo item.');
  if (diferenca !== null && diferenca !== 0) alertas.push(`Divergência de estoque: Bling ${diferenca > 0 ? 'tem' : 'possui'} ${Math.abs(diferenca)} unidade(s) ${diferenca > 0 ? 'a mais' : 'a menos'} que o Linx.`);
  if (identidade.inventarioLocal && identidade.linx && identidade.inventarioLocal.quantidade !== saldoLinx) {
    alertas.push('O inventário local está desatualizado em relação ao Linx.');
  }

  return {
    codigo: String(codigo),
    identidade: identidade.identidadeCanonica,
    confiancaIdentidade: identidade.confianca,
    estoque: {
      linx: {
        saldo: saldoLinx,
        saldoPortal: normalizarNumero(identidade.linx?.saldoPortal),
        saldoEmTransito: normalizarNumero(identidade.linx?.saldoEmTransito),
      },
      blingPreferido: registroPreferido,
      diferencaBlingMenosLinx: diferenca,
      inventarioLocal: identidade.inventarioLocal?.quantidade ?? null,
    },
    todosCadastrosBling: saldosBling,
    duplicidadeDetectada: identidade.duplicidadeDetectada,
    alertas,
  };
}

async function consultarEstoqueComercial(codigo) {
  const comparacao = await compararEstoqueReal(codigo);
  const registro = comparacao.estoque.blingPreferido;
  const saldoFisico = registro ? normalizarNumero(registro.saldo?.saldoFisicoTotal) : null;
  const saldoVirtual = registro ? normalizarNumero(registro.saldo?.saldoVirtualTotal) : null;
  const reservado = registro ? Math.max(0, saldoFisico - saldoVirtual) : null;
  const productId = registro?.produto?.id ? String(registro.produto.id) : null;
  const eventosRecentes = productId ? blingEvents.eventsForProduct(productId, 20).events : [];
  return {
    atualizadoEm: new Date().toISOString(),
    codigo: String(codigo || ''),
    identidade: comparacao.identidade,
    saldo: {
      linx: comparacao.estoque.linx.saldo,
      blingFisico: saldoFisico,
      blingVirtual: saldoVirtual,
      reservado,
      diferencaFisicoBlingMenosLinx: saldoFisico === null ? null : saldoFisico - comparacao.estoque.linx.saldo,
    },
    depositos: registro?.saldo?.depositos || [],
    duplicidadeDetectada: comparacao.duplicidadeDetectada,
    alertas: comparacao.alertas,
    produtoBling: registro?.produto || null,
    eventosRecentes,
    observacao: eventosRecentes.length
      ? 'Eventos recentes do Bling encontrados para este produto.'
      : 'Ainda não há eventos de webhook registrados para este produto.',
  };
}

async function auditarEstoqueEmLote(codigosEntrada, limiteEntrada) {
  const limite = Math.min(50, Math.max(1, normalizarNumero(limiteEntrada) || 20));
  const codigosInformados = Array.isArray(codigosEntrada) ? codigosEntrada : [];
  const base = codigosInformados.length
    ? codigosInformados
    : globalInventory.filter(item => !item.isKit).map(item => item.codBase || item.skuFilho || item.codebar);
  const codigos = Array.from(new Set(base.map(valor => String(valor || '').trim()).filter(Boolean))).slice(0, limite);
  if (!codigos.length) throw new Error('Nenhum SKU disponível para auditoria.');

  const resultados = [];
  for (const codigo of codigos) {
    try {
      const comparacao = await compararEstoqueReal(codigo);
      let status = 'ok';
      if (!comparacao.estoque.blingPreferido) status = 'ausente_bling';
      else if (comparacao.duplicidadeDetectada) status = 'duplicado';
      else if (comparacao.estoque.diferencaBlingMenosLinx !== 0) status = 'divergencia';
      resultados.push({
        codigo,
        status,
        identidade: comparacao.identidade,
        saldoLinx: comparacao.estoque.linx.saldo,
        saldoBling: comparacao.estoque.blingPreferido?.saldo?.saldoVirtualTotal ?? null,
        diferencaBlingMenosLinx: comparacao.estoque.diferencaBlingMenosLinx,
        duplicidadeDetectada: comparacao.duplicidadeDetectada,
        alertas: comparacao.alertas,
      });
    } catch (erro) {
      resultados.push({ codigo, status: 'erro', erro: erro.message });
    }
  }

  const contagem = resultados.reduce((total, item) => {
    total[item.status] = (total[item.status] || 0) + 1;
    return total;
  }, {});
  return {
    atualizadoEm: new Date().toISOString(),
    total: resultados.length,
    contagem,
    resultados,
  };
}

async function verificarSkuNoBlingParaAssistente(codigo) {
  const busca = String(codigo || '').trim();
  if (!busca) return null;
  const resposta = await blingRequest('GET', `/produtos?codigo=${encodeURIComponent(busca)}&pagina=1&limite=100`);
  const produtos = Array.isArray(resposta.data?.data) ? resposta.data.data : [];
  const produto = produtos.find(item => String(item.codigo || '').trim() === busca || String(item.gtin || '').trim() === busca);
  return produto
    ? { encontrado: true, id: produto.id, codigo: produto.codigo, nome: produto.nome || '' }
    : { encontrado: false, codigo: busca };
}

function montarResumoEstoqueParaAssistente() {
  const simples = globalInventory.filter(item => !item.isKit);
  const porIdentificador = new Map();
  for (const item of simples) {
    const chaves = [item.codebar, item.codBase, item.skuFilho, item.referencia]
      .filter(Boolean)
      .map(valor => String(valor).trim());
    for (const chave of chaves) porIdentificador.set(chave, item);
  }

  const produtos = simples.slice(0, 250).map(item => ({
    nome: String(item.nome || 'Sem nome').slice(0, 140),
    sku: String(item.skuFilho || item.codebar || item.codBase || item.referencia || ''),
    codigoParaKit: String(item.codBase || item.codebar || item.referencia || ''),
    quantidade: normalizarNumero(item.qtd),
    preco: normalizarNumero(item.preco),
    categoria: String(item.categoria || ''),
  }));

  const estoqueBaixo = produtos
    .filter(item => item.quantidade <= 3)
    .sort((a, b) => a.quantidade - b.quantidade)
    .slice(0, 40);

  const kits = globalInventory.filter(item => item.isKit).slice(0, 100).map(kit => {
    const codigosComponentes = String(kit.codebar || '')
      .split('_')
      .map(codigo => codigo.trim())
      .filter(Boolean);
    const componentes = codigosComponentes.map(codigo => {
      const item = porIdentificador.get(codigo);
      return {
        sku: codigo,
        nome: item ? String(item.nome || 'Sem nome').slice(0, 100) : 'Não encontrado no inventário',
        quantidade: item ? normalizarNumero(item.qtd) : 0,
      };
    });
    return {
      nome: String(kit.nome || 'Kit sem nome').slice(0, 140),
      sku: String(kit.skuFilho || kit.codebar || ''),
      quantidadeRegistrada: normalizarNumero(kit.qtd),
      disponibilidadePelosComponentes: componentes.length ? Math.min(...componentes.map(c => c.quantidade)) : 0,
      componentes,
    };
  });

  return {
    atualizadoEm: new Date().toISOString(),
    totais: {
      itensNoInventario: globalInventory.length,
      produtosSimples: simples.length,
      kits: globalInventory.filter(item => item.isKit).length,
      pecas: simples.reduce((total, item) => total + normalizarNumero(item.qtd), 0),
    },
    estoqueBaixo,
    produtos,
    kits,
  };
}

function montarCentralInteligente() {
  const simples = globalInventory.filter(item => !item.isKit);
  const kits = globalInventory.filter(item => item.isKit);
  const localizar = (codigo) => simples.find(item => [item.codBase, item.codebar, item.referencia, item.skuFilho]
    .map(valor => String(valor || '').trim()).includes(String(codigo || '').trim()));
  const furos = [];

  simples.filter(item => normalizarNumero(item.qtd) <= 3).forEach(item => furos.push({
    tipo: 'estoque_baixo', gravidade: normalizarNumero(item.qtd) === 0 ? 'critico' : 'atencao', nome: item.nome,
    detalhe: `${normalizarNumero(item.qtd)} unidade(s) no Linx`, codigo: item.codBase || item.codebar || item.skuFilho,
  }));
  simples.filter(item => !item.imgUrl).forEach(item => furos.push({
    tipo: 'imagem_ausente', gravidade: 'informativo', nome: item.nome, detalhe: 'Sem imagem no inventário local', codigo: item.codBase || item.codebar || item.skuFilho,
  }));

  const resumoKits = kits.map(kit => {
    const codigos = String(kit.codebar || '').split('_').filter(Boolean);
    const componentes = codigos.map(codigo => localizar(codigo));
    const disponibilidade = componentes.length ? Math.min(...componentes.map(item => item ? normalizarNumero(item.qtd) : 0)) : 0;
    const faltantes = codigos.filter((codigo, indice) => !componentes[indice]);
    if (faltantes.length || disponibilidade <= 0) furos.push({
      tipo: 'kit_inviavel', gravidade: 'critico', nome: kit.nome, detalhe: faltantes.length ? `Componente não localizado: ${faltantes.join(', ')}` : 'Sem estoque para montar', codigo: kit.skuPai || kit.codebar,
    });
    return { nome: kit.nome, codigo: kit.skuPai || kit.codebar, disponibilidade, componentes: codigos.length, rascunho: kit.categoria === 'Rascunho IA' };
  });

  return {
    atualizadoEm: new Date().toISOString(),
    indicadores: {
      produtos: simples.length,
      pecas: simples.reduce((total, item) => total + normalizarNumero(item.qtd), 0),
      kits: kits.length,
      pendencias: furos.length,
      rascunhos: resumoKits.filter(kit => kit.rascunho).length + pendingActions.filter(acao => acao.status === 'rascunho').length,
    },
    furos: furos.sort((a, b) => (a.gravidade === 'critico' ? -1 : 1) - (b.gravidade === 'critico' ? -1 : 1)).slice(0, 50),
    kits: resumoKits.slice(0, 30),
    rascunhos: resumoKits.filter(kit => kit.rascunho),
    acoesPendentes: pendingActions.filter(acao => acao.status === 'rascunho').slice(-50).reverse(),
  };
}

function consultarDeepSeek(messages) {
  return new Promise((resolve, reject) => {
    const chave = obterChaveDeepSeek();
    const payload = JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 900,
    });
    const request = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${chave}`,
      },
      timeout: 30000,
    }, (deepSeekResponse) => {
      let resposta = '';
      deepSeekResponse.on('data', chunk => resposta += chunk);
      deepSeekResponse.on('end', () => {
        let json;
        try { json = JSON.parse(resposta); }
        catch (_) { reject(new Error('Resposta inválida recebida do DeepSeek')); return; }
        if (deepSeekResponse.statusCode < 200 || deepSeekResponse.statusCode >= 300) {
          reject(new Error(json?.error?.message || `DeepSeek respondeu ${deepSeekResponse.statusCode}`));
          return;
        }
        const texto = json?.choices?.[0]?.message?.content?.trim();
        if (!texto) { reject(new Error('O DeepSeek não retornou uma resposta')); return; }
        resolve(texto);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Tempo esgotado ao consultar o DeepSeek')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

loadDB();

// ── Dicionário de Cores ──
const CORES_FILE = path.join(ROOT, 'cores_validas.csv');
let coresMap = {};

function loadCores() {
  try {
    if (fs.existsSync(CORES_FILE)) {
      const lines = fs.readFileSync(CORES_FILE, 'utf8').split('\n');
      lines.forEach(line => {
        const parts = line.split('-');
        if (parts.length >= 2) {
          const cod = parts[0].trim();
          // Pega apenas a palavra limpa (o nome da cor)
          const nome = parts.slice(1).join('-').trim().toUpperCase();
          coresMap[cod] = nome;
        }
      });
    }
  } catch (err) {
    console.error('Erro ao ler cores_validas.csv:', err);
  }
}
loadCores();

// ── Socket.io Setup ──
function setupSocket(server) {
  const { Server } = require('socket.io');
  const io = new Server(server, { cors: { origin: '*' } });
  global._socketIo = io;

  io.on('connection', (socket) => {
    console.log('[Socket] Cliente conectado:', socket.id);

    // Envia o estado atual assim que conectar
    socket.emit('sync_inventory', globalInventory);

    socket.on('add_item', (item) => {
      // ── Lógica Bling: Pai e Filho ──
      // Priorizamos o codBase (12 dígitos gerados no scanner baseados no CodigoAuxiliar)
      const baseToParse = item.codBase || item.referencia || '';

      if (baseToParse.length >= 12 && !baseToParse.includes('_')) {
        const skuPai = baseToParse.substring(0, 9);
        const corCod = baseToParse.substring(9, 12);
        const corNome = coresMap[corCod] || corCod;

        item.skuPai = skuPai;
        item.corNome = corNome;
        // Ex: 030402879_ROSA_1 (substitui espaços no tamanho por underline opcionalmente, mas manteremos original)
        item.skuFilho = `${skuPai}_${corNome}_${item.tamanho}`.toUpperCase().replace(/\s+/g, '');
      } else {
        item.skuPai = item.codebar;
        item.skuFilho = item.codebar;
        item.corNome = '';
      }

      const existing = globalInventory.find(i => i.codebar === item.codebar);
      if (existing) {
        existing.qtd += item.qtd;
        existing.preco = item.preco;
        existing.skuPai = item.skuPai;
        existing.skuFilho = item.skuFilho;
        existing.corNome = item.corNome;
        existing.descricaoLinx = item.descricaoLinx || existing.descricaoLinx || '';
      } else {
        globalInventory.push(item);
      }
      saveDB();
      io.emit('sync_inventory', globalInventory); // Atualiza geral
    });

    socket.on('change_qtd', ({ id, delta }) => {
      const item = globalInventory.find(i => i.id === id);
      if (item) {
        item.qtd += delta;
        if (item.qtd <= 0) {
          globalInventory = globalInventory.filter(i => i.id !== id);
        }
        saveDB();
        io.emit('sync_inventory', globalInventory);
      }
    });

    socket.on('remove_item', (id) => {
      globalInventory = globalInventory.filter(i => i.id !== id);
      saveDB();
      io.emit('sync_inventory', globalInventory);
    });

    socket.on('clear_inventory', () => {
      globalInventory = [];
      saveDB();
      io.emit('sync_inventory', globalInventory);
    });
  });
}

// ── Proxy Catálogo Puket (Grupo Único) ──
function catalogoBuscar(pesquisa) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({
      CodigoCliente: CATALOGO_CLIENT_ID,
      IDCatalogo: '0',
      Pesquisa: pesquisa,
      QuantidadeRegistrosPagina: 20,
      PaginaAtual: 0
    });

    const req = nodehttps.request({
      hostname: 'ti.grupounico.com',
      path: '/Produtos/ListaProdutos',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Extrair JSON-LD do HTML retornado
        const regex = /<script\s+type="application\/ld\+json">(.*?)<\/script>/gs;
        let match;
        const products = [];
        while ((match = regex.exec(data)) !== null) {
          try {
            const json = JSON.parse(match[1].trim());
            // Decodificar HTML entities na descrição
            let desc = json.productDetails || '';
            desc = desc.replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            desc = desc.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
            desc = desc.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

            products.push({
              nome: json.productName || '',
              id: json.productId || '',
              descricao: desc,
              preco: json.price,
              precoOriginal: json.listPrice,
              imagens: json.productImages || [],
              variacoes: json.productVariations || []
            });
          } catch (e) { /* skip malformed */ }
        }
        resolve(products);
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Proxy Linx ──
async function proxyLinx(codebar, res, retry = true) {
  let token;
  try {
    token = await getLinxToken();
  } catch (error) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
    return;
  }
  const body = JSON.stringify({
    CodigoProduto: codebar,
    NomeProduto: codebar,
    Referencia: codebar,
    Codebar: codebar,
    CodigoAuxiliar: codebar,
    CodigoIntegracaoOMS: codebar,
    IdsSetores: [],
    ApenasComPromocao: false,
    IncluirDesativados: false,
    ApenasComSaldoPositivo: false,
  });

  const options = {
    hostname: 'suprimentoswebapi-prod.microvix.com.br',
    path: '/api/ListagemProdutos/PesquisarProdutos',
    method: 'POST',
    headers: {
      'accept': '*/*',
      'authorization': token,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    },
  };

  const req = nodehttps.request(options, (linxRes) => {
    let data = '';
    linxRes.on('data', c => data += c);
    linxRes.on('end', async () => {
      if (linxRes.statusCode === 401 && retry) {
        try {
          await getLinxToken(true);
          await proxyLinx(codebar, res, false);
        } catch (error) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        return;
      }
      res.writeHead(linxRes.statusCode, {
        'Content-Type': 'application/json',
      });
      res.end(data);
    });
  });

  req.on('error', (err) => {
    console.error('Erro Linx:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });

  req.write(body);
  req.end();
}

// ── Handler de requisições ──
function handler(req, res) {
  const parsed = urlMod.parse(req.url, true);
  const reqPath = parsed.pathname;
  const corsOrigin = allowedOrigin(req);

  // Garante CORS consistente em todas as respostas da API.
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (statusCode, headers = {}) => {
    const responseHeaders = { ...headers };
    if (corsOrigin) {
      responseHeaders['Access-Control-Allow-Origin'] = corsOrigin;
      responseHeaders['Vary'] = 'Origin';
    }
    return originalWriteHead(statusCode, responseHeaders);
  };

  if (req.method === 'OPTIONS') {
    if (req.headers.origin && !corsOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origem não autorizada.' }));
      return;
    }
    res.writeHead(204, {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    res.end(); return;
  }

  if (reqPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', service: 'gestao-estoque-api' }));
    return;
  }

  if (reqPath.startsWith('/api/') && req.headers.origin && !corsOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origem não autorizada.' }));
    return;
  }

  if (reqPath === '/api/produto') {
    const codebar = (parsed.query.codebar || '').trim();
    if (!codebar) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'codebar obrigatorio' }));
      return;
    }
    console.log(`[BUSCA] ${codebar}`);
    proxyLinx(codebar, res);
    return;
  }

  // Helper para ler body JSON
  const readRawBody = (req, maxBytes = 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Corpo da requisição excede o limite permitido.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJsonBody = (req) => readRawBody(req).then(buffer => {
    const body = buffer.toString('utf8');
    try { return JSON.parse(body || '{}'); }
    catch (e) { throw e; }
  });

  if (reqPath === '/api/bling/webhooks' && req.method === 'POST') {
    readRawBody(req).then(rawBody => {
      if (!BLING_WEBHOOK_SECRET) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Configure BLING_WEBHOOK_SECRET no servidor.' }));
        return;
      }
      const received = String(req.headers['x-bling-signature-256'] || '').trim().toLowerCase();
      const expected = `sha256=${crypto.createHmac('sha256', BLING_WEBHOOK_SECRET).update(rawBody).digest('hex')}`;
      const validLength = received.length === expected.length;
      const valid = validLength && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Assinatura do webhook do Bling inválida.' }));
        return;
      }
      let payload;
      try { payload = JSON.parse(rawBody.toString('utf8')); }
      catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JSON do webhook inválido.' }));
        return;
      }
      const result = blingEvents.ingest(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, duplicate: result.duplicate, eventId: result.event.eventId }));
    }).catch(error => {
      console.error('[BLING-WEBHOOK] Erro:', error.message);
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  // Atendimento comercial do grupo: processo isolado do agente interno de estoque.
  const groupAgentAuthorized = () => {
    if (!GROUP_AGENT_TOKEN && !FUNNEL_ADMIN_TOKEN) return false;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const header = String(req.headers['x-group-agent-token'] || '');
    const funnelHeader = String(req.headers['x-funnel-token'] || '');
    return (GROUP_AGENT_TOKEN && (bearer === GROUP_AGENT_TOKEN || header === GROUP_AGENT_TOKEN))
      || (FUNNEL_ADMIN_TOKEN && (bearer === FUNNEL_ADMIN_TOKEN || funnelHeader === FUNNEL_ADMIN_TOKEN));
  };
  const requireGroupAgentAuth = () => {
    if (groupAgentAuthorized()) return true;
    res.writeHead(GROUP_AGENT_TOKEN ? 401 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: GROUP_AGENT_TOKEN ? 'Token do agente comercial inválido.' : 'Configure GROUP_AGENT_TOKEN no servidor.' }));
    return false;
  };

  if (reqPath === '/api/grupo/worker/status' && req.method === 'POST') {
    if (!requireGroupAgentAuth()) return;
    readJsonBody(req).then(body => {
      const allowedStates = new Set(['starting', 'qr', 'authenticated', 'connected', 'disconnected', 'error', 'offline']);
      const state = String(body.state || '').trim().toLowerCase();
      if (!allowedStates.has(state)) throw new Error('Estado do agente inválido.');
      const qrDataUrl = body.qrDataUrl === null ? null : String(body.qrDataUrl || '').slice(0, 750000);
      groupAgentRuntimeStatus = {
        ...groupAgentRuntimeStatus,
        state,
        session: String(body.session || groupAgentRuntimeStatus.session || '').slice(0, 100),
        salesNumber: String(body.salesNumber || groupSalesNumber || '').replace(/\D/g, '').slice(-15) || null,
        message: String(body.message || '').slice(0, 500) || null,
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        ...(body.qrDataUrl !== undefined ? { qrDataUrl } : {}),
      };
      if (['authenticated', 'connected'].includes(state)) groupAgentRuntimeStatus.qrDataUrl = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }).catch(error => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  if (reqPath === '/api/grupo/status' && req.method === 'GET') {
    if (!requireGroupAgentAuth()) return;
    const stale = !groupAgentRuntimeStatus.lastSeenAt || Date.now() - Date.parse(groupAgentRuntimeStatus.lastSeenAt) > 45000;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: { ...groupAgentRuntimeStatus, state: stale && groupAgentRuntimeStatus.state === 'connected' ? 'offline' : groupAgentRuntimeStatus.state, stale } }));
    return;
  }
  if (reqPath === '/api/grupo/worker/register' && req.method === 'POST') {
    if (!requireGroupAgentAuth()) return;
    readJsonBody(req).then(body => {
      const number = String(body.salesNumber || '').replace(/\D/g, '').slice(-15);
      if (!number) throw new Error('Número comercial inválido.');
      groupSalesNumber = number;
      groupAgentRuntimeStatus.salesNumber = number;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, salesNumberConfigured: true }));
    }).catch(error => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  if (reqPath === '/api/grupo/conversa/iniciar' && req.method === 'POST') {
    if (!requireGroupAgentAuth()) return;
    readJsonBody(req).then(body => groupSalesEngine.start(body)).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(error => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  if (reqPath === '/api/grupo/conversa/mensagem' && req.method === 'POST') {
    if (!requireGroupAgentAuth()) return;
    readJsonBody(req).then(body => groupSalesEngine.handle(body)).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(error => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  if (reqPath === '/api/grupo/conversas' && req.method === 'GET') {
    if (!requireGroupAgentAuth()) return;
    const conversas = groupSalesStore.listConversations().map(conversation => ({
      ...conversation,
      phone: conversation.phone ? `${conversation.phone.slice(0, 4)}••••${conversation.phone.slice(-4)}` : '',
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: conversas.length, conversas }));
    return;
  }

  if (reqPath === '/api/grupo/metricas' && req.method === 'GET') {
    if (!requireGroupAgentAuth()) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(groupSalesStore.metrics()));
    return;
  }

  if (reqPath === '/api/grupo/eventos' && req.method === 'GET') {
    if (!requireGroupAgentAuth()) return;
    const eventos = groupSalesStore.listEvents(parsed.query.limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: eventos.length, eventos }));
    return;
  }

  if (reqPath === '/api/grupo/disponibilidade' && req.method === 'GET') {
    if (!requireGroupAgentAuth()) return;
    consultarDisponibilidadeBling(String(parsed.query.sku || '')).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sku: String(parsed.query.sku || ''), disponivel: result.available, duplicado: result.duplicate, produto: result.product ? { id: result.product.id, codigo: result.product.codigo, nome: result.product.nome } : null }));
    }).catch(error => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  const checkoutApiMatch = reqPath.match(/^\/api\/grupo\/checkout\/([a-f0-9]+)$/i);
  if (checkoutApiMatch && req.method === 'GET') {
    const checkout = groupSalesStore.getCheckout(checkoutApiMatch[1]);
    if (!checkout) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Checkout não encontrado.' }));
      return;
    }
    const { phone, ...safeCheckout } = checkout;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ checkout: safeCheckout }));
    return;
  }

  if (reqPath === '/api/grupo/checkout/confirmar' && req.method === 'POST') {
    readJsonBody(req).then(body => groupSalesStore.confirmCheckout(String(body.token || ''))).then(checkout => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status: checkout.status, notice: 'Confirmação apenas de teste; nenhum pedido ou pagamento foi criado.' }));
    }).catch(error => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  if (/^\/checkout\/[a-f0-9]+$/i.test(reqPath) && req.method === 'GET') {
    fs.readFile(path.join(ROOT, 'checkout.html'), (error, content) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Checkout temporariamente indisponível.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(content);
    });
    return;
  }

  // Funil de ofertas: a equipe cria e aprova; o agente apenas publica e atende.
  const funnelAuthorized = () => {
    if (!FUNNEL_ADMIN_TOKEN) return false;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const header = String(req.headers['x-funnel-token'] || '');
    return bearer === FUNNEL_ADMIN_TOKEN || header === FUNNEL_ADMIN_TOKEN;
  };
  const requireFunnelAuth = () => {
    if (funnelAuthorized()) return true;
    res.writeHead(FUNNEL_ADMIN_TOKEN ? 401 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: FUNNEL_ADMIN_TOKEN ? 'Token do funil inválido.' : 'Configure FUNNEL_ADMIN_TOKEN no servidor.' }));
    return false;
  };

  if (reqPath === '/api/funil/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicBaseUrl: FUNNEL_PUBLIC_BASE_URL, publicUrlConfigured: FUNNEL_PUBLIC_URL_CONFIGURED, salesNumberConfigured: !!funnelSalesNumber }));
    return;
  }

  if (reqPath === '/api/funil/worker/register' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    readJsonBody(req).then(body => {
      const number = String(body.salesNumber || '').replace(/\D/g, '').slice(-15);
      if (!number) throw new Error('Número comercial inválido.');
      funnelSalesNumber = number;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, salesNumberConfigured: true }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/worker/groups' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    readJsonBody(req).then(body => {
      const groups = Array.isArray(body.groups) ? body.groups : [];
      funnelGroups = groups.map(group => ({
        id: String(group.id || '').trim().slice(0, 120),
        name: String(group.name || 'Grupo sem nome').trim().slice(0, 180),
      })).filter(group => group.id.endsWith('@g.us')).slice(0, 500);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, total: funnelGroups.length }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/grupos' && req.method === 'GET') {
    if (!requireFunnelAuth()) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: funnelGroups.length, grupos: funnelGroups.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) }));
    return;
  }

  if (reqPath === '/api/funil/ofertas' && req.method === 'GET') {
    if (!requireFunnelAuth()) return;
    const ofertas = offerFunnel.listOffers(String(parsed.query.status || '').trim());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: ofertas.length, ofertas }));
    return;
  }

  if (reqPath === '/api/funil/catalogo/produto' && req.method === 'GET') {
    if (!requireFunnelAuth()) return;
    const sku = String(parsed.query.sku || '').trim();
    consultarDisponibilidadeBling(sku).then(result => {
      if (!result.product) throw new Error(`SKU ${sku} não encontrado no Bling.`);
      if (result.duplicate) throw new Error(`Há mais de um produto operacional com o SKU ${sku} no Bling.`);
      const imageCode = sku.replace(/\D/g, '').slice(0, 12);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ produto: {
        id: result.product.id,
        sku: String(result.product.codigo || sku),
        nome: String(result.product.nome || ''),
        preco: normalizarNumero(result.product.preco),
        disponivel: result.available,
        imagem: imageCode ? `https://storage.googleapis.com/cdnportalservicos/Files/B2C2/${imageCode}_1.png` : '',
      } }));
    }).catch(error => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/ofertas' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    readJsonBody(req).then(body => {
      const oferta = offerFunnel.createOffer(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, oferta }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  const publicOfferMatch = reqPath.match(/^\/api\/funil\/ofertas\/([^/]+)\/publica$/);
  if (publicOfferMatch && req.method === 'GET') {
    const oferta = offerFunnel.getPublicOffer(decodeURIComponent(publicOfferMatch[1]));
    if (!oferta) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Oferta indisponível.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ oferta }));
    return;
  }

  if (reqPath === '/api/funil/ofertas/status' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    readJsonBody(req).then(async body => {
      const offerId = String(body.id || '').trim();
      const status = String(body.status || '').trim();
      let stockValidation = [];
      if (status === 'aprovada') {
        const offer = offerFunnel.getOffer(offerId);
        if (!offer) throw new Error('Oferta não encontrada.');
        for (const item of offer.items) {
          const result = await consultarDisponibilidadeBling(item.sku);
          const hasBling = Boolean(result.product?.id);
          const saldoBling = Number(result.available);
          const valid = hasBling && !result.duplicate && Number.isFinite(saldoBling) && saldoBling > 0;
          stockValidation.push({
            sku: item.sku,
            valid,
            saldoBling,
            hasBling,
            duplicate: !!result.duplicate,
            alerts: [],
            checkedAt: new Date().toISOString(),
          });
        }
        const invalid = stockValidation.filter(item => !item.valid);
        if (invalid.length) {
          const details = invalid.map(item => `${item.sku}: ${!item.hasBling ? 'ausente no Bling' : item.duplicate ? 'duplicado no Bling' : 'sem estoque disponível no Bling'}`).join('; ');
          throw new Error(`A oferta não pode ser aprovada: ${details}.`);
        }
      }
      const oferta = offerFunnel.setOfferStatus(offerId, status, stockValidation);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, oferta }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/ofertas/publicar' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    readJsonBody(req).then(body => {
      if (!FUNNEL_PUBLIC_URL_CONFIGURED) throw new Error('Configure FUNNEL_PUBLIC_BASE_URL antes de publicar; links localhost não funcionam para os clientes.');
      const publicacao = offerFunnel.queuePublication(String(body.id || '').trim());
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, publicacao }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/publicacoes/proxima' && req.method === 'GET') {
    if (!requireFunnelAuth()) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicacao: offerFunnel.nextPublication() }));
    return;
  }

  if (reqPath === '/api/funil/publicacoes/status' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    readJsonBody(req).then(body => {
      const resultado = offerFunnel.finishPublication(String(body.id || '').trim(), Boolean(body.success), body.error);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, resultado }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/privado-iniciado' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    readJsonBody(req).then(body => {
      const resultado = offerFunnel.startPrivate(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...resultado }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/leads/por-telefone' && req.method === 'GET') {
    if (!requireFunnelAuth()) return;
    const lead = offerFunnel.findLeadByPhone(String(parsed.query.phone || ''));
    res.writeHead(lead ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lead ? { lead } : { error: 'Lead não encontrado.' }));
    return;
  }

  if (reqPath === '/api/funil/leads/preferencias' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    readJsonBody(req).then(body => {
      const lead = offerFunnel.updateLead(body.phone, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, lead }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/eventos' && req.method === 'POST') {
    if (!requireFunnelAuth()) return;
    const allowedEvents = new Set(['product_selected', 'purchase_intent', 'payment_sent', 'purchase_confirmed', 'purchase_abandoned', 'human_handoff']);
    readJsonBody(req).then(body => {
      const type = String(body.type || '');
      if (!allowedEvents.has(type)) throw new Error('Evento não permitido.');
      const lead = body.leadId ? null : offerFunnel.findLeadByPhone(body.phone);
      const leadId = body.leadId || lead?.id || null;
      const offer = offerFunnel.getOffer(String(body.offerId || ''));
      if (!offer) throw new Error('Oferta não encontrada.');
      if (!leadId) throw new Error('Lead não encontrado para este evento.');
      if (body.itemId && !offer.items.some(item => item.id === body.itemId)) throw new Error('Produto não pertence à oferta.');
      const event = offerFunnel.addEvent(type, { ...body, leadId });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, event }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/funil/metricas' && req.method === 'GET') {
    if (!requireFunnelAuth()) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(offerFunnel.metrics()));
    return;
  }

  const trackedOfferMatch = reqPath.match(/^\/o\/([^/]+)\/([^/]+)$/);
  if (trackedOfferMatch && req.method === 'GET') {
    const offerId = decodeURIComponent(trackedOfferMatch[1]);
    const itemId = decodeURIComponent(trackedOfferMatch[2]);
    const offer = offerFunnel.getPublicOffer(offerId);
    const item = offer?.items.find(candidate => candidate.id === itemId);
    if (!offer || !item) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Esta oferta não está mais disponível.');
      return;
    }
    offerFunnel.addEvent('offer_clicked', {
      offerId,
      itemId,
      groupId: offerFunnel.getOffer(offerId)?.groupId,
      campaign: offerFunnel.getOffer(offerId)?.campaign,
      metadata: {
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
        referrer: String(req.headers.referer || '').slice(0, 500),
      },
    });
    const destinationNumber = groupSalesNumber || funnelSalesNumber;
    if (!destinationNumber) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('O atendimento privado ainda não foi configurado.');
      return;
    }
    const message = `Olá! Tenho interesse na oferta ${offerId} ITEM ${itemId} (${item.name}).`;
    res.writeHead(302, { Location: `https://wa.me/${destinationNumber}?text=${encodeURIComponent(message)}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // ── Importar itens de NF-e em lote ──
  if (reqPath === '/api/importar-nfe' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      const itens = body.itens || [];
      let adicionados = 0;
      let atualizados = 0;

      itens.forEach(item => {
        // Priorizamos o codBase (12 dígitos gerados no scanner baseados no CodigoAuxiliar)
        const baseToParse = item.codBase || item.referencia || '';

        if (baseToParse.length >= 12 && !baseToParse.includes('_')) {
          const skuPai = baseToParse.substring(0, 9);
          const corCod = baseToParse.substring(9, 12);
          const corNome = coresMap[corCod] || corCod;

          item.skuPai = skuPai;
          item.corNome = corNome;
          item.skuFilho = `${skuPai}_${corNome}_${item.tamanho}`.toUpperCase().replace(/\s+/g, '');
        } else {
          item.skuPai = item.codebar;
          item.skuFilho = item.codebar;
          item.corNome = '';
        }

        const existing = globalInventory.find(i => i.codebar === item.codebar);
        if (existing) {
          existing.qtd += item.qtd;
          existing.preco = item.preco;
          existing.skuPai = item.skuPai;
          existing.skuFilho = item.skuFilho;
          existing.corNome = item.corNome;
          existing.descricaoLinx = item.descricaoLinx || existing.descricaoLinx || '';
          atualizados++;
        } else {
          globalInventory.push(item);
          adicionados++;
        }
      });

      saveDB();
      if (global._socketIo) {
        global._socketIo.emit('sync_inventory', globalInventory);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        adicionados,
        atualizados,
        total: globalInventory.length
      }));
    }).catch(err => {
      console.error('[IMPORTAR-NFE] Erro:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // ── Rotas Bling ──
  if (reqPath === '/bling/auth') {
    const state = '12345'; // Em prod seria um hash aleatório
    const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${BLING_CLIENT_ID}&state=${state}`;
    res.writeHead(302, { 'Location': authUrl });
    res.end();
    return;
  }

  if (reqPath === '/api/bling/exchange-code' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      const code = body.code;
      if (!code) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Code nao fornecido' })); return;
      }
      blingTokenRequest({ grant_type: 'authorization_code', code })
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        })
        .catch(e => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
    });
    return;
  }

  if (reqPath === '/bling/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: !!blingTokens.access_token }));
    return;
  }

  if (reqPath === '/api/bling/produto') {
    if (req.method === 'GET') {
      const codigo = (parsed.query.codigo || '').trim();
      const id = parsed.query.id;
      if (id) {
        blingRequest('GET', `/produtos/${id}`)
          .then(r => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.data)); })
          .catch(e => { res.writeHead(500); res.end(e.message); });
      } else if (!codigo) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'codigo ou id obrigatorio' }));
      } else {
        // A integração antiga usa "codigo" e funciona nesta conta. A API
        // atual também documenta "codigos[]". Só devolvemos "não encontrado"
        // depois de consultar as duas formas, sempre conferindo o SKU exato.
        const queryNova = `/produtos?codigos[]=${encodeURIComponent(codigo)}&pagina=1&limite=100`;
        const queryLegada = `/produtos?codigo=${encodeURIComponent(codigo)}&pagina=1&limite=100`;
        const queryGtin = `/produtos?gtins[]=${encodeURIComponent(codigo)}&pagina=1&limite=100`;
        const temIdentificadorExato = (resposta) => {
          const produtos = Array.isArray(resposta?.data) ? resposta.data : [];
          return produtos.some(produto => {
            const sku = String(produto.codigo || '').trim();
            const gtin = String(produto.gtin || produto.gtinTributario || '').trim();
            return sku === codigo || gtin === codigo;
          });
        };
        (async () => {
          const consultas = [queryLegada, queryNova, queryGtin];
          let ultimaResposta = null;
          let ultimoErro = null;

          for (const consulta of consultas) {
            try {
              const resposta = await blingRequest('GET', consulta);
              ultimaResposta = resposta;
              if (temIdentificadorExato(resposta.data)) return resposta;
            } catch (erro) {
              ultimoErro = erro;
            }
          }

          if (ultimaResposta) return ultimaResposta;
          throw ultimoErro || new Error('Nenhuma consulta ao Bling respondeu');
        })()
          .then(r => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.data)); })
          .catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Falha ao consultar produto no Bling', details: e.message }));
          });
      }
      return;
    }
    else if (req.method === 'POST') {
      readJsonBody(req).then(body => {
        blingRequest('POST', '/produtos', body)
          .then(r => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.data)); })
          .catch(e => { res.writeHead(500); res.end(e.message); });
      });
      return;
    }
    else if (req.method === 'PUT') {
      const id = parsed.query.id;
      readJsonBody(req).then(body => {
        blingRequest('PUT', `/produtos/${id}`, body)
          .then(r => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.data)); })
          .catch(e => { res.writeHead(500); res.end(e.message); });
      });
      return;
    }
  }

  if (reqPath === '/api/bling/produtos/estruturas' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      blingRequest('POST', '/produtos/estruturas', body)
        .then(r => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.data)); })
        .catch(e => { res.writeHead(500); res.end(e.message); });
    });
    return;
  }

  if (reqPath === '/api/bling/estoque' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      blingRequest('POST', '/estoques', body)
        .then(r => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.data)); })
        .catch(e => { res.writeHead(500); res.end(e.message); });
    });
    return;
  }

  if (reqPath === '/api/bling/estoques/saldos' && req.method === 'GET') {
    const idProduto = (parsed.query.idProduto || '').trim();
    const idDeposito = (parsed.query.idDeposito || '').trim();
    if (!idProduto) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'idProduto obrigatorio' }));
      return;
    }
    const depositoQuery = idDeposito ? `&idsDepositos[]=${encodeURIComponent(idDeposito)}` : '';
    blingRequest('GET', `/estoques/saldos?idsProdutos[]=${encodeURIComponent(idProduto)}${depositoQuery}&pagina=1&limite=100`)
      .then(r => { res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r.data)); })
      .catch(e => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  if (reqPath === '/api/gemini/generate' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      try {
        const { generateDescription } = require('./gemini');
        const html = await generateDescription(body.nome);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: html }));
      } catch (err) {
        console.error('Erro na rota Gemini:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Assistente de estoque: somente leitura. Ele recebe um resumo atual do
  // inventário e devolve recomendações; nunca chama Bling nem altera o banco.
  if (reqPath === '/api/assistente-estoque' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      const mensagem = String(body.mensagem || '').trim().slice(0, 2000);
      if (!mensagem) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Escreva uma pergunta para o assistente.' }));
        return;
      }
      if (!obterChaveDeepSeek()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'O assistente ainda não foi conectado. Configure a chave DEEPSEEK_API_KEY no servidor e reinicie-o.' }));
        return;
      }

      const historico = Array.isArray(body.historico) ? body.historico.slice(-6) : [];
      const mensagensAnteriores = historico
        .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        .map(item => ({ role: item.role, content: item.content.slice(0, 1500) }));
      const resumo = montarResumoEstoqueParaAssistente();
      const pedidoVerificacaoSku = /\b(verifica|verificar|consulta|consultar|existe)\b/i.test(mensagem) && /\b(sku|c[oó]digo|bling)\b/i.test(mensagem);
      const skuSolicitado = mensagem.match(/\b\d{6,}(?:_[A-Z0-9]+)*\b/i)?.[0] || '';
      let consultaSkuBling = null;
      if (pedidoVerificacaoSku && skuSolicitado) {
        try { consultaSkuBling = await verificarSkuNoBlingParaAssistente(skuSolicitado); }
        catch (erro) { consultaSkuBling = { codigo: skuSolicitado, erro: erro.message }; }
      }
      const instrucaoRascunhos = 'Voce pode preparar uma PROPOSTA de rascunho de kit quando o usuario pedir para montar ou criar um kit. Nao cadastre nem envie nada. Responda SOMENTE JSON valido: {"resposta":"texto","rascunhoKit":null ou {"nome":"KIT - nome","componentes":[{"codigo":"codigoParaKit","quantidade":1}]}}. Use apenas codigoParaKit dos produtos fornecidos. Se nao for pedido de kit, use rascunhoKit null.';
      const instrucao = `Você é o Assistente de Estoque da Puket. Responda em português do Brasil, de forma objetiva e útil.\n\nVocê só pode analisar os dados fornecidos abaixo. Não invente produtos, quantidades, vendas, pedidos, dados do Bling ou ações realizadas. Você NÃO tem permissão para alterar estoque, cadastrar produto, criar kit ou enviar algo ao Bling. Quando a pergunta pedir uma alteração, explique o que deve ser feito e peça confirmação em uma próxima etapa.\n\nAo analisar kits, use disponibilidadePelosComponentes como o máximo possível de kits pelos componentes; informe se algum componente não foi localizado. Para recomendações, destaque riscos, SKUs e quantidades. Se os dados não forem suficientes, diga isso claramente.\n\nResumo atual do inventário:\n${JSON.stringify(resumo)}`;

      try {
        const resposta = await consultarDeepSeek([
          { role: 'system', content: instrucao },
          { role: 'system', content: instrucaoRascunhos },
          ...mensagensAnteriores,
          { role: 'user', content: `${mensagem}${consultaSkuBling ? `\n\nConsulta ao Bling feita agora (somente leitura): ${JSON.stringify(consultaSkuBling)}` : ''}` },
        ]);
        let resultado = { resposta, rascunhoKit: null };
        try {
          const json = JSON.parse(resposta.replace(/^```json\s*|\s*```$/g, '').trim());
          if (typeof json.resposta === 'string') resultado.resposta = json.resposta;
          if (json.rascunhoKit && Array.isArray(json.rascunhoKit.componentes)) {
            const componentes = json.rascunhoKit.componentes.map(componente => {
              const codigo = String(componente.codigo || '').trim();
              const item = globalInventory.find(produto => !produto.isKit && [produto.codBase, produto.codebar, produto.referencia].map(valor => String(valor || '').trim()).includes(codigo));
              return item && codigo ? { codigo, nome: item.nome, quantidade: Math.max(1, normalizarNumero(componente.quantidade) || 1), disponivel: normalizarNumero(item.qtd), preco: normalizarNumero(item.preco) } : null;
            }).filter(Boolean);
            if (componentes.length === json.rascunhoKit.componentes.length && componentes.length >= 2) {
              resultado.rascunhoKit = { nome: String(json.rascunhoKit.nome || 'KIT - Novo Kit').slice(0, 180), componentes, disponibilidade: Math.floor(Math.min(...componentes.map(item => item.disponivel / item.quantidade))), preco: componentes.reduce((total, item) => total + item.preco * item.quantidade, 0) };
            }
          }
        } catch (_) { /* resposta livre do modelo */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      } catch (erro) {
        console.error('[ASSISTENTE-ESTOQUE] Erro:', erro.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Não consegui consultar o assistente: ${erro.message}` }));
      }
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Mensagem inválida: ' + erro.message }));
    });
    return;
  }

  if (reqPath === '/api/inteligencia/resumo' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(montarCentralInteligente()));
    return;
  }

  if (reqPath === '/api/inteligencia/bling-saude' && req.method === 'GET') {
    const health = blingEvents.health();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...health, webhookConfigured: !!BLING_WEBHOOK_SECRET }));
    return;
  }

  if (reqPath === '/api/inteligencia/bling-eventos' && req.method === 'GET') {
    const result = blingEvents.list({
      resource: parsed.query.resource,
      productId: parsed.query.productId,
      limit: parsed.query.limit,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (reqPath === '/api/inteligencia/estoque-comercial' && req.method === 'GET') {
    const codigo = String(parsed.query.codigo || '').trim();
    if (!codigo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Informe o SKU ou código do produto.' }));
      return;
    }
    consultarEstoqueComercial(codigo)
      .then(resultado => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch(erro => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: erro.message }));
      });
    return;
  }

  if (reqPath === '/api/inteligencia/produtos' && req.method === 'GET') {
    const termo = String(parsed.query.termo || '').trim().toLowerCase();
    const produtos = globalInventory
      .filter(item => {
        if (!termo) return true;
        return [item.nome, item.codebar, item.codBase, item.skuPai, item.skuFilho, item.referencia]
          .some(valor => String(valor || '').toLowerCase().includes(termo));
      })
      .slice(0, 50)
      .map(item => ({
        nome: item.nome || '',
        codigo: item.codBase || item.codebar || item.referencia || '',
        skuPai: item.skuPai || '',
        skuFilho: item.skuFilho || '',
        quantidade: normalizarNumero(item.qtd),
        preco: normalizarNumero(item.preco),
        imagem: item.imgUrl || '',
        isKit: !!item.isKit,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: produtos.length, produtos }));
    return;
  }

  if (reqPath === '/api/inteligencia/identidade' && req.method === 'GET') {
    const codigo = String(parsed.query.codigo || '').trim();
    resolverIdentidadeProduto(codigo)
      .then(resultado => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch(erro => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: erro.message }));
      });
    return;
  }

  if (reqPath === '/api/inteligencia/estoque-real' && req.method === 'GET') {
    const codigo = String(parsed.query.codigo || '').trim();
    compararEstoqueReal(codigo)
      .then(resultado => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch(erro => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: erro.message }));
      });
    return;
  }

  if (reqPath === '/api/inteligencia/auditoria-estoque' && req.method === 'POST') {
    readJsonBody(req)
      .then(body => auditarEstoqueEmLote(body.codigos, body.limite))
      .then(resultado => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch(erro => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: erro.message }));
      });
    return;
  }

  if (reqPath === '/api/inteligencia/duplicidades' && req.method === 'POST') {
    readJsonBody(req)
      .then(async body => {
        const limite = Math.min(50, Math.max(1, normalizarNumero(body.limite) || 20));
        const base = Array.isArray(body.codigos) && body.codigos.length
          ? body.codigos
          : globalInventory.filter(item => !item.isKit).map(item => item.codBase || item.skuFilho || item.codebar);
        const codigos = Array.from(new Set(base.map(valor => String(valor || '').trim()).filter(Boolean))).slice(0, limite);
        const duplicidades = [];
        const erros = [];
        for (const codigo of codigos) {
          try {
            const identidade = await resolverIdentidadeProduto(codigo);
            if (identidade.duplicidadeDetectada) {
              duplicidades.push({
                codigo,
                identidade: identidade.identidadeCanonica,
                produtosBling: identidade.produtosBling.filter(item => item.formato !== 'V'),
                alerta: identidade.alerta,
              });
            }
          } catch (erro) {
            erros.push({ codigo, erro: erro.message });
          }
        }
        return { atualizadoEm: new Date().toISOString(), analisados: codigos.length, totalDuplicidades: duplicidades.length, duplicidades, erros };
      })
      .then(resultado => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resultado));
      })
      .catch(erro => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: erro.message }));
      });
    return;
  }

  if (reqPath === '/api/inteligencia/kit-disponibilidade' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      const componentesEntrada = Array.isArray(body.componentes) ? body.componentes : [];
      if (componentesEntrada.length < 2) throw new Error('Informe pelo menos dois componentes.');
      const componentes = componentesEntrada.map(entrada => {
        const codigo = String(entrada.codigo || entrada || '').trim();
        const quantidade = Math.max(1, normalizarNumero(entrada.quantidade) || 1);
        const item = globalInventory.find(produto => !produto.isKit && [
          produto.codBase, produto.codebar, produto.referencia, produto.skuFilho
        ].map(valor => String(valor || '').trim()).includes(codigo));
        return {
          codigo,
          quantidade,
          encontrado: !!item,
          nome: item?.nome || '',
          estoque: item ? normalizarNumero(item.qtd) : 0,
          kitsPossiveis: item ? Math.floor(normalizarNumero(item.qtd) / quantidade) : 0,
        };
      });
      const disponibilidade = componentes.length
        ? Math.min(...componentes.map(item => item.kitsPossiveis))
        : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ disponibilidade, componentes }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/inteligencia/acoes' && req.method === 'GET') {
    const status = String(parsed.query.status || 'rascunho');
    const acoes = pendingActions.filter(acao => !status || acao.status === status).slice(-100).reverse();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: acoes.length, acoes }));
    return;
  }

  if (reqPath === '/api/inteligencia/acoes' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      const tiposPermitidos = [
        'sincronizar_estoque',
        'publicar_produto',
        'sincronizar_imagens',
        'atualizar_cadastro',
      ];
      const tipo = String(body.tipo || '');
      if (!tiposPermitidos.includes(tipo)) throw new Error('Tipo de rascunho não permitido.');
      const acao = {
        id: `acao-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tipo,
        titulo: String(body.titulo || 'Ação pendente').slice(0, 180),
        justificativa: String(body.justificativa || '').slice(0, 1000),
        payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
        status: 'rascunho',
        origem: 'mcp-estoque-puket',
        criadoEm: new Date().toISOString(),
      };
      pendingActions.push(acao);
      savePendingActions();
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, acao }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/inteligencia/acoes/status' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      const id = String(body.id || '');
      const status = String(body.status || '');
      if (!['aprovado', 'rejeitado'].includes(status)) throw new Error('Status não permitido.');
      const acao = pendingActions.find(item => item.id === id);
      if (!acao) throw new Error('Rascunho não encontrado.');
      if (acao.status !== 'rascunho') throw new Error('Este rascunho já foi revisado.');
      acao.status = status;
      acao.revisadoEm = new Date().toISOString();
      savePendingActions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        acao,
        aviso: 'A revisão foi registrada. Nenhuma alteração foi executada no Bling.',
      }));
    }).catch(erro => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: erro.message }));
    });
    return;
  }

  if (reqPath === '/api/kits/rascunhos' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      const rascunho = body.rascunho || {};
      const componentes = Array.isArray(rascunho.componentes) ? rascunho.componentes : [];
      if (componentes.length < 2) throw new Error('Um kit precisa de pelo menos dois componentes.');
      const codigos = componentes.map(componente => String(componente.codigo || '').trim());
      if (codigos.some(codigo => !codigo || codigo.includes('_'))) throw new Error('Componentes invalidos para o rascunho.');
      const itens = codigos.map(codigo => globalInventory.find(item => !item.isKit && [item.codBase, item.codebar, item.referencia].map(valor => String(valor || '').trim()).includes(codigo)));
      if (itens.some(item => !item)) throw new Error('Um dos componentes nao esta mais no inventario.');
      const codigoKit = codigos.join('_');
      if (globalInventory.some(item => item.isKit && (item.skuPai === codigoKit || item.codebar === codigoKit))) throw new Error('Este rascunho de kit ja esta no painel.');
      const disponibilidade = Math.floor(Math.min(...itens.map((item, indice) => normalizarNumero(item.qtd) / Math.max(1, normalizarNumero(componentes[indice].quantidade) || 1))));
      const preco = itens.reduce((total, item, indice) => total + normalizarNumero(item.preco) * Math.max(1, normalizarNumero(componentes[indice].quantidade) || 1), 0);
      const novoKit = { id: `kit-${Date.now()}`, isKit: true, nome: String(rascunho.nome || 'KIT - Rascunho').slice(0, 180), codebar: codigoKit, skuPai: codigoKit, skuFilho: codigoKit, tamanho: 'KIT', qtd: Math.max(0, disponibilidade), preco, categoria: 'Rascunho IA' };
      globalInventory.push(novoKit);
      saveDB();
      if (global._socketIo) global._socketIo.emit('sync_inventory', globalInventory);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, kit: novoKit }));
    }).catch(erro => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: erro.message })); });
    return;
  }

  if (reqPath === '/api/bling/verificar-lote' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      const codigos = body.codigos || [];
      const resultados = {};
      res.writeHead(200, { 'Content-Type': 'application/json' });

      const blingGet = async (cod) => {
        // pagina e limite são obrigatórios em alguns endpoints Bling v3
        return blingRequest('GET', `/produtos?codigo=${encodeURIComponent(cod)}&pagina=1&limite=1`);
      };

      for (const cod of codigos) {
        try {
          let r;
          try {
            r = await blingGet(cod);
          } catch (e1) {
            // 500 do Bling: aguarda 1s e tenta mais uma vez
            const isServerError = e1.message && e1.message.includes('"status":500');
            if (isServerError) {
              console.log(`[Bling] 500 em "${cod}", retentando...`);
              await new Promise(res => setTimeout(res, 1000));
              r = await blingGet(cod);
            } else {
              throw e1;
            }
          }

          if (r.data && r.data.data && r.data.data.length > 0) {
            const prodBasico = r.data.data[0];
            // Busca detalhes completos do produto para pegar as variacoes (IDs dos filhos)
            let variacoes = [];
            try {
              const rFull = await blingRequest('GET', `/produtos/${prodBasico.id}`);
              variacoes = rFull.data?.data?.variacoes || [];
            } catch (eVar) {
              // ignora se não conseguir buscar variações
            }
            resultados[cod] = {
              existe: true,
              id: prodBasico.id,
              data: { ...prodBasico, variacoes }
            };
          } else {
            resultados[cod] = { existe: false };
          }
        } catch (e) {
          console.error(`[Bling] Erro ao verificar "${cod}":`, e.message);
          resultados[cod] = { existe: false, error: e.message };
        }
      }
      res.end(JSON.stringify(resultados));
    });
    return;
  }

  if (reqPath === '/api/bling/lojas') {
    // Busca canais de venda do tipo Marketplace (agrupador=3) e filtra MercadoLivre
    blingRequest('GET', '/canais-venda?agrupador=3&limite=100&situacao=1')
      .then(r => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.data));
      })
      .catch(e => {
        // Tenta sem filtros se der 404
        blingRequest('GET', '/canais-venda?limite=100')
          .then(r => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r.data));
          })
          .catch(e2 => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e2.message }));
          });
      });
    return;
  }

  if (reqPath === '/api/bling/anuncios-ml' && req.method === 'GET') {
    const idLoja = parsed.query.idLoja;
    if (!idLoja) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'idLoja obrigatório' }));
      return;
    }
    (async () => {
      try {
        let pagina = 1;
        const limite = 100;
        const todosProdutosLoja = [];

        // Usa /produtos/lojas que retorna os produtos vinculados ao canal ML
        // (o endpoint /anuncios só retorna anúncios criados pelo módulo "Gestão de Anúncios" do Bling)
        while (true) {
          const r = await blingRequest('GET', `/produtos/lojas?idLoja=${encodeURIComponent(idLoja)}&pagina=${pagina}&limite=${limite}`);
          const items = r.data?.data || [];
          todosProdutosLoja.push(...items);
          console.log(`[ML] /produtos/lojas página ${pagina}: ${items.length} item(s)`);
          if (pagina === 1 && items.length > 0) {
            console.log('[ML DEBUG] Primeiro produto/loja:', JSON.stringify(items[0], null, 2));
          }
          if (items.length < limite) break;
          pagina++;
          if (pagina > 100) break; // cap de segurança (10.000 itens)
        }

        console.log(`[ML] Total produtos/lojas encontrados: ${todosProdutosLoja.length}`);

        // Mapear por ID do produto (variação/filho Bling) e por código MLB
        const anunciosPorProduto = {};
        const anunciosSku = {};

        todosProdutosLoja.forEach(a => {
          const idProd = a.produto?.id;
          const codigoMlb = (a.codigo || '').trim().toUpperCase(); // ex: "MLB4317146295"

          const info = {
            idAnuncioLoja: String(a.id),   // ID interno Bling do produto/loja
            codigoMlb: codigoMlb,          // ID do anúncio no ML (MLB...)
            preco: a.preco,
            situacao: 1,
            titulo: codigoMlb,
            idProduto: idProd,
            sku: codigoMlb
          };

          if (idProd) anunciosPorProduto[String(idProd)] = info;
          if (codigoMlb) anunciosSku[codigoMlb] = info;
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          total: todosProdutosLoja.length,
          anuncios: anunciosPorProduto,
          anunciosSku: anunciosSku
        }));
      } catch (e) {
        console.error('[ML] Erro ao buscar produtos/lojas:', e.message);

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // ── Catálogo Puket ──
  if (reqPath === '/api/catalogo/buscar') {
    const pesquisa = (parsed.query.q || '').trim();
    const ref = (parsed.query.ref || '').trim();
    const termo = pesquisa || ref;
    if (!termo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parâmetro q ou ref obrigatório' }));
      return;
    }
    console.log(`[CATÁLOGO] Buscando: "${termo}"`);
    catalogoBuscar(termo)
      .then(products => {
        // Se buscou por ref, tentar match exato pelo ID
        let result = products;
        if (ref) {
          const exact = products.find(p => p.id === ref || p.id.startsWith(ref));
          if (exact) result = [exact];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, total: result.length, produtos: result }));
      })
      .catch(e => {
        console.error('Erro catálogo:', e.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      });
    return;
  }

  // ── Campos Customizados do Bling ──
  if (reqPath === '/api/bling/campos-customizados' && req.method === 'GET') {
    (async () => {
      try {
        const r = await blingRequest('GET', '/campos-customizados?pagina=1&limite=100');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.data || {}));
      } catch (e) {
        console.error('[CAMPOS-CUSTOMIZADOS] Erro:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // ── Gerar Descrição de Kit com Gemini AI ──
  if (reqPath === '/api/gerar-descricao-kit' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => bodyStr += chunk);
    req.on('end', async () => {
      try {
        const { nomeKit, componentes } = JSON.parse(bodyStr);
        // Monta prompt
        const prompt = `Você é um especialista em e-commerce da marca Puket, uma marca brasileira de moda infantil e acessórios.
Crie uma descrição de produto completa e atrativa (máximo 400 caracteres) para um KIT que contém os seguintes itens:

Kit: ${nomeKit}
Componentes:
${componentes.map((c, i) => `${i + 1}. ${c.nome}${c.descricao ? ': ' + c.descricao : ''}`).join('\n')}

A descrição deve:
- Destacar os benefícios do kit como conjunto
- Mencionar brevemente cada componente
- Usar linguagem carinhosa e animada, adequada ao público infantil
- Ser objetiva e comercial
- NÃO usar emojis
- Responder APENAS com o texto da descrição, sem títulos ou marcações`;

        // Chama Gemini via API REST
        if (!GEMINI_API_KEY) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ descricao: '' }));
          return;
        }
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const geminiBody = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 200, temperature: 0.7 }
        };
        const https2 = require('https');
        const geminiReq = https2.request(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, (gemRes) => {
          let d = '';
          gemRes.on('data', c => d += c);
          gemRes.on('end', () => {
            try {
              const parsed = JSON.parse(d);
              const descricao = parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ descricao }));
            } catch (pe) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ descricao: '' }));
            }
          });
        });
        geminiReq.on('error', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ descricao: '' }));
        });
        geminiReq.write(JSON.stringify(geminiBody));
        geminiReq.end();
      } catch (e) {
        console.error('[GERAR-DESCRICAO] Erro:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Em produção o frontend fica no Lovable. Não exponha arquivos locais do
  // backend (tokens, banco, logs ou .env) como conteúdo estático.
  if (!SERVE_FRONTEND) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint não encontrado.' }));
    return;
  }

  // Estáticos (somente para desenvolvimento local)
  let filePath = reqPath === '/' ? '/scanner.html' : reqPath;
  if (reqPath === '/dashboard') filePath = '/dashboard.html';
  if (reqPath === '/scanner-numeros') filePath = '/scanner-numeros.html';
  if (reqPath === '/agente') filePath = '/agente.html';
  if (reqPath === '/ofertas') filePath = '/ofertas.html';
  if (reqPath === '/agente-whatsapp') filePath = '/agente-whatsapp.html';
  if (reqPath === '/inteligencia') filePath = '/inteligencia.html';
  if (reqPath === '/saida') filePath = '/saida.html';
  filePath = path.join(ROOT, decodeURIComponent(filePath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Nao encontrado: ' + reqPath); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── IP local ──
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// Em hospedagens como Railway, o proxy da plataforma fornece HTTPS e encaminha
// a requisição para este servidor HTTP. O certificado local só é necessário no
// modo de desenvolvimento.
if (IS_PRODUCTION) {
  const server = http.createServer(handler);
  setupSocket(server);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Gestão de Estoque API ativa na porta ${PORT}`);
  });
} else try {
  const selfsigned = require('selfsigned');
  const attrs = [{ name: 'commonName', value: 'gestao-estoque.local' }];
  const pems = selfsigned.generate(attrs, {
    algorithm: 'sha256',
    days: 365,
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName', altNames: [
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: getLocalIP() },
        ]
      },
    ],
  });

  const server = https.createServer({ key: pems.private, cert: pems.cert }, handler);
  setupSocket(server);

  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║    SERVIDOR ATIVO – Gestão de Estoque    ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Local:  https://localhost:${PORT}          ║`);
    console.log(`║  Rede:   https://${ip}:${PORT}      ║`);
    console.log('╠══════════════════════════════════════════╣');
    console.log('║  No celular: acesse a URL acima          ║');
    console.log('║  Aceite o aviso de certificado           ║');
    console.log('║  ("Avançado > Continuar mesmo assim")    ║');
    console.log('╚══════════════════════════════════════════╝\n');
  });

} catch (e) {
  // selfsigned não instalado — fallback HTTP (câmera não vai funcionar)
  console.warn('\n⚠ selfsigned não encontrado. Rodando em HTTP (sem câmera no celular).');
  console.warn('  Execute:  npm install\n');
  const server = http.createServer(handler);
  setupSocket(server);

  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log(`Servidor HTTP: http://${ip}:${PORT}`);
  });
}
