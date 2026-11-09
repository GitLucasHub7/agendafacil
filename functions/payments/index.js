const { defineSecret } = require("firebase-functions/params");

// Segredo lido do Secret Manager — configure com:
//   firebase functions:secrets:set MERCADOPAGO_ACCESS_TOKEN
const mercadoPagoAccessToken = defineSecret("MERCADOPAGO_ACCESS_TOKEN");

/**
 * Retorna o PaymentProvider ativo no momento.
 *
 * PRA TROCAR DE GATEWAY NO FUTURO (ex.: Asaas):
 *   1. Crie payments/asaas.js implementando createCharge()/getStatus()
 *      no mesmo formato de payments/mercadoPago.js
 *   2. Troque a linha abaixo pra usar esse novo arquivo
 * Nenhum outro arquivo do projeto precisa mudar.
 */
function getProvider() {
  const { createProvider } = require("./mercadoPago");
  return createProvider(mercadoPagoAccessToken.value());
}

module.exports = { getProvider, secrets: [mercadoPagoAccessToken] };
