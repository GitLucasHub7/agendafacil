const test = require("node:test");
const assert = require("node:assert/strict");
const { world, authFor, code } = require("../helpers/world");
const { makeDeleteAccount } = require("../../functions/lib/account");
const { FieldValue } = require("../helpers/fakeFirestore");
const { DAY_MS, GRACE_DAYS } = require("../../functions/lib/plan");

function setupDelete(w) {
  const deleted = [];
  const order = [];
  const del = makeDeleteAccount({ db: w.db, FieldValue, getProvider: () => w.gw.provider, now: w.clock.now, deleteAuthUser: async (uid) => { order.push("auth"); if (w.failAuthDelete) throw new Error("auth falhou"); deleted.push(uid); } });
  const fresh = (uid, extra = {}) => ({ ...authFor(uid), token: { ...authFor(uid).token, auth_time: Math.floor(w.clock.now() / 1000), ...extra } });
  return { del, deleted, order, fresh };
}

test("não exclui conta enquanto uma criação de assinatura tiver resultado incerto", async () => {
  const w = world();
  const { del, deleted, fresh } = setupDelete(w);
  const siteId = await w.newSite("alice", "Conta Segura");
  w.gw.failNext = "createPreapproval";
  await code(w.create({ auth: authFor("alice"), data: { siteId } }));
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "failed-precondition");
  assert.ok(w.siteDoc(siteId));
  assert.deepEqual(deleted, []);
});

test("exige confirmação digitada, login e login RECENTE", async () => {
  const w = world();
  const { del, deleted, fresh } = setupDelete(w);
  assert.equal(await code(del({ data: { confirm: "EXCLUIR" } })), "unauthenticated");
  assert.equal(await code(del({ auth: fresh("alice"), data: {} })), "invalid-argument");
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "excluir" } })), "invalid-argument");
  const stale = { ...fresh("alice"), token: { ...fresh("alice").token, auth_time: Math.floor(w.clock.now() / 1000) - 3600 } };
  assert.equal(await code(del({ auth: stale, data: { confirm: "EXCLUIR" } })), "failed-precondition");
  const noTime = { uid: "alice", token: { email: "a@x.com", email_verified: true } };
  assert.equal(await code(del({ auth: noTime, data: { confirm: "EXCLUIR" } })), "failed-precondition");
  assert.deepEqual(deleted, []);
});

test("bloqueia enquanto houver acesso pago vigente (ativa, em carência ou cancelada dentro do período)", async () => {
  const w = world();
  const { del, deleted, fresh } = setupDelete(w);
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  await w.pay(preId, "approved");
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "failed-precondition");
  await w.cancel({ auth: authFor("alice"), data: { siteId } });
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "failed-precondition", "cancelada mas ainda dentro do período pago");
  assert.equal(w.siteDoc(siteId).name, "Maicon do Corte");
  assert.deepEqual(deleted, []);
  w.clock.set(w.sub(subscriptionId).currentPeriodEnd + 1000);
  await w.reconcile();
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "ok");
  assert.deepEqual(deleted, ["alice"]);
});

test("exclui sites e cópias públicas, anonimiza registros financeiros e só depois apaga o usuário", async () => {
  const w = world();
  const { del, deleted, order, fresh } = setupDelete(w);
  const s1 = await w.newSite("alice", "Site Um");
  const s2 = await w.newSite("alice", "Site Dois");
  const bobSite = await w.newSite("bob", "Site do Bob");
  const sub1 = await w.subscribe("alice", s1);
  const bobSub = await w.subscribe("bob", bobSite);
  await w.pay(sub1.preId, "approved");
  await w.pay(bobSub.preId, "approved");
  await w.cancel({ auth: authFor("alice"), data: { siteId: s1 } });
  w.clock.set(w.sub(sub1.subscriptionId).currentPeriodEnd + DAY_MS);
  await w.reconcile();
  assert.equal(w.pub("site-um"), undefined);

  const out = await del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } });
  assert.deepEqual({ ...out }, { deleted: true, deletedSites: 2 });
  assert.equal(w.siteDoc(s1), undefined);
  assert.equal(w.siteDoc(s2), undefined);
  assert.equal(w.siteDoc(bobSite).name, "Site do Bob", "dados de outro usuário intactos");
  assert.equal(w.pub("site-do-bob").siteId, bobSite);
  const sub = w.sub(sub1.subscriptionId);
  assert.match(sub.ownerUid, /^deleted_[0-9a-f]{16}$/);
  assert.equal(sub.accountDeleted, true);
  assert.equal(JSON.stringify([...w.db._store.values()]).includes('"ownerUid":"alice"'), false, "nenhum uid em claro restou");
  assert.equal(w.invoices(sub1.subscriptionId).length >= 1 && w.invoices(sub1.subscriptionId).every((i) => i.accountDeleted), true, "cobranças preservadas e anonimizadas");
  assert.deepEqual(order, ["auth"]);
  assert.deepEqual(deleted, ["alice"]);
});

test("cancela no gateway assinaturas ainda vivas; se o gateway falhar, nada é apagado", async () => {
  const w = world();
  const { del, deleted, fresh } = setupDelete(w);
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId } = await w.subscribe("alice", siteId); // pendente, viva no gateway
  w.gw.failNext = "cancelPreapproval";
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "unavailable");
  assert.equal(w.siteDoc(siteId).name, "Maicon do Corte");
  assert.deepEqual(deleted, []);
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "ok");
  assert.equal(w.gw.count("cancelPreapproval") >= 1, true);
  assert.equal(w.siteDoc(siteId), undefined);
  assert.equal(w.sub(subscriptionId).status, "cancelled");
});

test("falha ao apagar o usuário no Auth: pode repetir (idempotente) e conclui", async () => {
  const w = world();
  const { del, deleted, fresh } = setupDelete(w);
  await w.newSite("alice", "Maicon do Corte");
  w.failAuthDelete = true;
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "auth falhou");
  w.failAuthDelete = false;
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "ok");
  assert.deepEqual(deleted, ["alice"]);
});

test("usuário sem dados também pode excluir; assinatura suspensa (sem acesso) não bloqueia", async () => {
  const w = world();
  const { del, fresh } = setupDelete(w);
  assert.equal(await code(del({ auth: fresh("zoe"), data: { confirm: "EXCLUIR" } })), "ok");
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const { subscriptionId, preId } = await w.subscribe("alice", siteId);
  await w.pay(preId, "approved");
  w.clock.set(w.sub(subscriptionId).currentPeriodEnd + (GRACE_DAYS + 1) * DAY_MS);
  w.gw.charge(preId, "rejected");
  await w.reconcile();
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(await code(del({ auth: fresh("alice"), data: { confirm: "EXCLUIR" } })), "ok");
  assert.equal(w.gw.count("cancelPreapproval"), 1, "assinatura suspensa mas viva no gateway foi cancelada");
});
