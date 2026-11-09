const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubscriptionProvider, normalizeInvoice, normalizePreapproval } = require("../../functions/payments/subscriptionProvider");
const { verifySignature, signForTest, parseSignature } = require("../../functions/lib/webhook-signature");

function fakeSdk() {
  const calls = [];
  class MercadoPagoConfig { constructor(c) { calls.push(["config", c]); } }
  class PreApproval {
    async create(a) { calls.push(["pre.create", a]); return { id: 123, status: "pending", external_reference: a.body.external_reference, init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=123", payer_email: a.body.payer_email, auto_recurring: a.body.auto_recurring, next_payment_date: "2026-02-01T10:00:00.000-03:00", last_modified: "2026-01-01T10:00:00.000-03:00" }; }
    async get(a) { calls.push(["pre.get", a]); return { id: a.id, status: "authorized", external_reference: "SUB1", auto_recurring: { transaction_amount: 21.9, currency_id: "BRL", frequency: 1, frequency_type: "months" } }; }
    async update(a) { calls.push(["pre.update", a]); return { id: a.id, status: a.body.status, external_reference: "SUB1", auto_recurring: { transaction_amount: 21.9, currency_id: "BRL", frequency: 1, frequency_type: "months" } }; }
  }
  class Invoice {
    async get(a) { calls.push(["inv.get", a]); return { id: 9, preapproval_id: 123, status: "processed", transaction_amount: 21.9, currency_id: "BRL", debit_date: "2026-02-01T10:00:00.000-03:00", retry_attempt: 2, payment: { id: 777, status: "approved", status_detail: "accredited" } }; }
    async search(a) { calls.push(["inv.search", a]); return { results: [{ id: 1, preapproval_id: 123, transaction_amount: 21.9, payment: { id: 5, status: "rejected" } }] }; }
  }
  class Payment { async get(a) { calls.push(["pay.get", a]); return { id: 777, status: "refunded", status_detail: "refunded", transaction_amount: 21.9 }; } }
  return { MercadoPagoConfig, PreApproval, Invoice, Payment, calls };
}

test("createPreapproval: sem plano, status pending, preço em REAIS (21.9) e referência estável", async () => {
  const sdk = fakeSdk();
  const p = createSubscriptionProvider("TOKEN-FAKE", sdk);
  const out = await p.createPreapproval({ reason: "Plano", externalReference: "SUB1", payerEmail: "a@b.com", backUrl: "https://x.web.app/painel.html", amountCents: 2190, currency: "BRL", frequency: 1, frequencyType: "months" });
  const [, call] = sdk.calls.find((c) => c[0] === "pre.create");
  assert.equal(call.body.status, "pending");
  assert.equal(call.body.auto_recurring.transaction_amount, 21.9);
  assert.equal(call.body.auto_recurring.currency_id, "BRL");
  assert.equal(call.body.auto_recurring.frequency, 1);
  assert.equal(call.body.auto_recurring.frequency_type, "months");
  assert.equal(call.body.external_reference, "SUB1");
  assert.equal(call.body.card_token_id, undefined, "nenhum dado de cartão passa pelo servidor");
  assert.equal(call.requestOptions.idempotencyKey, "sub_SUB1");
  assert.equal(out.id, "123");
  assert.equal(out.amountCents, 2190);
  assert.match(out.initPoint, /^https:\/\/www\.mercadopago\.com\.br\//);
  assert.equal(typeof out.nextPaymentDate, "number");
  assert.equal(sdk.calls.find((c) => c[0] === "config")[1].accessToken, "TOKEN-FAKE");
});

test("cancelar, consultar e buscar cobranças usam os endpoints/params corretos e normalizam centavos", async () => {
  const sdk = fakeSdk();
  const p = createSubscriptionProvider("T", sdk);
  const cancelled = await p.cancelPreapproval("123");
  assert.deepEqual(JSON.parse(JSON.stringify(sdk.calls.find((c) => c[0] === "pre.update")[1])), { id: "123", body: { status: "cancelled" } });
  assert.equal(cancelled.status, "cancelled");
  const got = await p.getPreapproval(123);
  assert.equal(got.amountCents, 2190);
  const inv = await p.getInvoice(9);
  assert.deepEqual({ ...inv }, { id: "9", preapprovalId: "123", status: "processed", paymentId: "777", paymentStatus: "approved", paymentStatusDetail: "accredited", amountCents: 2190, currency: "BRL", debitDateMs: Date.parse("2026-02-01T10:00:00.000-03:00"), retryAttempt: 2, externalReference: null });
  const list = await p.searchInvoices({ preapprovalId: 123 });
  assert.equal(sdk.calls.find((c) => c[0] === "inv.search")[1].options.preapproval_id, "123");
  assert.equal(list[0].paymentStatus, "rejected");
  await p.searchInvoices({ paymentId: 777 });
  assert.equal(sdk.calls.filter((c) => c[0] === "inv.search")[1][1].options.payment_id, 777);
  assert.equal((await p.getPayment(777)).status, "refunded");
});

test("normalizadores toleram campos ausentes", () => {
  assert.equal(normalizeInvoice({ id: 1 }).amountCents, null);
  assert.equal(normalizePreapproval({ id: 1 }).amountCents, null);
  assert.equal(normalizePreapproval({ id: 1, external_reference: 0 }).externalReference, "0");
});

test("cancelamento só é confirmado quando o gateway retorna estado cancelado", async () => {
  const sdk = fakeSdk();
  sdk.PreApproval.prototype.update = async () => ({ id: "123", status: "authorized" });
  await assert.rejects(createSubscriptionProvider("FAKE", sdk).cancelPreapproval("123"), /não confirmado/);
});

test("x-signature: aceita assinatura correta; rejeita adulterações e formatos inválidos", () => {
  const secret = "s3gr3d0";
  const base = { secret, dataId: "123456", requestId: "req-1", ts: 1742505638683 };
  const header = signForTest(base);
  assert.deepEqual(verifySignature({ secret, signatureHeader: header, requestId: "req-1", dataId: "123456" }), { ok: true, ts: 1742505638683 });
  const bad = (over) => verifySignature({ secret, signatureHeader: header, requestId: "req-1", dataId: "123456", ...over });
  assert.equal(bad({ dataId: "123457" }).reason, "signature_mismatch");
  assert.equal(bad({ requestId: "req-2" }).reason, "signature_mismatch");
  assert.equal(bad({ secret: "outro" }).reason, "signature_mismatch");
  assert.equal(bad({ secret: "" }).reason, "secret_not_configured");
  assert.equal(bad({ signatureHeader: "" }).reason, "missing_signature");
  assert.equal(bad({ signatureHeader: "ts=1,v1=abc" }).reason, "malformed_signature");
  assert.equal(bad({ signatureHeader: "v1=" + "a".repeat(64) }).reason, "malformed_signature");
  assert.equal(bad({ signatureHeader: "ts=x,v1=" + "a".repeat(64) }).reason, "malformed_signature");
  assert.equal(bad({ dataId: "" }).reason, "missing_data_id");
  assert.deepEqual(parseSignature("ts=10, v1=abc"), { ts: "10", v1: "abc" });
});

test("x-signature: id alfanumérico é assinado em minúsculas (regra da documentação)", () => {
  const secret = "k";
  const header = signForTest({ secret, dataId: "ABC123", requestId: "r", ts: 5 });
  assert.equal(verifySignature({ secret, signatureHeader: header, requestId: "r", dataId: "ABC123" }).ok, true);
  assert.equal(verifySignature({ secret, signatureHeader: header, requestId: "r", dataId: "abc123" }).ok, true);
});
