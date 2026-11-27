const { PLAN, toCents } = require('../lib/plan');
const PREFIX = 'af_manual_';
const isManualId = id => typeof id === 'string' && id.startsWith(PREFIX);

// Adapter for a non-recurring, one-month checkout. The local entitlement engine
// reuses its invoice ledger; PREFIX identifiers are LOCAL, never sent to /preapproval.
function withManualCheckout({ recurring, db, accessToken, environment, verifyMerchant = async () => {}, sdk = require('mercadopago'), now = () => Date.now() }) {
  const client = new sdk.MercadoPagoConfig({ accessToken, options: { timeout: 12000, retries: 0 } });
  const preferences = new sdk.Preference(client);
  const payments = new sdk.Payment(client);
  async function local(id) {
    if (!isManualId(id)) throw new Error('Referência manual inválida.');
    const snap = await db.collection('subscriptions').doc(id.slice(PREFIX.length)).get();
    if (!snap.exists || snap.data().billingMode !== 'manual' || snap.data().paymentEnvironment !== environment) throw new Error('Cobrança manual não encontrada neste ambiente.');
    return { id: snap.id, ...snap.data() };
  }
  function header(s) {
    return { id: PREFIX + s.id, externalReference: s.id, status: s.requestedCancel ? 'cancelled' : 'pending', amountCents: PLAN.priceCents, currency: PLAN.currency, frequency: 1, frequencyType: 'months', initPoint: s.manualCheckoutUrl || null, nextPaymentDate: null };
  }
  function invoice(p, s) {
    if (p.external_reference !== PREFIX + s.id || p.live_mode !== (environment === 'live') || p.currency_id !== PLAN.currency) throw new Error('Pagamento não pertence à cobrança neste ambiente.');
    return { id: 'manual_' + p.id, preapprovalId: PREFIX + s.id, paymentId: String(p.id), paymentStatus: p.status, status: 'processed', amountCents: toCents(p.transaction_amount), currency: p.currency_id, debitDateMs: Date.parse(p.date_approved || p.date_created) || null };
  }
  async function allPayments(s) {
    const result = [];
    for (let offset = 0; offset < 10000; offset += 50) {
      const page = await payments.search({ options: { external_reference: PREFIX + s.id, limit: 50, offset, sort: 'date_created', criteria: 'asc' } });
      if (!Array.isArray(page.results) || !Number.isFinite(page.paging?.total)) throw new Error('Busca de pagamentos incompleta.');
      result.push(...page.results.filter(p => p.external_reference === PREFIX + s.id));
      if (offset + page.results.length >= page.paging.total) return result;
      if (page.results.length !== 50) throw new Error('Busca de pagamentos incompleta.');
    }
    throw new Error('Limite de pagamentos excedido.');
  }
  async function create(args) {
    const s = await local(PREFIX + args.externalReference);
    if (s.manualCheckoutUrl && s.manualCheckoutExpiresAt > now()) return header(s);
    await verifyMerchant();
    const expiresAt = now() + 2 * 86400000;
    const result = await preferences.create({ body: {
      items: [{ id: 'site-month', title: 'AgendaFácil — 1 mês de site e agenda, sem renovação automática', quantity: 1, unit_price: PLAN.priceCents / 100, currency_id: PLAN.currency }],
      payer: { email: args.payerEmail }, external_reference: PREFIX + s.id, metadata: { af_generation: s.manualCheckoutGeneration || 0 },
      back_urls: { success: args.backUrl, pending: args.backUrl, failure: args.backUrl }, auto_return: 'approved',
      payment_methods: { installments: 1 },
      expires: true, expiration_date_from: new Date(now()).toISOString(), expiration_date_to: new Date(expiresAt).toISOString(),
    }, requestOptions: { idempotencyKey: PREFIX + s.id + '_' + (s.manualCheckoutGeneration || 0) } });
    if (!/^https:\/\/([a-z0-9-]+\.)*mercadopago\.com(\.[a-z]{2})?\//i.test(result.init_point || '')) throw new Error('Checkout devolveu endereço inválido.');
    // Never recreate after uncertain persistence: the caller retains its creation lock.
    await db.collection('subscriptions').doc(s.id).update({ manualPreferenceId: String(result.id), manualCheckoutUrl: result.init_point, manualCheckoutExpiresAt: expiresAt });
    return header({ ...s, manualCheckoutUrl: result.init_point });
  }
  async function byReference(args) {
    const snap = await db.collection('subscriptions').doc(args.externalReference).get();
    return snap.exists && snap.data().billingMode === 'manual';
  }
  return {
    ...recurring,
    async createPreapproval(args) { return await byReference(args) ? create(args) : recurring.createPreapproval(args); },
    async findPreapprovalByExternalReference(args) {
      if (!await byReference(args)) return recurring.findPreapprovalByExternalReference(args);
      const s = await local(PREFIX + args.externalReference);
      // Unknown creation must not create a second checkout. A persisted URL is recoverable.
      if (s.manualCheckoutUrl) return header(s);
      const page = await preferences.search({ options: { external_reference: PREFIX + s.id, limit: 100, offset: 0 } });
      if (!Array.isArray(page.elements) || !Number.isFinite(page.total) || page.total > page.elements.length) throw new Error('Busca de checkout incompleta.');
      for (const candidate of page.elements) {
        const pref = await preferences.get({ preferenceId: candidate.id });
        if (pref.external_reference !== PREFIX + s.id || Number(pref.metadata?.af_generation || 0) !== (s.manualCheckoutGeneration || 0)) continue;
        if (!/^https:\/\/([a-z0-9-]+\.)*mercadopago\.com(\.[a-z]{2})?\//i.test(pref.init_point || '')) throw new Error('Checkout inválido na recuperação.');
        await db.collection('subscriptions').doc(s.id).update({ manualPreferenceId: String(pref.id), manualCheckoutUrl: pref.init_point, manualCheckoutExpiresAt: Date.parse(pref.expiration_date_to) });
        return header({ ...s, manualCheckoutUrl: pref.init_point });
      }
      if (now() - s.creationStartedAtMs > 30 * 60000) return null;
      throw new Error('O checkout ainda está sendo confirmado.');
    },
    async getPreapproval(id) { return isManualId(id) ? header(await local(id)) : recurring.getPreapproval(id); },
    async cancelPreapproval(id) {
      if (!isManualId(id)) return recurring.cancelPreapproval(id);
      const s = await local(id);
      if (s.manualPreferenceId) await preferences.update({ id: s.manualPreferenceId, updatePreferenceRequest: { expires: true, expiration_date_to: new Date(now() - 1000).toISOString() } });
      for (const p of await allPayments(s)) {
        if (['approved', 'in_mediation'].includes(p.status) && (!s.accessUntil || s.accessUntil > now())) throw new Error('Pagamento já recebido. Atualize o status antes de trocar a cobrança.');
        if (['pending', 'in_process', 'authorized'].includes(p.status)) await payments.cancel({ id: String(p.id) });
      }
      return { ...header(s), status: 'cancelled' };
    },
    async searchInvoices(args) {
      if (isManualId(args.preapprovalId)) {
        const s = await local(args.preapprovalId);
        return (await allPayments(s)).map(p => invoice(p, s));
      }
      if (args.paymentId) {
        const p = await payments.get({ id: String(args.paymentId) });
        if (isManualId(p.external_reference)) return [invoice(p, await local(p.external_reference))];
      }
      return recurring.searchInvoices(args);
    },
  };
}
module.exports = { withManualCheckout, PREFIX, isManualId };
