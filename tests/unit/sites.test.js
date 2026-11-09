const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeDb, FieldValue } = require("../helpers/fakeFirestore");
const { makeSaveSite, MAX_SITES_PER_USER } = require("../../functions/lib/sites");

const site = { segment: "barbershop", name: "Maicon do Corte", primary: "#c89b3c", background: "#161514", logo: "initial", logoImage: "", schedule: "semanal", work: "solo", start: "09:00", end: "20:00", interval: "30" };
const authFor = (uid, extra = {}) => ({ uid, token: { email: `${uid}@ex.com`, email_verified: true, ...extra } });
const code = async (p) => { try { await p; return "ok"; } catch (e) { return e.code; } };
const setup = () => { const db = createFakeDb(); return { db, save: makeSaveSite({ db, FieldValue }) }; };

test("saveSite exige login", async () => {
  const { save } = setup();
  assert.equal(await code(save({ data: { site } })), "unauthenticated");
});

test("saveSite grava ownerUid vindo da AUTENTICAÇÃO, ignorando qualquer ownerUid do navegador", async () => {
  const { save, db } = setup();
  assert.equal(await code(save({ auth: authFor("alice"), data: { site: { ...site, ownerUid: "bob" } } })), "invalid-argument");
  const out = await save({ auth: authFor("alice"), data: { site, ownerUid: "bob" } });
  assert.equal(db._store.get(`sites/${out.siteId}`).ownerUid, "alice");
  assert.equal(db._store.get(`sites/${out.siteId}`).published, false);
  assert.equal(out.slug, "maicon-do-corte");
});

test("um usuário pode ter mais de um site, com limite por conta", async () => {
  const { save, db } = setup();
  const a = await save({ auth: authFor("alice"), data: { site } });
  const b = await save({ auth: authFor("alice"), data: { site: { ...site, name: "Segundo Site" } } });
  assert.notEqual(a.siteId, b.siteId);
  assert.equal([...db._store.values()].filter((d) => d.ownerUid === "alice").length, 2);
  for (let i = 2; i < MAX_SITES_PER_USER; i++) await save({ auth: authFor("alice"), data: { site: { ...site, name: `Site ${i}x` } } });
  assert.equal(await code(save({ auth: authFor("alice"), data: { site: { ...site, name: "Excedente" } } })), "resource-exhausted");
  assert.equal(await code(save({ auth: authFor("bob"), data: { site } })), "ok");
});

test("usuário B não consegue modificar o rascunho do usuário A (mesma resposta de inexistente)", async () => {
  const { save, db } = setup();
  const a = await save({ auth: authFor("alice"), data: { site } });
  assert.equal(await code(save({ auth: authFor("bob"), data: { siteId: a.siteId, site: { ...site, name: "Invadido Aqui" } } })), "not-found");
  assert.equal(db._store.get(`sites/${a.siteId}`).name, "Maicon do Corte");
});

test("saveSite valida o siteId e rejeita payload inválido/XSS", async () => {
  const { save } = setup();
  assert.equal(await code(save({ auth: authFor("alice"), data: { siteId: "../x", site } })), "invalid-argument");
  assert.equal(await code(save({ auth: authFor("alice"), data: { siteId: { $ne: 1 }, site } })), "invalid-argument");
  assert.equal(await code(save({ auth: authFor("alice"), data: { site: { ...site, logo: "upload", logoImage: 'x" onerror="alert(1)' } } })), "invalid-argument");
  assert.equal(await code(save({ auth: authFor("alice"), data: { site: { ...site, segment: "__proto__" } } })), "invalid-argument");
});

test("site publicado pode ser editado, mas o endereço (slug) não muda e a edição fica como rascunho de alterações", async () => {
  const { save, db } = setup();
  const a = await save({ auth: authFor("alice"), data: { site } });
  db._store.set(`sites/${a.siteId}`, { ...db._store.get(`sites/${a.siteId}`), published: true, publishedHash: "antigo" });
  const out = await save({ auth: authFor("alice"), data: { siteId: a.siteId, site: { ...site, name: "Nome Totalmente Novo" } } });
  assert.equal(out.slug, "maicon-do-corte");
  assert.equal(out.published, true);
  assert.equal(out.hasUnpublishedChanges, true);
  assert.equal(db._store.get(`sites/${a.siteId}`).name, "Nome Totalmente Novo");
  assert.equal(db._store.get(`sites/${a.siteId}`).slug, "maicon-do-corte");
});
