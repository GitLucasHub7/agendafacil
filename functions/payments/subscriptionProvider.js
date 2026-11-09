const { toCents } = require("../lib/plan");

const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

function normalizePreapproval(r) {
  const ar = r.auto_recurring || {};
  return {
    id: String(r.id),
    status: r.status === "canceled" ? "cancelled" : r.status,
    externalReference: r.external_reference === undefined || r.external_reference === null ? null : String(r.external_reference),
    amountCents: toCents(ar.transaction_amount),
    currency: ar.currency_id || null,
    frequency: ar.frequency === undefined ? null : Number(ar.frequency),
    frequencyType: ar.frequency_type || null,
    payerEmail: r.payer_email || null,
    initPoint: r.init_point || null,
    nextPaymentDate: ms(r.next_payment_date),
    lastModified: ms(r.last_modified),
  };
}

function normalizeInvoice(r) {
  const payment = r.payment || {};
  return {
    id: String(r.id),
    preapprovalId: r.preapproval_id === undefined || r.preapproval_id === null ? null : String(r.preapproval_id),
    status: r.status || null,
    paymentId: payment.id === undefined || payment.id === null ? null : String(payment.id),
    paymentStatus: payment.status || null,
    paymentStatusDetail: payment.status_detail || null,
    amountCents: toCents(r.transaction_amount),
    currency: r.currency_id || null,
    debitDateMs: ms(r.debit_date),
    retryAttempt: r.retry_attempt || 0,
    externalReference: r.external_reference === undefined || r.external_reference === null ? null : String(r.external_reference),
  };
}

/**
 * Provider de ASSINATURAS do Mercado Pago (API /preapproval e /authorized_payments).
 * O access token vem do Secret Manager (nunca do front-end). `sdk` é injetável nos testes.
 */
function createSubscriptionProvider(accessToken, sdk = require("mercadopago")) {
  // Retentativas de POST não podem repetir /preapproval após um resultado incerto.
  // A recuperação durável decide quando uma nova operação é segura.
  const config = new sdk.MercadoPagoConfig({ accessToken, options: { timeout: 8000, maxRetries: 0 } });
  const preapprovals = new sdk.PreApproval(config);
  const invoices = new sdk.Invoice(config);
  const payments = new sdk.Payment(config);

  // Uma página vazia/parcial não pode ocultar uma assinatura e liberar cobrança duplicada.
  async function searchAll(client, options, stopWhen) {
    const result = [];
    const limit = 50;
    for (let offset = 0; offset < 1000; offset += limit) {
      const response = await client.search({ options: { ...options, limit, offset } });
      if (!response || !Array.isArray(response.results)) throw new Error("Resposta de busca incompleta do Mercado Pago.");
      const page = response.results;
      result.push(...page);
      if (stopWhen && page.some(stopWhen)) return result;
      const total = response.paging && Number(response.paging.total);
      if (Number.isFinite(total)) {
        if (offset + page.length >= total) return result;
        if (page.length < limit) throw new Error("Paginação incompleta do Mercado Pago.");
      } else if (page.length < limit) return result;
    }
    throw new Error("Busca excedeu o limite seguro; reconciliação manual necessária.");
  }

  return {
    // Assinatura SEM plano, status "pending": o comprador escolhe o meio de pagamento no checkout hospedado
    // do Mercado Pago (init_point). Nenhum dado de cartão passa por este servidor.
    async createPreapproval({ reason, externalReference, payerEmail, backUrl, amountCents, currency, frequency, frequencyType }) {
      const response = await preapprovals.create({
        body: {
          reason,
          external_reference: externalReference,
          payer_email: payerEmail,
          back_url: backUrl,
          status: "pending",
          auto_recurring: {
            frequency,
            frequency_type: frequencyType,
            transaction_amount: amountCents / 100,
            currency_id: currency,
          },
        },
        // A API Preapproval não garante idempotência deste header. A trava persistida e a
        // recuperação por external_reference são obrigatórias, inclusive após timeout.
        requestOptions: { idempotencyKey: `sub_${externalReference}` },
      });
      return normalizePreapproval(response);
    },

    // Recuperação de criação órfã. A busca do SDK NÃO tem filtro por external_reference (só payer_email, status, ...),
    // então filtramos pelo e-mail do pagador e conferimos a referência localmente. NÃO verificado em sandbox.
    // Devolve a assinatura (não cancelada) ou null; lança se a consulta falhar (resultado desconhecido).
    async findPreapprovalByExternalReference({ externalReference, payerEmail }) {
      if (!externalReference || !payerEmail) throw new Error("Referência e pagador necessários para recuperar assinatura.");
      const matches = (r) => String(r.external_reference) === String(externalReference) && !["cancelled", "canceled"].includes(String(r.status).toLowerCase());
      const results = await searchAll(preapprovals, { payer_email: payerEmail }, matches);
      const hit = results
        .map(normalizePreapproval)
        .find((p) => p.externalReference === String(externalReference) && String(p.status).toLowerCase() !== "cancelled");
      return hit || null;
    },

    async getPreapproval(id) {
      return normalizePreapproval(await preapprovals.get({ id: String(id) }));
    },

    async cancelPreapproval(id) {
      const pre = normalizePreapproval(await preapprovals.update({ id: String(id), body: { status: "cancelled" } }));
      if (pre.status !== "cancelled") throw new Error("Cancelamento ainda não confirmado pelo Mercado Pago.");
      return pre;
    },

    async getInvoice(id) {
      return normalizeInvoice(await invoices.get({ id: String(id) }));
    },

    async searchInvoices({ preapprovalId, paymentId }) {
      const options = { limit: 50 };
      if (preapprovalId) options.preapproval_id = String(preapprovalId);
      if (paymentId) options.payment_id = Number(paymentId);
      return (await searchAll(invoices, options)).map(normalizeInvoice);
    },

    async getPayment(id) {
      const r = await payments.get({ id: String(id) });
      return { id: String(r.id), status: r.status, statusDetail: r.status_detail || null, amountCents: toCents(r.transaction_amount), currency: r.currency_id || null, externalReference: r.external_reference || null };
    },
  };
}

module.exports = { createSubscriptionProvider, normalizePreapproval, normalizeInvoice };
