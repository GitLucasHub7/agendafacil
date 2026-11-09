// Testes das REGRAS do Firestore. Exigem o Firestore Emulator (Java 11+):
//   npm run test:rules
// Obs.: no ambiente em que esta suíte foi escrita o emulador não pôde ser baixado (rede bloqueada),
// portanto estes testes ainda NÃO foram executados lá. Rode-os na sua máquina antes do deploy.
const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const firebase = require("firebase/compat/app");
require("firebase/compat/firestore");
const ts = () => firebase.firestore.FieldValue.serverTimestamp();

let env;
const draft = (ownerUid) => ({ ownerUid, name: "Site", slug: "site", published: false, paymentStatus: "unpaid" });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-agendafacil",
    firestore: { rules: fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8") },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc("sites/a1").set(draft("alice"));
    await db.doc("sites/a2").set(draft("alice"));
    await db.doc("sites/b1").set(draft("bob"));
    await db.doc("publicSites/loja").set({ name: "Loja", slug: "loja", siteId: "a1" });
    await db.doc("payments/p1").set({ siteId: "a1", ownerUid: "alice", payerEmail: "alice@ex.com" });
    await db.doc("subscriptions/s1").set({ ownerUid: "alice", siteId: "a1", status: "active", initPoint: "https://www.mercadopago.com.br/x" });
    await db.doc("subscriptions/s2").set({ ownerUid: "alice", siteId: "a2", status: "pending" });
    await db.doc("subscriptions/sb").set({ ownerUid: "bob", siteId: "b1", status: "active" });
    await db.doc("subscriptionInvoices/inv_1").set({ subId: "s1", ownerUid: "alice", status: "approved" });
    await db.doc("webhookEvents/e1").set({ topic: "payment", dataId: "1", status: "processed" });
    await db.doc("slugClaims/meu-slug").set({ slug: "meu-slug", siteId: "a1", ownerUid: "alice", state: "published", expiresAtMs: null });
    await db.doc("incidents/i1").set({ type: "orphan_preapproval", ownerUid: "alice" });
  });
});

const as = (uid) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());

test("dono lê o próprio rascunho; outro usuário e anônimo não", async () => {
  await assertSucceeds(as("alice").doc("sites/a1").get());
  await assertFails(as("bob").doc("sites/a1").get());
  await assertFails(as(null).doc("sites/a1").get());
});

test("listagem: só consulta filtrada pelo próprio uid", async () => {
  const mine = await assertSucceeds(as("alice").collection("sites").where("ownerUid", "==", "alice").get());
  assert.equal(mine.size, 2);
  await assertFails(as("alice").collection("sites").get());
  await assertFails(as("alice").collection("sites").where("ownerUid", "==", "bob").get());
  await assertFails(as("bob").collection("sites").where("ownerUid", "==", "alice").get());
  await assertFails(as(null).collection("sites").get());
});

test("publicSites: leitura por get é pública; listagem e escrita negadas", async () => {
  await assertSucceeds(as(null).doc("publicSites/loja").get());
  await assertSucceeds(as("bob").doc("publicSites/loja").get());
  await assertFails(as(null).collection("publicSites").get());
  await assertFails(as("alice").collection("publicSites").get());
  await assertFails(as("alice").doc("publicSites/minha").set({ name: "x" }));
  await assertFails(as("alice").doc("publicSites/loja").update({ name: "x" }));
  await assertFails(as("alice").doc("publicSites/loja").delete());
});

test("payments e coleções desconhecidas: tudo negado", async () => {
  await assertFails(as("alice").doc("payments/p1").get());
  await assertFails(as("alice").doc("payments/p1").set({ status: "approved" }));
  await assertFails(as(null).collection("payments").get());
  await assertFails(as("alice").doc("qualquer/x").get());
  await assertFails(as("alice").doc("qualquer/x").set({ a: 1 }));
});

test("subscriptions: o dono lê só as próprias assinaturas; ninguém escreve pelo navegador", async () => {
  await assertSucceeds(as("alice").doc("subscriptions/s1").get());
  await assertFails(as("bob").doc("subscriptions/s1").get());
  await assertFails(as(null).doc("subscriptions/s1").get());
  const mine = await assertSucceeds(as("alice").collection("subscriptions").where("ownerUid", "==", "alice").get());
  assert.equal(mine.size, 2);
  await assertFails(as("alice").collection("subscriptions").get());
  await assertFails(as("alice").collection("subscriptions").where("ownerUid", "==", "bob").get());
  // o cliente não consegue se dar uma assinatura ativa, nem mudar estado, preço ou dono
  await assertFails(as("alice").doc("subscriptions/novo").set({ ownerUid: "alice", siteId: "a1", status: "active" }));
  await assertFails(as("alice").doc("subscriptions/s2").update({ status: "active" }));
  await assertFails(as("alice").doc("subscriptions/s1").update({ priceCents: 1 }));
  await assertFails(as("bob").doc("subscriptions/s1").update({ ownerUid: "bob" }));
  await assertFails(as("alice").doc("subscriptions/s1").delete());
});

test("subscriptionInvoices e webhookEvents: totalmente fechados ao navegador", async () => {
  for (const uid of ["alice", null]) {
    await assertFails(as(uid).doc("subscriptionInvoices/inv_1").get());
    await assertFails(as(uid).collection("subscriptionInvoices").get());
    await assertFails(as(uid).doc("subscriptionInvoices/x").set({ status: "approved" }));
    await assertFails(as(uid).doc("webhookEvents/e1").get());
    await assertFails(as(uid).doc("webhookEvents/e2").set({ status: "processed" }));
  }
});

test("slugClaims e incidents: fechados ao navegador (leitura e escrita), inclusive para o dono", async () => {
  for (const uid of ["alice", "bob", null]) {
    await assertFails(as(uid).doc("slugClaims/meu-slug").get());
    await assertFails(as(uid).collection("slugClaims").get());
    await assertFails(as(uid).doc("incidents/i1").get());
  }
  // ninguém consegue reservar, trocar de dono, liberar ou tomar um endereço pelo navegador
  await assertFails(as("alice").doc("slugClaims/novo").set({ siteId: "a1", ownerUid: "alice", state: "published" }));
  await assertFails(as("bob").doc("slugClaims/meu-slug").update({ siteId: "b1", ownerUid: "bob" }));
  await assertFails(as("alice").doc("slugClaims/meu-slug").delete());
  await assertFails(as("alice").doc("incidents/novo").set({ type: "x" }));
});

// ------------------------------------------------------------------------------------------------
// Rascunhos gravados pelo dono (plano Spark): matriz de permitido/negado das regras de /sites.
// ------------------------------------------------------------------------------------------------
const W = "AaaaaaaaaaaaaaaaaaaaAlice001"; // uid de 28 caracteres alfanuméricos (como o Firebase Auth gera)
const B = "BbbbbbbbbbbbbbbbbbbbBobby0001";
const content = (over = {}) => ({ segment: "barbershop", name: "Maicon do Corte", primary: "#c89b3c", background: "#161514", logo: "initial", logoImage: "", schedule: "semanal", work: "solo", start: "09:00", end: "20:00", interval: "30", ...over });
const newDoc = (uid, over = {}) => ({ ...content(), ownerUid: uid, published: false, paymentStatus: "unpaid", createdAt: ts(), updatedAt: ts(), ...over });
const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("SPARK create: o dono cria rascunho válido em <uid>s1..<uid>s10", async () => {
  await assertSucceeds(as(W).doc(`sites/${W}s1`).set(newDoc(W)));
  await assertSucceeds(as(W).doc(`sites/${W}s10`).set(newDoc(W)));
  await assertSucceeds(as(W).doc(`sites/${W}s2`).set(newDoc(W, { logo: "upload", logoImage: PNG })));
  await assertSucceeds(as(W).doc(`sites/${W}s3`).set(newDoc(W, { logo: "star" })));
});

test("SPARK create: NEGADO fora do padrão de ID (limite de 10 sites), de outro usuário ou sem login", async () => {
  await assertFails(as(W).doc("sites/novo").set(newDoc(W)));
  await assertFails(as(W).doc(`sites/${W}s0`).set(newDoc(W)));
  await assertFails(as(W).doc(`sites/${W}s11`).set(newDoc(W)));
  await assertFails(as(W).doc(`sites/${B}s1`).set(newDoc(W)));
  await assertFails(as(W).doc(`sites/${B}s1`).set(newDoc(B)));
  await assertFails(as(null).doc(`sites/${W}s1`).set(newDoc(W)));
  await assertFails(as("alice").doc("sites/aliceS1").set(newDoc("alice")));
});

test("SPARK create: NEGADO se o navegador tenta definir ESTADO (dono, publicado, pagamento, assinatura, endereço, hash)", async () => {
  const id = `sites/${W}s1`;
  await assertFails(as(W).doc(id).set(newDoc(W, { ownerUid: B })));
  await assertFails(as(W).doc(id).set(newDoc(W, { published: true })));
  await assertFails(as(W).doc(id).set(newDoc(W, { paymentStatus: "paid" })));
  for (const extra of [{ subscriptionId: "x" }, { subscriptionStatus: "active" }, { slug: "abc" }, { slugClaim: "abc" }, { publishedSlug: "abc" }, { publishedHash: "h" }, { contentHash: "h" }, { accessUntil: 1 }, { publishState: "published" }]) {
    await assertFails(as(W).doc(id).set(newDoc(W, extra)));
  }
  const missing = newDoc(W); delete missing.interval;
  await assertFails(as(W).doc(id).set(missing));
  await assertFails(as(W).doc(id).set(newDoc(W, { createdAt: new Date() })));
  await assertFails(as(W).doc(id).set(newDoc(W, { updatedAt: new Date() })));
});

test("SPARK create: NEGADO conteúdo inválido (enum, nome, cores, logo, horários, intervalo)", async () => {
  const id = `sites/${W}s1`;
  const bad = [
    { segment: "x" }, { segment: "__proto__" }, { name: "" }, { name: "a".repeat(46) }, { name: "a\nb" }, { name: 123 },
    { primary: "red" }, { background: "#12345" }, { logo: "gif" },
    { logo: "upload", logoImage: "https://evil.example/t.png" }, { logo: "upload", logoImage: "data:image/svg+xml;base64,PHN2Zz4=" },
    { logo: "upload", logoImage: "" }, { logo: "initial", logoImage: PNG },
    { schedule: "weekly" }, { work: "grupo" }, { start: "25:00" }, { end: "9:00" }, { start: "20:00", end: "09:00" }, { interval: "5" }, { interval: 30 },
  ];
  for (const over of bad) await assertFails(as(W).doc(id).set(newDoc(W, over)));
});

async function seedDraft(id, over = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`sites/${id}`).set({ ...content(), ownerUid: W, published: false, paymentStatus: "unpaid", createdAt: new Date(), updatedAt: new Date(), ...over });
  });
}

test("SPARK update: o dono edita só o CONTEÚDO do próprio rascunho", async () => {
  await seedDraft(`${W}s1`);
  await assertSucceeds(as(W).doc(`sites/${W}s1`).update({ name: "Novo Nome", primary: "#112233", updatedAt: ts() }));
  await assertSucceeds(as(W).doc(`sites/${W}s1`).update({ logo: "upload", logoImage: PNG, updatedAt: ts() }));
});

test("SPARK update: NEGADO para outro usuário, sem login, ou ao tocar em ESTADO", async () => {
  await seedDraft(`${W}s1`);
  const ref = (uid) => as(uid).doc(`sites/${W}s1`);
  await assertFails(ref(B).update({ name: "Invadido", updatedAt: ts() }));
  await assertFails(ref(null).update({ name: "Invadido", updatedAt: ts() }));
  for (const over of [{ published: true }, { ownerUid: B }, { paymentStatus: "paid" }, { subscriptionId: "x" }, { subscriptionStatus: "active" }, { slug: "abc" }, { slugClaim: "abc" }, { publishedSlug: "abc" }, { publishedHash: "h" }, { contentHash: "h" }, { accessUntil: 1 }, { createdAt: ts() }]) {
    await assertFails(ref(W).update({ ...over, updatedAt: ts() }));
  }
  await assertFails(ref(W).update({ name: "Sem updatedAt" }));
  await assertFails(ref(W).update({ name: "Relógio do cliente", updatedAt: new Date() }));
  await assertFails(ref(W).update({ name: "", updatedAt: ts() }));
  await assertFails(ref(W).update({ start: "21:00", updatedAt: ts() }));
  // substituir o documento inteiro (set) apagaria/alteraria campos de estado: negado
  await assertFails(ref(W).set({ ...content(), ownerUid: W, published: false, paymentStatus: "unpaid", createdAt: ts(), updatedAt: ts() }));
});

test("SPARK update: site PUBLICADO não aceita edição direta (só o servidor)", async () => {
  await seedDraft(`${W}s1`, { published: true, publishedSlug: "maicon", subscriptionId: "SUB1" });
  await assertFails(as(W).doc(`sites/${W}s1`).update({ name: "Edição direta", updatedAt: ts() }));
  await assertFails(as(W).doc(`sites/${W}s1`).update({ published: false, updatedAt: ts() }));
});

test("SPARK delete: só o dono, só rascunho sem assinatura", async () => {
  await seedDraft(`${W}s1`);
  await seedDraft(`${W}s2`, { subscriptionId: "SUB1" });
  await seedDraft(`${W}s3`, { published: true });
  await assertFails(as(B).doc(`sites/${W}s1`).delete());
  await assertFails(as(null).doc(`sites/${W}s1`).delete());
  await assertFails(as(W).doc(`sites/${W}s2`).delete());
  await assertFails(as(W).doc(`sites/${W}s3`).delete());
  await assertSucceeds(as(W).doc(`sites/${W}s1`).delete());
});

test("SPARK leitura: o dono lê e lista só os próprios; outros não", async () => {
  await seedDraft(`${W}s1`);
  await assertSucceeds(as(W).doc(`sites/${W}s1`).get());
  await assertFails(as(B).doc(`sites/${W}s1`).get());
  await assertSucceeds(as(W).collection("sites").where("ownerUid", "==", W).get());
  await assertFails(as(W).collection("sites").get());
  await assertFails(as(B).collection("sites").where("ownerUid", "==", W).get());
});
