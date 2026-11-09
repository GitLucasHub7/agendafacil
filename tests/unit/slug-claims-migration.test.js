const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeDb } = require("../helpers/fakeFirestore");
const { planClaims, applyClaims, rollbackClaims } = require("../../scripts/migrate-slug-claims");
const { baseSite } = require("../helpers/world");

const NOW = Date.UTC(2026, 9, 1);
function legacy() {
  const db = createFakeDb();
  const site = (id, owner, slug) => { db.seed(`sites/${id}`, { ...baseSite, name: slug, slug, ownerUid: owner, published: true, publishedSlug: slug }); db.seed(`publicSites/${slug}`, { ...baseSite, name: slug, slug, siteId: id }); };
  site("SITEALICE0001", "alice", "site-alice");
  site("SITEBOB000001", "bob", "site-bob");
  site("SITECARL00001", "carl", "site-carl");
  db.seed("slugClaims/site-carl", { slug: "site-carl", siteId: "SITEOUTRO0001", ownerUid: "zed", state: "held", expiresAtMs: null }); // conflito
  db.seed("slugClaims/site-bob", { slug: "site-bob", siteId: "SITEBOB000001", ownerUid: "bob", state: "published", expiresAtMs: null }); // já reservado
  db.seed("publicSites/site-orfao", { ...baseSite, slug: "site-orfao", siteId: "SITEINEXISTE" }); // órfão
  db.seed("publicSites/sem-id", { ...baseSite, slug: "sem-id" });
  db.seed("sites/SITESEMDONO01", { ...baseSite, name: "Sem Dono", published: true }); db.seed("publicSites/sem-dono", { ...baseSite, slug: "sem-dono", siteId: "SITESEMDONO01" });
  return db;
}
const snapshot = (db) => JSON.stringify([...db._store.entries()].sort(([a], [b]) => a.localeCompare(b)));

test("ENSAIO só lê: classifica a reservar, já reservados, conflitos e órfãos sem gravar nada", async () => {
  const db = legacy();
  const before = snapshot(db);
  const plan = await planClaims(db);
  assert.equal(snapshot(db), before);
  assert.deepEqual(plan.toClaim.map((i) => i.slug), ["site-alice"]);
  assert.deepEqual(plan.alreadyClaimed.map((i) => i.slug), ["site-bob"]);
  assert.deepEqual(plan.conflicts.map((i) => [i.slug, i.claimSiteId]), [["site-carl", "SITEOUTRO0001"]]);
  assert.deepEqual(plan.orphans.map((i) => i.slug).sort(), ["sem-dono", "sem-id", "site-orfao"]);
});

test("APLICAR reserva só o seguro, não sobrescreve conflitos, não toca em publicSites e é idempotente", async () => {
  const db = legacy();
  const pubBefore = JSON.stringify([...db._store.entries()].filter(([k]) => k.startsWith("publicSites/")));
  const res = await applyClaims(db, await planClaims(db), { batchId: "claims_1", now: NOW });
  assert.deepEqual(res.done, ["site-alice"]);
  const c = db._store.get("slugClaims/site-alice");
  assert.deepEqual({ siteId: c.siteId, ownerUid: c.ownerUid, state: c.state, exp: c.expiresAtMs, batch: c.migrationBatch }, { siteId: "SITEALICE0001", ownerUid: "alice", state: "published", exp: null, batch: "claims_1" });
  assert.equal(db._store.get("sites/SITEALICE0001").slugClaim, "site-alice");
  assert.equal(db._store.get("slugClaims/site-carl").siteId, "SITEOUTRO0001", "reserva alheia intacta");
  assert.equal(JSON.stringify([...db._store.entries()].filter(([k]) => k.startsWith("publicSites/"))), pubBefore);
  const again = await planClaims(db);
  assert.equal(again.toClaim.length, 0);
  await assert.rejects(() => applyClaims(db, again, {}), /batchId/);
});

test("corrida durante a migração: create() não sobrescreve uma reserva criada no meio do caminho", async () => {
  const db = legacy();
  const plan = await planClaims(db);
  db.seed("slugClaims/site-alice", { slug: "site-alice", siteId: "OUTRO", ownerUid: "x", state: "reserved", expiresAtMs: NOW + 1000 });
  const res = await applyClaims(db, plan, { batchId: "claims_2", now: NOW });
  assert.deepEqual(res.done, []);
  assert.equal(res.skipped.length, 1);
  assert.equal(db._store.get("slugClaims/site-alice").siteId, "OUTRO");
});

test("ROLLBACK remove só as reservas do lote e limpa o ponteiro; reservas anteriores e publicSites permanecem", async () => {
  const db = legacy();
  await applyClaims(db, await planClaims(db), { batchId: "claims_1", now: NOW });
  const undone = await rollbackClaims(db, "claims_1");
  assert.deepEqual(undone, { claims: 1, sites: 1 });
  assert.equal(db._store.has("slugClaims/site-alice"), false);
  assert.equal(db._store.get("sites/SITEALICE0001").slugClaim, null);
  assert.equal(db._store.get("sites/SITEALICE0001").slugClaimBatch, null);
  assert.ok(db._store.get("slugClaims/site-bob"), "reserva pré-existente preservada");
  assert.ok(db._store.get("slugClaims/site-carl"));
  assert.ok(db._store.get("publicSites/site-alice"));
  await assert.rejects(() => rollbackClaims(db, ""), /batchId/);
  assert.deepEqual(await rollbackClaims(db, "claims_1"), { claims: 0, sites: 0 }, "repetir é inofensivo");
});
