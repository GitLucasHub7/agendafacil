const test = require("node:test");
const assert = require("node:assert/strict");
const { world, authFor, code } = require("../helpers/world");
const { CREATION_LOCK_MS, CREATION_HARD_TTL_MS } = require("../../functions/lib/plan");

const incidents = (w) => [...w.db._store.entries()].filter(([k]) => k.startsWith("incidents/")).map(([, v]) => v);
const claim = (w, slug) => w.db._store.get(`slugClaims/${slug}`);
const subsOf = (w, siteId) => [...w.db._store.entries()].filter(([k, v]) => k.startsWith("subscriptions/") && v.siteId === siteId);

test("COMPENSAÇÃO: assinatura criada no gateway mas não gravada => cancela a remota, registra incidente, libera o endereço e permite nova tentativa", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  w.db.failUpdateFor = { prefix: "subscriptions/", when: (d) => d.creationState === "ready" };
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  assert.equal(w.gw.count("createPreapproval"), 1);
  assert.equal(w.gw.count("cancelPreapproval"), 1, "a assinatura remota órfã foi cancelada");
  const [pre] = [...w.gw.pre.values()];
  assert.equal(pre.status, "cancelled");
  const [inc] = incidents(w);
  assert.equal(inc.type, "orphan_preapproval");
  assert.equal(inc.reason, "persist_failed");
  assert.equal(inc.remoteCancelled, true);
  assert.match(inc.error, /firestore indisponível/);
  const [[, failed]] = subsOf(w, siteId);
  assert.equal(failed.creationState, "failed");
  assert.equal(failed.status, "cancelled");
  assert.equal(claim(w, "maicon-do-corte"), undefined, "reserva liberada");
  const retry = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.match(retry.initPoint, /mercadopago/);
  assert.equal(w.gw.count("createPreapproval"), 2);
});

test("COMPENSAÇÃO: se nem o cancelamento remoto funcionar, o incidente fica marcado para ação manual", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  w.db.failUpdateFor = { prefix: "subscriptions/", when: (d) => d.creationState === "ready" };
  w.gw.failNext = "cancelPreapproval";
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  const [inc] = incidents(w);
  assert.equal(inc.remoteCancelled, false);
  assert.equal(inc.mpPreapprovalId, [...w.gw.pre.keys()][0]);
  assert.equal((await w.create({ auth: authFor("alice"), data: { siteId } })).processing, true);
  assert.equal(w.gw.count("createPreapproval"), 1, "cancelamento incerto não libera segunda cobrança");
  await w.reconcile();
  assert.equal([...w.gw.pre.values()][0].status, "cancelled");
});

test("COMPENSAÇÃO: link de checkout inesperado devolvido pelo gateway cancela a remota e nunca chega ao usuário", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  w.gw.badInitPoint = true;
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  assert.equal(w.gw.count("cancelPreapproval"), 1);
  assert.equal(incidents(w)[0].reason, "invalid_init_point");
  assert.equal(claim(w, "maicon-do-corte"), undefined);
});

test("rejeição definitiva ao criar no gateway: assinatura encerrada e reserva liberada", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const original = w.gw.provider.createPreapproval.bind(w.gw.provider);
  w.gw.provider.createPreapproval = async () => { w.gw.provider.createPreapproval = original; throw Object.assign(new Error("rejeitado"), { status: 400 }); };
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  assert.equal(claim(w, "maicon-do-corte"), undefined);
  assert.equal(w.gw.count("cancelPreapproval"), 0, "nada foi criado no gateway, nada a cancelar");
  assert.equal(subsOf(w, siteId)[0][1].creationState, "failed");
  assert.match((await w.create({ auth: authFor("alice"), data: { siteId } })).initPoint, /mercadopago/);
});

test("TRAVA ATIVA: com a criação em andamento (recente) outra chamada recebe 'em processamento', sem criar outra", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const first = await w.subscribe("alice", siteId);
  w.db._store.set(`subscriptions/${first.subscriptionId}`, { ...w.sub(first.subscriptionId), creationState: "creating", creationStartedAtMs: w.clock.now(), mpPreapprovalId: null, initPoint: null });
  const out = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.equal(out.processing, true);
  assert.equal(out.subscriptionId, first.subscriptionId);
  assert.equal(w.gw.count("createPreapproval"), 1);
});

function crashed(w, subscriptionId, startedAgoMs) {
  // simula queda da função DEPOIS da criação remota e ANTES de gravar mpPreapprovalId/initPoint
  w.db._store.set(`subscriptions/${subscriptionId}`, { ...w.sub(subscriptionId), creationState: "creating", creationStartedAtMs: w.clock.now() - startedAgoMs, mpPreapprovalId: null, initPoint: null });
}

test("RECUPERAÇÃO: trava vencida e assinatura remota existe => adota a remota, sem criar outra", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const first = await w.subscribe("alice", siteId);
  crashed(w, first.subscriptionId, CREATION_LOCK_MS + 1000);
  const out = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.equal(out.reused, true);
  assert.equal(out.subscriptionId, first.subscriptionId);
  assert.match(out.initPoint, new RegExp(first.preId));
  assert.equal(w.sub(first.subscriptionId).mpPreapprovalId, first.preId);
  assert.equal(w.sub(first.subscriptionId).creationState, "ready");
  assert.equal(w.gw.count("createPreapproval"), 1);
});

test("RECUPERAÇÃO: trava vencida e NADA existe no gateway => encerra a antiga e cria uma nova", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const first = await w.subscribe("alice", siteId);
  crashed(w, first.subscriptionId, CREATION_LOCK_MS + 1000);
  w.gw.pre.clear();
  const out = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.notEqual(out.subscriptionId, first.subscriptionId);
  assert.equal(w.sub(first.subscriptionId).creationState, "failed");
  assert.equal(w.gw.count("createPreapproval"), 2);
  assert.equal(claim(w, "maicon-do-corte").subscriptionId, out.subscriptionId);
});

test("RECUPERAÇÃO: consulta ao gateway falha => NÃO cria outra, mesmo após prazo máximo", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const first = await w.subscribe("alice", siteId);
  crashed(w, first.subscriptionId, CREATION_LOCK_MS + 1000);
  w.gw.failNext = "findPreapproval";
  const out = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.equal(out.processing, true);
  assert.equal(w.gw.count("createPreapproval"), 1);
  // Passado o prazo máximo, registra incidente e mantém a trava.
  crashed(w, first.subscriptionId, CREATION_HARD_TTL_MS + 1000);
  w.gw.failNext = "findPreapproval";
  const later = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.equal(later.subscriptionId, first.subscriptionId);
  assert.equal(later.processing, true);
  assert.equal(w.gw.count("createPreapproval"), 1);
  assert.equal(incidents(w).some((i) => i.type === "creation_unresolved"), true);
});

test("WEBHOOK adota a assinatura remota quando chega ANTES de gravarmos o id", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const first = await w.subscribe("alice", siteId);
  crashed(w, first.subscriptionId, 5000);
  w.gw.authorize(first.preId);
  await w.hook("subscription_preapproval", first.preId);
  assert.equal(w.sub(first.subscriptionId).mpPreapprovalId, first.preId);
  assert.equal(w.sub(first.subscriptionId).creationState, "ready");
});

test("WEBHOOK encontra assinatura remota ÓRFÃ de uma criação dada como falha => cancela no gateway e registra incidente", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const first = await w.subscribe("alice", siteId);
  w.db._store.set(`subscriptions/${first.subscriptionId}`, { ...w.sub(first.subscriptionId), creationState: "failed", status: "cancelled", requestedCancel: true, mpPreapprovalId: null, initPoint: null });
  w.gw.authorize(first.preId);
  await w.hook("subscription_preapproval", first.preId);
  assert.equal(w.gw.pre.get(first.preId).status, "cancelled");
  assert.equal(incidents(w)[0].reason, "orphan_found_by_webhook");
  assert.equal(w.siteDoc(siteId).published, false);
});
