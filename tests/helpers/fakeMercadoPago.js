// Gateway Mercado Pago FALSO (sandbox em memória) com a mesma interface de payments/subscriptionProvider.js.
// Nenhuma chamada de rede, nenhum dinheiro real. Permite simular aprovação, recusa, estorno, etc.
function createFakeGateway() {
  const pre = new Map();
  const inv = new Map();
  const pay = new Map();
  const calls = [];
  let seq = 1000;
  const g = { calls, pre, inv, pay, failNext: null, delayMs: 0, badInitPoint: false, slowReadMs: 0, clock: () => Date.now() };

  const copy = (o) => ({ ...o });
  const maybeFail = (name) => {
    if (g.failNext === name) {
      g.failNext = null;
      throw new Error(`gateway indisponível (${name})`);
    }
  };
  const notFound = (what, id) => Object.assign(new Error(`${what} ${id} não encontrado`), { status: 404 });

  g.provider = {
    async createPreapproval(p) {
      calls.push(["createPreapproval", p]);
      if (g.delayMs) await new Promise((r) => setTimeout(r, g.delayMs)); // a chamada remota demora: abre a janela da corrida
      maybeFail("createPreapproval");
      const id = `PRE${++seq}`;
      pre.set(id, { id, status: "pending", externalReference: p.externalReference, amountCents: p.amountCents, currency: p.currency, frequency: p.frequency, frequencyType: p.frequencyType, payerEmail: p.payerEmail, initPoint: g.badInitPoint ? "https://evil.example/checkout" : `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=${id}`, nextPaymentDate: null, lastModified: g.clock() });
      return copy(pre.get(id));
    },
    async findPreapprovalByExternalReference({ externalReference }) {
      calls.push(["findPreapprovalByExternalReference", externalReference]);
      maybeFail("findPreapproval");
      const hit = [...pre.values()].find((p) => p.externalReference === String(externalReference) && p.status !== "cancelled");
      return hit ? copy(hit) : null;
    },
    async getPreapproval(id) {
      calls.push(["getPreapproval", id]);
      maybeFail("getPreapproval");
      if (!pre.has(id)) throw notFound("assinatura", id);
      return copy(pre.get(id));
    },
    async cancelPreapproval(id) {
      calls.push(["cancelPreapproval", id]);
      maybeFail("cancelPreapproval");
      if (!pre.has(id)) throw notFound("assinatura", id);
      pre.get(id).status = "cancelled";
      return copy(pre.get(id));
    },
    async getInvoice(id) {
      calls.push(["getInvoice", id]);
      if (g.slowReadMs) await new Promise((r) => setTimeout(r, g.slowReadMs));
      maybeFail("getInvoice");
      if (!inv.has(String(id))) throw notFound("cobrança", id);
      return gwInvoice(String(id));
    },
    async searchInvoices({ preapprovalId, paymentId }) {
      calls.push(["searchInvoices", { preapprovalId, paymentId }]);
      maybeFail("searchInvoices");
      return [...inv.keys()].map(gwInvoice).filter((i) => (!preapprovalId || i.preapprovalId === String(preapprovalId)) && (!paymentId || i.paymentId === String(paymentId)));
    },
    async getPayment(id) {
      calls.push(["getPayment", id]);
      if (!pay.has(String(id))) throw notFound("pagamento", id);
      const p = pay.get(String(id));
      return { id: String(id), status: p.status, statusDetail: null, amountCents: p.amountCents, externalReference: null };
    },
  };

  function gwInvoice(id) {
    const i = inv.get(id);
    const p = i.paymentId ? pay.get(i.paymentId) : null;
    return { id, preapprovalId: i.preapprovalId, status: i.status, paymentId: i.paymentId, paymentStatus: p ? p.status : null, paymentStatusDetail: null, amountCents: i.amountCents, currency: "BRL", debitDateMs: i.debitDateMs || null, retryAttempt: i.retryAttempt || 0, externalReference: null };
  }

  // --- simulação do que acontece no Mercado Pago ---
  g.authorize = (preId) => { pre.get(preId).status = "authorized"; };
  g.setPreStatus = (preId, status) => { pre.get(preId).status = status; };
  g.charge = (preId, paymentStatus, { amountCents = 2190, invoiceStatus = "processed" } = {}) => {
    const invId = String(++seq);
    const payId = String(++seq);
    pay.set(payId, { status: paymentStatus, amountCents });
    inv.set(invId, { preapprovalId: preId, status: invoiceStatus, paymentId: payId, amountCents });
    return { invoiceId: invId, paymentId: payId };
  };
  g.setPaymentStatus = (paymentId, status) => { pay.get(String(paymentId)).status = status; };
  g.count = (name) => calls.filter((c) => c[0] === name).length;
  return g;
}

module.exports = { createFakeGateway };
