const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubscriptionProvider } = require("../../functions/payments/subscriptionProvider");
const terms = { reason: "Plano", externalReference: "sub-local", payerEmail: "offline@example.test", backUrl: "https://demo-agendafacil.web.app/painel.html", amountCents: 2190, currency: "BRL", frequency: 1, frequencyType: "months" };

test("SDK real: criação, consulta, busca e cancelamento usam os contratos HTTP esperados", async (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  t.after(() => { global.fetch = originalFetch; });
  const pre = { id: "pre-1", external_reference: "sub-local", status: "pending", init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre-1", auto_recurring: { transaction_amount: 21.9, currency_id: "BRL", frequency: 1, frequency_type: "months" } };
  global.fetch = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.origin, "https://api.mercadopago.com");
    // O SDK inclui barra final em POST /preapproval/; ambos identificam o mesmo recurso.
    u.pathname = u.pathname.replace(/\/$/, "");
    const call = { method: options.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    let body;
    if (u.pathname === "/preapproval/search") body = { paging: { total: 1 }, results: [pre] };
    else if (u.pathname === "/authorized_payments/search") body = { paging: { total: 0 }, results: [] };
    else if (u.pathname === "/authorized_payments/2") body = { id: 2, preapproval_id: "pre-1" };
    else if (u.pathname === "/v1/payments/3") body = { id: 3, status: "refunded", transaction_amount: 21.9, currency_id: "BRL" };
    else if (["/preapproval", "/preapproval/pre-1"].includes(u.pathname)) body = { ...pre, status: options.method === "PUT" ? "cancelled" : "pending" };
    else throw new Error("Endpoint inesperado: " + u.pathname);
    return Response.json(body);
  };
  const p = createSubscriptionProvider("FAKE-OFFLINE");
  await p.createPreapproval(terms);
  await p.getPreapproval("pre-1");
  await p.findPreapprovalByExternalReference({ externalReference: "sub-local", payerEmail: terms.payerEmail });
  await p.cancelPreapproval("pre-1");
  await p.getInvoice("2");
  await p.searchInvoices({ paymentId: "3" });
  assert.equal((await p.getPayment("3")).currency, "BRL");
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [["POST", "/preapproval"], ["GET", "/preapproval/pre-1"], ["GET", "/preapproval/search"], ["PUT", "/preapproval/pre-1"], ["GET", "/authorized_payments/2"], ["GET", "/authorized_payments/search"], ["GET", "/v1/payments/3"]]);
  assert.equal(calls[0].body.status, "pending");
  assert.equal(calls[0].body.auto_recurring.transaction_amount, 21.9);
  assert.equal(calls[0].body.external_reference, "sub-local");
  assert.equal(calls[0].body.card_token_id, undefined);
  assert.equal(calls[2].query.payer_email, terms.payerEmail);
  assert.equal(calls[2].query.offset, "0");
  assert.equal(calls[5].query.payment_id, "3");
});

test("SDK real não repete criação automaticamente após HTTP 500", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let attempts = 0;
  global.fetch = async () => { attempts++; return Response.json({ message: "resultado incerto" }, { status: 500 }); };
  await assert.rejects(createSubscriptionProvider("FAKE-OFFLINE").createPreapproval(terms));
  assert.equal(attempts, 1);
});
