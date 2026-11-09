const test = require("node:test");
const assert = require("node:assert/strict");
const { world, authFor } = require("../helpers/world");
const { makeWebhook, makeRetryWebhookEvents } = require("../../functions/lib/subscriptions");
const { FieldValue } = require("../helpers/fakeFirestore");
const { DAY_MS, GRACE_DAYS } = require("../../functions/lib/plan");

const deps = (w) => ({ db: w.db, FieldValue, getProvider: () => w.gw.provider, engine: w.engine, now: w.clock.now });
const events = (w) => [...w.db._store.entries()].filter(([k]) => k.startsWith("webhookEvents/"));

async function paidFixture(w) {
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const s = await w.subscribe("alice", siteId);
  w.gw.authorize(s.preId);
  const c = w.gw.charge(s.preId, "approved");
  return { siteId, ...s, ...c };
}

test("ORÇAMENTO: processamento lento => 503 (o Mercado Pago reenvia); evento já gravado como 'failed'; reprocessador agendado conclui", async () => {
  const w = world();
  const f = await paidFixture(w);
  w.gw.slowReadMs = 150;
  const slow = makeWebhook({ ...deps(w), getSecret: () => w.SECRET, budgetMs: 40 });
  const res = await w.hook("subscription_authorized_payment", f.invoiceId, { handler: slow, requestId: "slow-1" });
  assert.equal(res.code, 503);
  const [[, ev]] = events(w);
  assert.equal(ev.status, "failed");
  assert.match(ev.error, /orçamento/);
  assert.equal(ev.topic, "subscription_authorized_payment");
  assert.equal(w.sub(f.subscriptionId).status, "pending", "nada foi aplicado dentro do orçamento");

  w.gw.slowReadMs = 0;
  await new Promise((r) => setTimeout(r, 250)); // deixa terminar o trabalho em voo (idempotente)
  w.clock.advance(3 * 60 * 1000);
  const summary = await makeRetryWebhookEvents(deps(w))();
  assert.equal(summary.errors, undefined);
  assert.equal(w.sub(f.subscriptionId).status, "active");
  assert.equal(w.siteDoc(f.siteId).published, true);
  assert.equal(w.invoices(f.subscriptionId).length, 1, "sem cobrança duplicada");
  assert.equal(events(w)[0][1].status, "processed");
});

test("RETRY DURÁVEL: evento 'failed' é reprocessado; evento recente é poupado; 'received' travado é recuperado; excesso de tentativas vira 'dead'", async () => {
  const w = world();
  const f = await paidFixture(w);
  w.gw.failNext = "getInvoice";
  assert.equal((await w.hook("subscription_authorized_payment", f.invoiceId, { requestId: "r1" })).code, 500);
  const retry = makeRetryWebhookEvents(deps(w));
  assert.equal((await retry()).checked, 0, "muito recente: espera o Mercado Pago reenviar primeiro");
  w.clock.advance(3 * 60 * 1000);
  const first = await retry();
  assert.equal(first.processed, 1);
  assert.equal(w.sub(f.subscriptionId).status, "active");

  // instância encerrada no meio: evento ficou 'received'
  w.db._store.set("webhookEvents/stuck", { topic: "payment", dataId: f.paymentId, status: "received", attempts: 1, receivedAtMs: w.clock.now() - 10 * 60 * 1000 });
  assert.equal((await retry()).processed, 1);
  assert.equal(w.db._store.get("webhookEvents/stuck").status, "processed");

  w.db._store.set("webhookEvents/hopeless", { topic: "payment", dataId: "inexistente", status: "failed", attempts: 10, failedAtMs: w.clock.now() - 10 * 60 * 1000 });
  assert.equal((await retry()).gaveUp, 1);
  assert.equal(w.db._store.get("webhookEvents/hopeless").status, "dead");
});

test("o handler só responde DEPOIS de processar: nenhum trabalho pendente após o 200", async () => {
  const w = world();
  const f = await paidFixture(w);
  const res = await w.hook("subscription_authorized_payment", f.invoiceId);
  assert.equal(res.code, 200);
  const calls = w.gw.calls.length;
  const state = JSON.stringify(w.sub(f.subscriptionId));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(w.gw.calls.length, calls);
  assert.equal(JSON.stringify(w.sub(f.subscriptionId)), state);
  assert.equal(events(w)[0][1].status, "processed");
});

test("DEDUPLICAÇÃO não bloqueia atualizações legítimas: mesmo recurso com request-id novo aplica o estado novo", async () => {
  const w = world();
  const f = await paidFixture(w);
  await w.hook("payment", f.paymentId, { requestId: "a" });
  assert.equal(w.sub(f.subscriptionId).status, "active");
  assert.equal((await w.hook("payment", f.paymentId, { requestId: "a" })).body, "duplicado");
  w.gw.setPaymentStatus(f.paymentId, "refunded");
  assert.equal((await w.hook("payment", f.paymentId, { requestId: "b" })).body, "ok");
  assert.equal(w.sub(f.subscriptionId).status, "suspended");
  assert.equal(w.siteDoc(f.siteId).published, false);
});

// ---------------------------------------------------------------- estados do gateway explícitos
test("ESTADOS: authorized e pending sem cobrança aprovada não ativam", async () => {
  for (const status of ["pending", "authorized"]) {
    const w = world();
    const siteId = await w.newSite("alice", "Maicon do Corte");
    const { subscriptionId, preId } = await w.subscribe("alice", siteId);
    w.gw.setPreStatus(preId, status);
    await w.hook("subscription_preapproval", preId);
    assert.equal(w.sub(subscriptionId).status, "pending", status);
    assert.equal(w.sub(subscriptionId).mpStatus, status);
    assert.equal(w.siteDoc(siteId).published, false, status);
  }
});

test("ESTADOS: paused mantém o acesso do período já pago, não renova, e ao fim do período segue carência e suspensão", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  await w.pay(preId, "approved");
  const end = w.sub(subscriptionId).currentPeriodEnd;
  w.gw.setPreStatus(preId, "paused");
  await w.hook("subscription_preapproval", preId);
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(w.sub(subscriptionId).mpStatus, "paused");
  assert.equal(w.siteDoc(siteId).published, true);
  w.clock.set(end + DAY_MS);
  await w.reconcile();
  assert.equal(w.sub(subscriptionId).status, "past_due", "pausada e sem renovação: carência");
  assert.equal(w.siteDoc(siteId).published, true);
  w.clock.set(end + (GRACE_DAYS + 1) * DAY_MS);
  await w.reconcile();
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(w.siteDoc(siteId).published, false);
  // despausada com pagamento aprovado: volta
  w.gw.setPreStatus(preId, "authorized");
  w.gw.charge(preId, "approved");
  await w.sync({ auth: authFor("alice"), data: { siteId } });
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(w.siteDoc(siteId).published, true);
});

test("ESTADOS: paused sem nunca ter pago continua pending; cancelled sem pagar fica cancelled sem acesso", async () => {
  const w = world();
  const a = await w.newSite("alice", "Site A");
  const sa = await w.subscribe("alice", a);
  w.gw.setPreStatus(sa.preId, "paused");
  await w.hook("subscription_preapproval", sa.preId);
  assert.equal(w.sub(sa.subscriptionId).status, "pending");
  const b = await w.newSite("alice", "Site B");
  const sb = await w.subscribe("alice", b);
  w.gw.setPreStatus(sb.preId, "cancelled");
  await w.hook("subscription_preapproval", sb.preId);
  assert.equal(w.sub(sb.subscriptionId).status, "cancelled");
  assert.equal(w.siteDoc(b).published, false);
});

test("ESTADOS das cobranças recorrentes: aprovada, pendente, recusada, estornada e contestada em sequência", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  const pending = w.gw.charge(preId, "pending");
  await w.hook("subscription_authorized_payment", pending.invoiceId);
  assert.equal(w.sub(subscriptionId).status, "pending");
  w.gw.setPaymentStatus(pending.paymentId, "rejected");
  await w.hook("payment", pending.paymentId);
  assert.equal(w.sub(subscriptionId).status, "pending");
  w.gw.setPaymentStatus(pending.paymentId, "approved");
  await w.hook("payment", pending.paymentId);
  assert.equal(w.sub(subscriptionId).status, "active");
  w.gw.setPaymentStatus(pending.paymentId, "in_mediation");
  await w.hook("payment", pending.paymentId);
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(w.sub(subscriptionId).disputed, true);
  w.gw.setPaymentStatus(pending.paymentId, "charged_back");
  await w.hook("payment", pending.paymentId);
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(w.siteDoc(siteId).published, false);
});
