const { defineSecret, defineString } = require("firebase-functions/params");
const { getFirestore } = require('firebase-admin/firestore');
const { createRoutedProvider } = require('./routedProvider');
const { secrets: baseSecrets } = require("./index");
const { createSubscriptionProvider } = require("./subscriptionProvider");

// Segredo da assinatura do webhook (painel do Mercado Pago > Suas integrações > Webhooks):
//   firebase functions:secrets:set MERCADOPAGO_WEBHOOK_SECRET
const webhookSecret = defineSecret("MERCADOPAGO_WEBHOOK_SECRET");
const liveAccessToken = defineSecret('MERCADOPAGO_LIVE_ACCESS_TOKEN');
const liveWebhookSecret = defineSecret('MERCADOPAGO_LIVE_WEBHOOK_SECRET');
const paymentEnvironment = defineString('PAYMENT_ENVIRONMENT', { default: 'test' });
const liveSellerId = defineString('LIVE_SELLER_ID', { default: '' });
const { verifyLiveMerchant } = require('./liveMerchant');
const verifyProductionAccount = () => verifyLiveMerchant(liveAccessToken.value(), liveSellerId.value());
function getPaymentEnvironment() {
  const value = paymentEnvironment.value();
  if (!['test', 'live'].includes(value)) throw new Error('PAYMENT_ENVIRONMENT inválido.');
  return value;
}

// Reaproveita o MESMO segredo de access token já existente (MERCADOPAGO_ACCESS_TOKEN).
function getSubscriptionProvider(environment = getPaymentEnvironment()) {
  return createRoutedProvider({ db: getFirestore(), fallbackEnvironment: environment, providerFor: value => {
    const provider = createSubscriptionProvider(value === 'live' ? liveAccessToken.value() : baseSecrets[0].value());
    if (value === 'live') {
      const create = provider.createPreapproval;
      provider.createPreapproval = async args => { await verifyProductionAccount(); return create(args); };
    }
    return provider;
  } });
}

module.exports = {
  getSubscriptionProvider,
  getPaymentEnvironment,
  verifyProductionAccount,
  getWebhookSecret: () => webhookSecret.value(),
  getLiveWebhookSecret: () => liveWebhookSecret.value(),
  secrets: [...baseSecrets, webhookSecret, liveAccessToken],
  liveWebhookSecrets: [...baseSecrets, liveAccessToken, liveWebhookSecret],
};
