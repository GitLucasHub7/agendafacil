const { defineSecret } = require("firebase-functions/params");
const { secrets: baseSecrets } = require("./index");
const { createSubscriptionProvider } = require("./subscriptionProvider");

// Segredo da assinatura do webhook (painel do Mercado Pago > Suas integrações > Webhooks):
//   firebase functions:secrets:set MERCADOPAGO_WEBHOOK_SECRET
const webhookSecret = defineSecret("MERCADOPAGO_WEBHOOK_SECRET");

// Reaproveita o MESMO segredo de access token já existente (MERCADOPAGO_ACCESS_TOKEN).
function getSubscriptionProvider() {
  return createSubscriptionProvider(baseSecrets[0].value());
}

module.exports = {
  getSubscriptionProvider,
  getWebhookSecret: () => webhookSecret.value(),
  secrets: [...baseSecrets, webhookSecret],
};
