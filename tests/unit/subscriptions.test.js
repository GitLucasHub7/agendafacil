const test = require("node:test");
const assert = require("node:assert/strict");
const { world, authFor, code } = require("../helpers/world");
const { PLAN, GRACE_DAYS, DAY_MS, addMonths } = require("../../functions/lib/plan");

// ---------------------------------------------------------------- criação
test("cria assinatura: usuário autenticado + site próprio; preço/moeda/período definidos no servidor", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const out = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.match(out.initPoint, /^https:\/\/www\.mercadopago\.com\.br\//);
  assert.equal(out.status, "pending");
  const [, call] = w.gw.calls.find((c) => c[0] === "createPreapproval");
  assert.equal(call.amountCents, 2190);
  assert.equal(call.currency, "BRL");
  assert.equal(call.frequency, 1);
  assert.equal(call.frequencyType, "months");
  assert.equal(call.externalReference, out.subscriptionId);
  assert.equal(call.payerEmail, "alice@ex.com");
  assert.equal(call.backUrl, "https://app-teste.web.app/painel.html?assinatura=retorno");
  const sub = w.sub(out.subscriptionId);
  assert.equal(sub.ownerUid, "alice");
  assert.equal(sub.siteId, siteId);
  assert.equal(sub.status, "pending");
  assert.equal(sub.priceCents, 2190);
  assert.ok(sub.mpPreapprovalId);
  assert.equal(w.siteDoc(siteId).subscriptionId, out.subscriptionId);
  assert.equal(w.siteDoc(siteId).published, false, "criar assinatura NÃO publica");
  assert.equal([...w.db._store.keys()].filter((k) => k.startsWith("publicSites/")).length, 0);
});

test("rejeita: sem login, e-mail não verificado, não proprietário, id inválido, APP_BASE_URL ausente", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  assert.equal(await code(w.create({ data: { siteId } })), "unauthenticated");
  assert.equal(await code(w.create({ auth: authFor("alice", { email_verified: false }), data: { siteId } })), "failed-precondition");
  assert.equal(await code(w.create({ auth: authFor("bob"), data: { siteId } })), "not-found");
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId: "../x" } })), "invalid-argument");
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId: { $ne: 1 } } })), "invalid-argument");
  assert.equal(await code(w.create({ auth: authFor("alice"), data: {} })), "invalid-argument");
  assert.equal(w.gw.count("createPreapproval"), 0, "nenhuma chamada ao gateway nos casos rejeitados");
  assert.equal([...w.db._store.keys()].filter((k) => k.startsWith("subscriptions/")).length, 0);
  const noUrl = world({ appBaseUrl: "http://inseguro" });
  const s2 = await noUrl.newSite("alice", "Maicon do Corte");
  assert.equal(await code(noUrl.create({ auth: authFor("alice"), data: { siteId: s2 } })), "failed-precondition");
});

test("preço, moeda e períodos enviados pelo cliente são IGNORADOS", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  await w.create({ auth: authFor("alice"), data: { siteId, price: 1, amount: 1, priceCents: 1, transaction_amount: 0.01, currency: "USD", frequency: 12, payerEmail: "outro@x.com" } });
  const [, call] = w.gw.calls.find((c) => c[0] === "createPreapproval");
  assert.equal(call.amountCents, PLAN.priceCents);
  assert.equal(call.currency, "BRL");
  assert.equal(call.frequency, 1);
  assert.equal(call.payerEmail, "alice@ex.com");
});

test("assinatura pendente é reaproveitada (sem duplicar no gateway); nova só depois de cancelada", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const a = await w.create({ auth: authFor("alice"), data: { siteId } });
  const b = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.equal(b.subscriptionId, a.subscriptionId);
  assert.equal(b.reused, true);
  assert.equal(w.gw.count("createPreapproval"), 1);
});

test("falha incerta do gateway ao criar: erro amigável e nova tentativa aguarda confirmação", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  w.gw.failNext = "createPreapproval";
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  const pending = w.sub(w.siteDoc(siteId).subscriptionId);
  assert.equal(pending.creationState, "creating");
  const retry = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.equal(retry.processing, true);
  assert.equal(w.gw.count("createPreapproval"), 1);
});

// ---------------------------------------------------------------- ativação / pendente / recusado
test("pagamento CONFIRMADO ativa a assinatura e publica o site (somente o backend publica)", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  const { res } = await w.pay(preId, "approved");
  assert.equal(res.code, 200);
  const sub = w.sub(subscriptionId);
  assert.equal(sub.status, "active");
  assert.equal(sub.currentPeriodEnd, addMonths(w.clock.now(), 1));
  const pub = w.pub("maicon-do-corte");
  assert.equal(pub.siteId, siteId);
  assert.equal(pub.ownerUid, undefined, "cópia pública não expõe o uid");
  assert.equal(w.siteDoc(siteId).published, true);
  assert.equal(w.siteDoc(siteId).subscriptionStatus, "active");
  assert.equal(w.invoices(subscriptionId).length, 1);
  assert.equal(w.events().filter((e) => e.status === "processed").length, 1);
});

test("assinatura apenas AUTORIZADA, pagamento PENDENTE ou RECUSADO: sem falsa ativação", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  await w.hook("subscription_preapproval", preId);
  assert.equal(w.sub(subscriptionId).status, "pending");
  for (const st of ["pending", "in_process", "rejected"]) {
    await w.pay(preId, st);
    assert.equal(w.sub(subscriptionId).status, "pending", st);
    assert.equal(w.siteDoc(siteId).published, false, st);
    assert.equal(w.pub("maicon-do-corte"), undefined, st);
  }
});

test("o CORPO da notificação nunca é confiável: corpo diz 'approved', gateway diz 'pending'", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  const c = w.gw.charge(preId, "pending");
  await w.hook("subscription_authorized_payment", c.invoiceId, { body: { status: "approved", action: "payment.updated", data: { id: c.invoiceId, status: "approved" } } });
  assert.equal(w.sub(subscriptionId).status, "pending");
  assert.equal(w.siteDoc(siteId).published, false);
});

// ---------------------------------------------------------------- assinatura do webhook
test("webhook: assinatura ausente, inválida, adulterada ou de outro segredo => 401, sem tocar no gateway nem gravar nada", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  const c = w.gw.charge(preId, "approved");
  const before = w.gw.calls.length;
  const eventsBefore = w.events().length;
  for (const o of [{ sign: false }, { secret: "outro-segredo" }, { signId: "999" }, { sigRequestId: "outro-request" }, { ts: "abc" }]) {
    const res = await w.hook("subscription_authorized_payment", c.invoiceId, o.ts ? { sign: false, ...{} } : o);
    assert.equal(res.code, 401, JSON.stringify(o));
  }
  assert.equal(w.gw.calls.length, before, "gateway não foi consultado");
  assert.equal(w.events().length, eventsBefore, "nada foi registrado");
  assert.equal(w.siteDoc(siteId).published, false);
});

test("webhook: método diferente de POST => 405; segredo não configurado => 500 (falha fechada); tópico desconhecido => ignorado", async () => {
  const w = world();
  assert.equal((await w.hook("payment", "1", { method: "GET" })).code, 405);
  const unknown = await w.hook("merchant_order", "123");
  assert.equal(unknown.code, 200);
  assert.equal(unknown.body, "ignorado");
  assert.equal(w.gw.calls.length, 0);
  const { makeWebhook } = require("../../functions/lib/subscriptions");
  const noSecret = makeWebhook({ db: w.db, FieldValue: require("../helpers/fakeFirestore").FieldValue, getProvider: () => w.gw.provider, getSecret: () => "", engine: w.engine });
  const res = { code: 0, status(c) { this.code = c; return this; }, send() { return this; } };
  await noSecret({ method: "POST", query: { "data.id": "1", type: "payment" }, body: {}, headers: { "x-signature": "ts=1,v1=" + "a".repeat(64) } }, res);
  assert.equal(res.code, 500);
});

// ---------------------------------------------------------------- duplicadas / fora de ordem
test("notificação DUPLICADA: mesmo request-id é descartado; request-id novo reprocessa sem estender o período", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  const c = w.gw.charge(preId, "approved");
  const first = await w.hook("subscription_authorized_payment", c.invoiceId, { requestId: "same" });
  const end = w.sub(subscriptionId).currentPeriodEnd;
  const dup = await w.hook("subscription_authorized_payment", c.invoiceId, { requestId: "same" });
  assert.equal(first.body, "ok");
  assert.equal(dup.body, "duplicado");
  w.clock.advance(5000);
  for (let i = 0; i < 3; i++) await w.hook("subscription_authorized_payment", c.invoiceId);
  await w.hook("payment", c.paymentId);
  assert.equal(w.sub(subscriptionId).currentPeriodEnd, end);
  assert.equal(w.invoices(subscriptionId).length, 1);
  assert.equal(w.sub(subscriptionId).status, "active");
});

test("FORA DE ORDEM: notificação atrasada de 'aprovado' depois do estorno não reativa o site", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  const c = await w.pay(preId, "approved");
  assert.equal(w.sub(subscriptionId).status, "active");
  w.gw.setPaymentStatus(c.paymentId, "refunded");
  await w.hook("payment", c.paymentId); // evento do estorno
  assert.equal(w.sub(subscriptionId).status, "suspended");
  await w.hook("subscription_authorized_payment", c.invoiceId, { requestId: "atrasado" }); // evento antigo "aprovado" chega depois
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(w.siteDoc(siteId).published, false);
  assert.equal(w.pub("maicon-do-corte"), undefined);
});

test("FORA DE ORDEM: estorno visto antes de qualquer aprovação local nunca concede acesso", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  const c = w.gw.charge(preId, "refunded");
  await w.hook("payment", c.paymentId);
  assert.notEqual(w.sub(subscriptionId).status, "active");
  assert.equal(w.siteDoc(siteId).published, false);
});

test("falha temporária do gateway => 500 e evento 'failed'; a nova entrega é reprocessada (tentativas=2)", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  const c = w.gw.charge(preId, "approved");
  w.gw.failNext = "getInvoice";
  const bad = await w.hook("subscription_authorized_payment", c.invoiceId, { requestId: "r1" });
  assert.equal(bad.code, 500);
  assert.equal(w.events()[0].status, "failed");
  assert.match(w.events()[0].error, /gateway indisponível/);
  const ok = await w.hook("subscription_authorized_payment", c.invoiceId, { requestId: "r1" });
  assert.equal(ok.code, 200);
  assert.equal(w.events()[0].status, "processed");
  assert.equal(w.events()[0].attempts, 2);
  assert.equal(w.sub(subscriptionId).status, "active");
});

test("eventos desconhecidos: assinatura inexistente, pagamento sem cobrança e pagamento do fluxo antigo", async () => {
  const w = world();
  w.gw.pre.set("PRE_X", { id: "PRE_X", status: "authorized", externalReference: "NAO_EXISTE", amountCents: 2190, currency: "BRL", frequency: 1, frequencyType: "months" });
  assert.equal((await w.hook("subscription_preapproval", "PRE_X")).code, 200);
  assert.equal(w.events().at(-1).result, "unknown_subscription");
  w.gw.pay.set("555", { status: "approved", amountCents: 2190 });
  await w.hook("payment", "555");
  assert.equal(w.events().at(-1).result, "unlinked_payment");
  w.db.seed("payments/777", { siteId: "x", status: "approved" }); // Pix avulso do modelo antigo
  w.gw.pay.set("777", { status: "approved", amountCents: 4900 });
  await w.hook("payment", "777");
  assert.equal(w.events().at(-1).result, "legacy_payment_manual_action");
  assert.equal([...w.db._store.keys()].filter((k) => k.startsWith("publicSites/")).length, 0);
});

// ---------------------------------------------------------------- cancelamento
test("cancelamento: acesso até o fim do período pago; depois despublica; dados preservados", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  await w.pay(preId, "approved");
  const end = w.sub(subscriptionId).currentPeriodEnd;

  assert.equal(await code(w.cancel({ auth: authFor("bob"), data: { siteId } })), "not-found");
  assert.equal(w.gw.count("cancelPreapproval"), 0);

  w.clock.advance(3 * DAY_MS);
  const out = await w.cancel({ auth: authFor("alice"), data: { siteId } });
  assert.equal(out.status, "cancelled");
  assert.equal(out.accessUntil, end);
  assert.equal(out.published, true, "continua no ar até o fim do período já pago");
  assert.equal(w.gw.count("cancelPreapproval"), 1);
  assert.equal((await w.cancel({ auth: authFor("alice"), data: { siteId } })).status, "cancelled");
  assert.equal(w.gw.count("cancelPreapproval"), 1, "cancelar de novo é idempotente");

  w.clock.set(end + 1000);
  const summary = await w.reconcile();
  assert.equal(summary.errors, 0);
  assert.equal(w.siteDoc(siteId).published, false);
  assert.equal(w.pub("maicon-do-corte"), undefined);
  assert.equal(w.siteDoc(siteId).name, "Maicon do Corte", "dados do site preservados");
  assert.equal(w.sub(subscriptionId).settled, true);
  assert.equal(await code(w.save({ auth: authFor("alice"), data: { siteId, site: { segment: "barbershop", name: "Maicon do Corte 2" } } })), "ok", "site despublicado volta a ser editável");
});

test("falha do gateway ao cancelar: nada muda localmente", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  await w.pay(preId, "approved");
  w.gw.failNext = "cancelPreapproval";
  assert.equal(await code(w.cancel({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(w.sub(subscriptionId).requestedCancel, false);
});

test("cancelar assinatura nunca paga: cancelled sem acesso, sem publicar", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId } = await w.subscribe("alice", siteId);
  const out = await w.cancel({ auth: authFor("alice"), data: { siteId } });
  assert.equal(out.status, "cancelled");
  assert.equal(w.siteDoc(siteId).published, false);
  assert.equal(w.sub(subscriptionId).accessUntil, null);
});

// ---------------------------------------------------------------- inadimplência, carência, recuperação
test("inadimplência: past_due com site no ar na carência; suspensão ao fim dela; recuperação republica", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  await w.pay(preId, "approved");
  const end1 = w.sub(subscriptionId).currentPeriodEnd;

  w.clock.set(end1 + DAY_MS);
  const retry = w.gw.charge(preId, "rejected", { invoiceStatus: "recycling" });
  await w.reconcile();
  assert.equal(w.sub(subscriptionId).status, "past_due");
  assert.equal(w.sub(subscriptionId).graceUntil, end1 + GRACE_DAYS * DAY_MS);
  assert.equal(w.siteDoc(siteId).published, true, "continua publicado durante a carência");

  w.clock.set(end1 + (GRACE_DAYS + 1) * DAY_MS);
  await w.reconcile();
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(w.sub(subscriptionId).statusReason, "grace_expired");
  assert.equal(w.siteDoc(siteId).published, false);
  assert.equal(w.pub("maicon-do-corte"), undefined);
  assert.equal(w.siteDoc(siteId).name, "Maicon do Corte");

  w.gw.setPaymentStatus(retry.paymentId, "approved"); // o cliente regulariza
  await w.hook("payment", retry.paymentId);
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(w.siteDoc(siteId).published, true);
  assert.equal(w.pub("maicon-do-corte").siteId, siteId);
  assert.equal(w.sub(subscriptionId).currentPeriodEnd, addMonths(w.clock.now(), 1));
});

test("gateway cancela após recusas repetidas: suspende por falha de pagamento e não reprocessa mais", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  await w.pay(preId, "approved");
  w.clock.set(w.sub(subscriptionId).currentPeriodEnd + DAY_MS);
  w.gw.charge(preId, "rejected", { invoiceStatus: "cancelled" });
  w.gw.setPreStatus(preId, "cancelled");
  await w.hook("subscription_preapproval", preId);
  const sub = w.sub(subscriptionId);
  assert.equal(sub.status, "suspended");
  assert.equal(sub.statusReason, "payment_failed");
  assert.equal(w.siteDoc(siteId).published, false);
  assert.equal(sub.settled, true);
  const calls = w.gw.calls.length;
  await w.reconcile();
  assert.equal(w.gw.calls.length, calls, "assinatura resolvida não é consultada de novo");
});

// ---------------------------------------------------------------- estorno e contestação
test("ESTORNO suspende na hora (sem carência) e despublica", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  const c = await w.pay(preId, "approved");
  w.gw.setPaymentStatus(c.paymentId, "refunded");
  await w.hook("payment", c.paymentId);
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(w.sub(subscriptionId).statusReason, "refund");
  assert.equal(w.siteDoc(siteId).published, false);
  assert.equal(w.pub("maicon-do-corte"), undefined);
  assert.equal(w.siteDoc(siteId).name, "Maicon do Corte");
});

test("CONTESTAÇÃO: aberta só sinaliza; perdida (chargeback) suspende e cancela a assinatura no gateway", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  const c = await w.pay(preId, "approved");
  w.gw.setPaymentStatus(c.paymentId, "in_mediation");
  await w.hook("payment", c.paymentId);
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(w.sub(subscriptionId).disputed, true);
  assert.equal(w.siteDoc(siteId).published, true);
  w.gw.setPaymentStatus(c.paymentId, "charged_back");
  await w.hook("payment", c.paymentId);
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(w.sub(subscriptionId).statusReason, "chargeback");
  assert.equal(w.gw.count("cancelPreapproval"), 1);
  assert.equal(w.siteDoc(siteId).published, false);
});

// ---------------------------------------------------------------- isolamento
test("ISOLAMENTO: o pagamento de um usuário nunca publica o site de outro", async () => {
  const w = world();
  const a = await w.newSite("alice", "Barbearia da Alice");
  const b = await w.newSite("bob", "Studio do Bob");
  const sa = await w.subscribe("alice", a);
  const sb = await w.subscribe("bob", b);
  await w.pay(sa.preId, "approved");
  assert.equal(w.siteDoc(a).published, true);
  assert.equal(w.siteDoc(b).published, false);
  assert.equal(w.pub("studio-do-bob"), undefined);
  assert.equal(w.sub(sb.subscriptionId).status, "pending");
});

test("ISOLAMENTO: vários sites do mesmo usuário — cada assinatura libera apenas o seu site", async () => {
  const w = world();
  const s1 = await w.newSite("alice", "Primeiro Site");
  const s2 = await w.newSite("alice", "Segundo Site");
  const sub1 = await w.subscribe("alice", s1);
  const sub2 = await w.subscribe("alice", s2);
  await w.pay(sub1.preId, "approved");
  assert.equal(w.siteDoc(s1).published, true);
  assert.equal(w.siteDoc(s2).published, false);
  assert.equal(w.sub(sub2.subscriptionId).status, "pending");
  await w.cancel({ auth: authFor("alice"), data: { siteId: s1 } });
  w.clock.advance(40 * DAY_MS);
  await w.reconcile();
  assert.equal(w.siteDoc(s1).published, false);
  await w.pay(sub2.preId, "approved");
  assert.equal(w.siteDoc(s2).published, true);
  assert.equal(await code(w.sync({ auth: authFor("alice"), data: { siteId: s2 } })), "ok");
});

test("IDENTIDADE: assinatura do gateway com a referência de OUTRA assinatura não altera nada", async () => {
  const w = world();
  const a = await w.newSite("alice", "Barbearia da Alice");
  const sa = await w.subscribe("alice", a);
  await w.pay(sa.preId, "approved");
  const before = JSON.stringify(w.sub(sa.subscriptionId));
  w.gw.pre.set("PRE_ATACANTE", { id: "PRE_ATACANTE", status: "cancelled", externalReference: sa.subscriptionId, amountCents: 2190, currency: "BRL", frequency: 1, frequencyType: "months" });
  await w.hook("subscription_preapproval", "PRE_ATACANTE");
  assert.equal(w.events().at(-1).result, "identity_mismatch");
  assert.equal(JSON.stringify(w.sub(sa.subscriptionId)), before);
  assert.equal(w.siteDoc(a).published, true);
});

test("slug em conflito: assinatura ativa não sobrescreve outro site; renomear republica", async () => {
  const w = world();
  const a = await w.newSite("alice", "Meu Site");
  const sa = await w.subscribe("alice", a);
  await w.pay(sa.preId, "approved");
  const b = await w.newSite("bob", "Site do Bob");
  const sb = await w.subscribe("bob", b);
  await w.save({ auth: authFor("bob"), data: { siteId: b, site: { segment: "barbershop", name: "Meu Site" } } }); // passa a colidir
  await w.pay(sb.preId, "approved");
  assert.equal(w.sub(sb.subscriptionId).status, "active");
  assert.equal(w.siteDoc(b).published, false);
  assert.ok(w.sub(sb.subscriptionId).anomalies.includes("slug_conflict"));
  assert.equal(w.pub("meu-site").siteId, a, "o site da Alice permanece intacto");
  await w.save({ auth: authFor("bob"), data: { siteId: b, site: { segment: "barbershop", name: "Site Novo do Bob" } } });
  assert.equal(w.siteDoc(b).published, true);
  assert.equal(w.pub("site-novo-do-bob").siteId, b);
});

// ---------------------------------------------------------------- sincronização e reconciliação
test("sync manual: só o dono, com intervalo mínimo, e traz o estado do gateway", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  w.gw.charge(preId, "approved");
  assert.equal(await code(w.sync({ auth: authFor("bob"), data: { siteId } })), "not-found");
  assert.equal(await code(w.sync({ data: { siteId } })), "unauthenticated");
  const out = await w.sync({ auth: authFor("alice"), data: { siteId } });
  assert.equal(out.status, "active");
  assert.equal(out.published, true);
  assert.equal(await code(w.sync({ auth: authFor("alice"), data: { siteId } })), "resource-exhausted");
  w.clock.advance(31000);
  assert.equal(await code(w.sync({ auth: authFor("alice"), data: { siteId } })), "ok");
  w.clock.advance(31000);
  w.gw.failNext = "getPreapproval";
  assert.equal(await code(w.sync({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  assert.equal(w.sub(subscriptionId).status, "active");
});

test("reconciliação recupera evento PERDIDO: pagamento aprovado sem nenhum webhook entregue", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.authorize(preId);
  w.gw.charge(preId, "approved");
  assert.equal(w.sub(subscriptionId).status, "pending");
  const summary = await w.reconcile();
  assert.equal(summary.synced, 1);
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(w.siteDoc(siteId).published, true);
});

test("reconciliação encerra assinatura ABANDONADA (checkout nunca concluído) após 7 dias", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId } = await w.subscribe("alice", siteId);
  w.clock.advance(6 * DAY_MS);
  assert.equal((await w.reconcile()).abandoned, 0);
  w.clock.advance(2 * DAY_MS);
  const summary = await w.reconcile();
  assert.equal(summary.abandoned, 1);
  assert.equal(w.sub(subscriptionId).status, "cancelled");
  assert.equal(w.sub(subscriptionId).cancelReason, "abandoned");
  assert.equal(w.gw.count("cancelPreapproval"), 1);
  assert.equal(w.siteDoc(siteId).published, false);
});

// ---------------------------------------------------------------- preço adulterado no gateway
test("preço diferente do plano no gateway: não ativa nem publica, registra anomalia", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  w.gw.pre.get(preId).amountCents = 100;
  await w.pay(preId, "approved", { amountCents: 100 });
  assert.equal(w.sub(subscriptionId).status, "pending");
  assert.equal(w.siteDoc(siteId).published, false);
  assert.ok(w.sub(subscriptionId).anomalies.includes("plan_mismatch"));
});
