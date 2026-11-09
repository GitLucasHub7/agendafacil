/**
 * Contrato de um provedor de pagamento.
 *
 * Qualquer gateway novo (Asaas, Pagar.me, Stripe Brasil, etc.) implementa
 * essas duas funções e passa a valer no sistema inteiro — nenhum outro
 * arquivo (index.js, app.js, site.js) precisa saber qual gateway está por
 * trás. Pra trocar de gateway no futuro: escreva um novo arquivo aqui
 * dentro seguindo esse mesmo formato e aponte pra ele em `payments/index.js`.
 *
 * @typedef {Object} ChargeParams
 * @property {number} amount - valor em reais (ex.: 49)
 * @property {string} description - descrição que aparece pro pagador
 * @property {string} payerEmail - e-mail de quem paga
 * @property {string} externalReference - id único gerado por nós pra rastrear essa cobrança
 *
 * @typedef {Object} ChargeResult
 * @property {string} id - id da cobrança no gateway
 * @property {string} status - status cru retornado pelo gateway
 * @property {string|null} qrCode - código Pix "copia e cola" (quando aplicável)
 * @property {string|null} qrCodeBase64 - imagem do QR Code em base64 (quando aplicável)
 *
 * @typedef {Object} StatusResult
 * @property {string} id
 * @property {string} status - ex.: "approved", "pending", "rejected"
 * @property {string} [externalReference]
 *
 * @typedef {Object} PaymentProvider
 * @property {(params: ChargeParams) => Promise<ChargeResult>} createCharge
 * @property {(chargeId: string) => Promise<StatusResult>} getStatus
 */

module.exports = {};
