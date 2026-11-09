const test = require("node:test");
const assert = require("node:assert/strict");
const { world, authFor, code, baseSite } = require("../helpers/world");
const { DAY_MS, GRACE_DAYS, SLUG_RETENTION_MS, SLUG_RESERVATION_MS } = require("../../functions/lib/plan");
const { makeDeleteAccount } = require("../../functions/lib/account");
const { FieldValue } = require("../helpers/fakeFirestore");

const claim = (w, slug) => w.db._store.get(`slugClaims/${slug}`);
const rename = (w, uid, siteId, name) => w.save({ auth: authFor(uid), data: { siteId, site: { ...baseSite, name } } });
async function live(w, uid, name) {
  const siteId = await w.newSite(uid, name);
  const s = await w.subscribe(uid, siteId);
  await w.pay(s.preId, "approved");
  return { siteId, ...s };
}

test("RESERVA: o checkout reserva o endereço; o pagamento aprovado a converte em 'published' para o MESMO site", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Meu Endereco");
  const s = await w.subscribe("alice", siteId);
  assert.deepEqual({ state: claim(w, "meu-endereco").state, siteId: claim(w, "meu-endereco").siteId, ownerUid: claim(w, "meu-endereco").ownerUid, sub: claim(w, "meu-endereco").subscriptionId }, { state: "reserved", siteId, ownerUid: "alice", sub: s.subscriptionId });
  assert.equal(claim(w, "meu-endereco").expiresAtMs, w.clock.now() + SLUG_RESERVATION_MS);
  assert.equal(w.siteDoc(siteId).slugClaim, "meu-endereco");
  await w.pay(s.preId, "approved");
  assert.equal(claim(w, "meu-endereco").state, "published");
  assert.equal(claim(w, "meu-endereco").expiresAtMs, null);
  assert.equal(w.pub("meu-endereco").siteId, siteId);
});

test("RESERVA: com checkout pendente, outro site NÃO consegue o mesmo endereço (erro claro, sem chamar o gateway)", async () => {
  const w = world();
  const a = await w.newSite("alice", "Meu Endereco");
  await w.subscribe("alice", a);
  const b = await w.newSite("bob", "Meu Endereco");
  const before = w.gw.count("createPreapproval");
  assert.equal(await code(w.create({ auth: authFor("bob"), data: { siteId: b } })), "already-exists");
  assert.equal(w.gw.count("createPreapproval"), before);
  assert.equal((await w.save({ auth: authFor("bob"), data: { siteId: b, site: { ...baseSite, name: "Meu Endereco" } } })).slugAvailable, false, "o editor já avisa que o endereço está reservado");
});

test("RESERVA: site publicado mantém o endereço; suspensão RETÉM o endereço e ninguém o ocupa em silêncio", async () => {
  const w = world();
  const { siteId, subscriptionId, preId } = await live(w, "alice", "Meu Endereco");
  const end = w.sub(subscriptionId).currentPeriodEnd;
  w.clock.set(end + (GRACE_DAYS + 1) * DAY_MS);
  w.gw.charge(preId, "rejected");
  await w.reconcile();
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(w.pub("meu-endereco"), undefined);
  assert.equal(claim(w, "meu-endereco").state, "held");
  assert.equal(claim(w, "meu-endereco").expiresAtMs, w.clock.now() + SLUG_RETENTION_MS);
  const other = await w.newSite("bob", "Meu Endereco");
  assert.equal(await code(w.create({ auth: authFor("bob"), data: { siteId: other } })), "already-exists", "endereço retido para o dono");
  // o dono volta: mesmo endereço, mesma reserva, republica
  const retry = [...w.gw.inv.entries()].find(([, v]) => v.status !== "x");
  w.gw.setPaymentStatus([...w.gw.pay.keys()].pop(), "approved");
  await w.hook("payment", [...w.gw.pay.keys()].pop());
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(claim(w, "meu-endereco").state, "published");
  assert.equal(w.pub("meu-endereco").siteId, siteId);
  assert.ok(retry);
});

test("RESERVA: depois da retenção (90 dias) o endereço é liberado pela reconciliação e outro site pode assumi-lo", async () => {
  const w = world();
  const { subscriptionId } = await live(w, "alice", "Meu Endereco");
  await w.cancel({ auth: authFor("alice"), data: { siteId: (await (async () => w.sub(subscriptionId).siteId)()) } });
  w.clock.set(w.sub(subscriptionId).currentPeriodEnd + DAY_MS);
  await w.reconcile();
  assert.equal(claim(w, "meu-endereco").state, "held");
  const other = await w.newSite("bob", "Meu Endereco");
  assert.equal(await code(w.create({ auth: authFor("bob"), data: { siteId: other } })), "already-exists");
  w.clock.advance(SLUG_RETENTION_MS + DAY_MS);
  const summary = await w.reconcile();
  assert.equal(summary.claimsReleased >= 1, true);
  assert.equal(claim(w, "meu-endereco"), undefined);
  assert.match((await w.create({ auth: authFor("bob"), data: { siteId: other } })).initPoint, /mercadopago/);
});

test("RESERVA: checkout abandonado ou cancelado sem nunca publicar libera o endereço", async () => {
  const w = world();
  const a = await w.newSite("alice", "Meu Endereco");
  await w.subscribe("alice", a);
  await w.cancel({ auth: authFor("alice"), data: { siteId: a } });
  assert.equal(claim(w, "meu-endereco"), undefined, "cancelar libera a reserva do checkout");
  const b = await w.newSite("bob", "Outro Endereco");
  await w.subscribe("bob", b);
  w.clock.advance(8 * DAY_MS);
  await w.reconcile();
  assert.equal(claim(w, "outro-endereco"), undefined, "abandono libera a reserva");
});

test("RESERVA: renomear o site e reabrir o checkout pendente move a reserva para o novo endereço", async () => {
  const w = world();
  const a = await w.newSite("alice", "Endereco Antigo");
  const first = await w.subscribe("alice", a);
  await rename(w, "alice", a, "Endereco Novo");
  const again = await w.create({ auth: authFor("alice"), data: { siteId: a } });
  assert.equal(again.reused, true);
  assert.equal(again.subscriptionId, first.subscriptionId);
  assert.equal(claim(w, "endereco-antigo"), undefined, "o endereço antigo foi liberado");
  assert.equal(claim(w, "endereco-novo").siteId, a);
  const b = await w.newSite("bob", "Endereco Novo");
  assert.equal(await code(w.create({ auth: authFor("bob"), data: { siteId: b } })), "already-exists");
  await w.pay(first.preId, "approved");
  assert.equal(w.pub("endereco-novo").siteId, a);
});

test("PUBLICAÇÃO: apenas o detentor da reserva publica; reserva viva de outro site bloqueia e nunca é sobrescrita", async () => {
  const w = world();
  const a = await w.newSite("alice", "Meu Endereco");
  const s = await w.subscribe("alice", a);
  w.db._store.set("slugClaims/meu-endereco", { slug: "meu-endereco", siteId: "OUTRO_SITE_ID", ownerUid: "bob", state: "held", expiresAtMs: w.clock.now() + DAY_MS, subscriptionId: null }); // alguém detém
  await w.pay(s.preId, "approved");
  assert.equal(w.sub(s.subscriptionId).status, "active");
  assert.equal(w.siteDoc(a).published, false);
  assert.equal(w.pub("meu-endereco"), undefined);
  assert.ok(w.sub(s.subscriptionId).anomalies.includes("slug_conflict"));
  assert.equal(claim(w, "meu-endereco").siteId, "OUTRO_SITE_ID");
  // reserva VENCIDA de outro site não bloqueia mais
  w.db._store.set("slugClaims/meu-endereco", { ...claim(w, "meu-endereco"), expiresAtMs: w.clock.now() - 1 });
  await w.sync({ auth: authFor("alice"), data: { siteId: a } });
  assert.equal(w.siteDoc(a).published, true);
  assert.equal(claim(w, "meu-endereco").siteId, a);
});

test("SITE LEGADO publicado sem reserva: bloqueia outro site e é 'reparado' ao reavaliar", async () => {
  const w = world();
  const { siteId, subscriptionId } = await live(w, "alice", "Meu Endereco");
  w.db._store.delete("slugClaims/meu-endereco"); // formato anterior à reserva
  const other = await w.newSite("bob", "Meu Endereco");
  assert.equal(await code(w.create({ auth: authFor("bob"), data: { siteId: other } })), "already-exists", "publicSites continua protegendo");
  await w.engine.applyState(subscriptionId, null);
  assert.equal(claim(w, "meu-endereco").state, "published");
  assert.equal(claim(w, "meu-endereco").siteId, siteId);
});

test("EXCLUSÃO DE CONTA libera as reservas do usuário (publicadas, retidas e pendentes)", async () => {
  const w = world();
  const a = await w.newSite("alice", "Endereco Pendente");
  await w.subscribe("alice", a);
  const del = makeDeleteAccount({ db: w.db, FieldValue, getProvider: () => w.gw.provider, now: w.clock.now, deleteAuthUser: async () => {} });
  const fresh = { ...authFor("alice"), token: { ...authFor("alice").token, auth_time: Math.floor(w.clock.now() / 1000) } };
  await del({ auth: fresh, data: { confirm: "EXCLUIR" } });
  assert.equal(claim(w, "endereco-pendente"), undefined);
  assert.equal([...w.db._store.keys()].some((k) => k.startsWith("slugClaims/")), false);
  const b = await w.newSite("bob", "Endereco Pendente");
  assert.match((await w.create({ auth: authFor("bob"), data: { siteId: b } })).initPoint, /mercadopago/);
});

test("ISOLAMENTO: outro usuário não consegue assinar nem publicar por cima do site de alguém", async () => {
  const w = world();
  const { siteId } = await live(w, "alice", "Site da Alice");
  assert.equal(await code(w.create({ auth: authFor("bob"), data: { siteId } })), "not-found");
  assert.equal(await code(w.cancel({ auth: authFor("bob"), data: { siteId } })), "not-found");
  assert.equal(await code(w.publishChanges({ auth: authFor("bob"), data: { siteId } })), "not-found");
  assert.equal(await code(w.sync({ auth: authFor("bob"), data: { siteId } })), "not-found");
  assert.equal(claim(w, "site-da-alice").ownerUid, "alice");
});
