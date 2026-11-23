const { MercadoPagoConfig, User } = require('mercadopago');
let cachedUntil = 0;
let cachedAccount = '';
async function verifyLiveMerchant(token, expectedId) {
  if (!expectedId || !/^\d+$/.test(expectedId)) throw new Error('Vendedor real ainda não configurado.');
  if (cachedAccount === expectedId && Date.now() < cachedUntil) return true;
  const profile = await new User(new MercadoPagoConfig({ accessToken: token, options: { timeout: 8000, maxRetries: 0 } })).get();
  if (String(profile.id) !== expectedId || profile.site_id !== 'MLB' || !Array.isArray(profile.tags) || profile.tags.includes('test_user')) throw new Error('A credencial não pertence ao vendedor real esperado.');
  cachedAccount = expectedId; cachedUntil = Date.now() + 5 * 60 * 1000;
  return true;
}
module.exports = { verifyLiveMerchant };
