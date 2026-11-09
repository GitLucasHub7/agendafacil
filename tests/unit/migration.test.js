const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeDb, FieldValue } = require("../helpers/fakeFirestore");
const { createFakeGateway } = require("../helpers/fakeMercadoPago");
const { planMigration, applyMigration, rollbackMigration } = require("../../scripts/migrate-legacy");
const { makeEngine } = require("../../functions/lib/subscriptions");
const { DAY_MS, GRACE_DAYS, addMonths } = require("../../functions/lib/plan");
const { baseSite } = require("../helpers/world");

const NOW = Date.UTC(2026, 5, 15, 12);
function legacyDb() {
  const db = createFakeDb();
  const site = (extra) => ({ ...baseSite, name: "Site Legado", slug: "site-legado", published: true, publishedSlug: "site-legado", ownerUid: "alice", paymentStatus: "paid", publishedAt: Date.UTC(2026, 4, 20), ...extra });
  db.seed("sites/SITEPAGO0001", site());
  db.seed("publicSites/site-legado", { ...baseSite, name: "Site Legado", slug: "site-legado", siteId: "SITEPAGO0001" });
  db.seed("payments/900", { siteId: "SITEPAGO0001", status: "approved", createdAtMs: Date.UTC(2026, 4, 20) });
  db.seed("sites/SITESEMPAG01", site({ name: "Sem Pagamento", slug: "sem-pagamento" }));
  db.seed("sites/SITEJATEM001", site({ name: "Já Tem", slug: "ja-tem", subscriptionId: "X" }));
  db.seed("sites/site-original", { ...baseSite, name: "Formato Original", published: true, paymentStatus: "paid" }); // sem ownerUid
  db.seed("sites/SITERASC0001", { ...baseSite, name: "Rascunho", published: false, ownerUid: "alice" });
  return db;
}
const snapshot = (db) => JSON.stringify([...db._store.entries()].sort(([a], [b]) => a.localeCompare(b)));

test("dry-run só lê: classifica migráveis, ignorados e órfãos sem gravar nada", async () => {
  const db = legacyDb();
  const before = snapshot(db);
  const plan = await planMigration(db, { now: NOW });
  assert.equal(snapshot(db), before);
  assert.deepEqual(plan.toMigrate.map((i) => i.siteId), ["SITEPAGO0001"]);
  assert.deepEqual(plan.orphans.map((i) => i.siteId), ["site-original"]);
  assert.equal(plan.skipped.length, 2);
  // pago em 20/05 => +1 mês = 20/06 (já ≥ hoje+7d? 15/06+7d = 22/06) => vale o mínimo de carência
  assert.equal(plan.toMigrate[0].periodEnd, NOW + GRACE_DAYS * DAY_MS);
});

test("aplicar cria assinatura legada ativa; o site continua no ar; depois do período cai na carência e é suspenso", async () => {
  const db = legacyDb();
  const plan = await planMigration(db, { now: NOW });
  const [done] = await applyMigration(db, plan, { batchId: "mig_1", now: NOW });
  const sub = db._store.get(`subscriptions/${done.subscriptionId}`);
  assert.equal(sub.status, "active");
  assert.equal(sub.source, "legacy_one_time");
  assert.equal(db._store.get("sites/SITEPAGO0001").subscriptionId, done.subscriptionId);
  assert.equal(db._store.get("sites/site-original").subscriptionId, undefined, "órfão não é tocado");

  let t = NOW;
  const gw = createFakeGateway();
  const engine = makeEngine({ db, FieldValue, getProvider: () => gw.provider, now: () => t });
  await engine.applyState(done.subscriptionId, null);
  assert.equal(db._store.get(`subscriptions/${done.subscriptionId}`).status, "active");
  assert.equal(db._store.get("sites/SITEPAGO0001").published, true);
  assert.ok(db._store.get("publicSites/site-legado"));

  t = sub.currentPeriodEnd + DAY_MS;
  await engine.applyState(done.subscriptionId, null);
  assert.equal(db._store.get(`subscriptions/${done.subscriptionId}`).status, "past_due");
  assert.equal(db._store.get("sites/SITEPAGO0001").published, true);
  t = sub.currentPeriodEnd + (GRACE_DAYS + 1) * DAY_MS;
  await engine.applyState(done.subscriptionId, null);
  assert.equal(db._store.get(`subscriptions/${done.subscriptionId}`).status, "suspended");
  assert.equal(db._store.get("sites/SITEPAGO0001").published, false);
  assert.equal(db._store.get("sites/SITEPAGO0001").name, "Site Legado");
});

test("aplicar é idempotente e rollback restaura o estado anterior sem tocar em sites públicos", async () => {
  const db = legacyDb();
  const before = JSON.parse(snapshot(db));
  await applyMigration(db, await planMigration(db, { now: NOW }), { batchId: "mig_1", now: NOW });
  const second = await planMigration(db, { now: NOW });
  assert.equal(second.toMigrate.length, 0, "segunda execução não migra de novo");
  const undone = await rollbackMigration(db, "mig_1");
  assert.deepEqual(undone, { subscriptions: 1, invoices: 1, sites: 1 });
  assert.equal([...db._store.keys()].some((k) => k.startsWith("subscriptions/") || k.startsWith("subscriptionInvoices/")), false);
  const site = db._store.get("sites/SITEPAGO0001");
  assert.equal(site.subscriptionId, null);
  assert.equal(site.published, true);
  assert.deepEqual(db._store.get("publicSites/site-legado"), Object.fromEntries(before).hasOwnProperty("publicSites/site-legado") ? before.find(([k]) => k === "publicSites/site-legado")[1] : undefined);
  await assert.rejects(() => rollbackMigration(db, ""), /batchId/);
});
