// Inicia o backend local em HTTP para uso atrás do HTTPS do Cloudflare Tunnel.
// Definimos o modo antes de carregar server.js, pois a configuração é lida
// durante a inicialização do módulo.
process.env.NODE_ENV = 'production';
process.env.PORT = process.env.PORT || '3030';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  || 'https://puket-sku-magic.lovable.app';

require('./server');
