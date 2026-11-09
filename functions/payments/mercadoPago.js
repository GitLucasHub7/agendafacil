const { MercadoPagoConfig, Payment } = require("mercadopago");

/**
 * Cria um PaymentProvider (ver provider.js) baseado no Mercado Pago.
 * @param {string} accessToken - Access Token privado do Mercado Pago (nunca no front-end)
 * @returns {import('./provider')}
 */
function createProvider(accessToken) {
  const client = new MercadoPagoConfig({ accessToken, options: { timeout: 8000 } });
  const paymentClient = new Payment(client);

  return {
    async createCharge({ amount, description, payerEmail, externalReference }) {
      const response = await paymentClient.create({
        body: {
          transaction_amount: amount,
          description,
          payment_method_id: "pix",
          payer: { email: payerEmail },
          external_reference: externalReference,
        },
        requestOptions: { idempotencyKey: externalReference },
      });

      const transactionData = response?.point_of_interaction?.transaction_data || {};
      return {
        id: String(response.id),
        status: response.status,
        qrCode: transactionData.qr_code || null,
        qrCodeBase64: transactionData.qr_code_base64 || null,
      };
    },

    async getStatus(chargeId) {
      const response = await paymentClient.get({ id: chargeId });
      return {
        id: String(response.id),
        status: response.status,
        externalReference: response.external_reference,
      };
    },
  };
}

module.exports = { createProvider };
