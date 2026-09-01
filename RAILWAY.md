# Publicação do backend no Railway

Este projeto pode funcionar como a API externa de um frontend hospedado no Lovable.

## Configuração no Railway

1. Crie um projeto a partir do repositório GitHub deste backend.
2. No serviço, cadastre as variáveis listadas em `.env.example`.
3. Use `NODE_ENV=production` e `SERVE_FRONTEND=false`.
4. Em `ALLOWED_ORIGINS`, informe o endereço publicado pelo Lovable sem barra final.
5. Em `BLING_REDIRECT_URI`, informe a URL pública do backend seguida de `/bling/callback`.
6. Gere um domínio público para o serviço e confirme que `https://DOMINIO/health` responde com `status: ok`.

O Railway fornece a variável `PORT` e o HTTPS automaticamente. Não é necessário instalar ou enviar certificados.

## Variáveis obrigatórias para as integrações

- `LINX_LOGIN`
- `LINX_PASSWORD`
- `LINX_PORTAL_ID=7776`
- `LINX_COMPANY_ID=1`
- `LINX_TOKEN` é apenas um fallback opcional
- `BLING_CLIENT_ID`
- `BLING_CLIENT_SECRET`
- `BLING_REDIRECT_URI`
- `BLING_WEBHOOK_SECRET`
- `GEMINI_API_KEY` quando a geração de descrições estiver habilitada
- `DEEPSEEK_API_KEY` quando o assistente de estoque estiver habilitado

## Ligação com o Lovable

No frontend, mantenha uma variável pública contendo apenas a URL da API, por exemplo:

```text
VITE_API_URL=https://seu-backend.up.railway.app
```

Credenciais do Bling, Linx e serviços de IA nunca devem ser adicionadas ao frontend.

## Persistência

O código atual ainda usa arquivos JSON locais para inventário, tokens e históricos. O filesystem de uma hospedagem pode ser substituído durante novos deploys. Antes do uso definitivo pela equipe, migre esses dados para PostgreSQL ou configure um volume persistente no Railway.
