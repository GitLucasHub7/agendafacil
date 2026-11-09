// Transações REAIS no emulador Firestore; Mercado Pago continua inteiramente simulado.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const fnRequire = createRequire(path.join(__dirname, "../../functions/package.json"));
const { initializeApp, cert, deleteApp } = fnRequire("firebase-admin/app");
const { getFirestore, FieldValue } = fnRequire("firebase-admin/firestore");
const { createFakeGateway } = require("../helpers/fakeMercadoPago");
const { authFor, baseSite } = require("../helpers/world");
const { makeSaveSite } = require("../../functions/lib/sites");
const { makeEngine, makeCreateSubscription, makeWebhook } = require("../../functions/lib/subscriptions");
const { signForTest } = require("../../functions/lib/webhook-signature");
const { CREATION_LOCK_MS } = require("../../functions/lib/plan");
let app, db;
before(async () => {
  const address = process.env.FIRESTORE_EMULATOR_HOST;
  assert.match(address || "", /^127\.0\.0\.1:\d+$/, "Este teste só pode acessar o emulador local.");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  app = initializeApp({ projectId: "demo-agendafacil", credential: cert({ projectId: "demo-agendafacil", clientEmail: "offline@demo-agendafacil.iam.gserviceaccount.com", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }) }, "payment-tests");
  db = getFirestore(app);
});
after(async () => { if (db) await db.terminate(); if (app) await deleteApp(app); });

function setup() {
  const gw = createFakeGateway();
  let time = Date.UTC(2026, 5, 1);
  const now = () => time;
  gw.clock = now;
  const deps = { db, FieldValue, now, getProvider: () => gw.provider };
  const engine = makeEngine(deps);
  const create = makeCreateSubscription({ ...deps, getAppBaseUrl: () => "https://demo-agendafacil.web.app" });
  return { gw, create, engine, deps, advance: (ms) => { time += ms; }, save: makeSaveSite(deps) };
}

test("Firestore real: duas chamadas concorrentes criam um único checkout; webhook publica e estorno retira", async () => {
  const w = setup();
  const uid = "emulator_concurrency";
  const { siteId } = await w.save({ auth: authFor(uid), data: { site: { ...baseSite, name: "Pagamento Concorrente" } } });
  w.gw.delayMs = 80;
  const results = await Promise.all([w.create({ auth: authFor(uid), data: { siteId } }), w.create({ auth: authFor(uid), data: { siteId } })]);
  assert.equal(new Set(results.map((r) => r.subscriptionId)).size, 1);
  assert.equal(w.gw.count("createPreapproval"), 1);
  const pre = [...w.gw.pre.values()][0];
  w.gw.authorize(pre.id);
  const charge = w.gw.charge(pre.id, "approved");
  const webhook = makeWebhook({ ...w.deps, engine: w.engine, getSecret: () => "FAKE-WEBHOOK-SECRET" });
  const send = async (topic, id, requestId) => {
    const req = { method: "POST", query: { "data.id": id, type: topic }, headers: { "x-request-id": requestId, "x-signature": signForTest({ secret: "FAKE-WEBHOOK-SECRET", dataId: id, requestId, ts: Date.now() }) } };
    const res = { status(code) { this.code = code; return this; }, send() { return this; } };
    await webhook(req, res);
    assert.equal(res.code, 200);
  };
  await send("subscription_authorized_payment", charge.invoiceId, "approval");
  await send("subscription_authorized_payment", charge.invoiceId, "approval");
  assert.equal((await db.collection("sites").doc(siteId).get()).data().published, true);
  assert.equal((await db.collection("publicSites").doc("pagamento-concorrente").get()).exists, true);
  assert.equal((await db.collection("subscriptionInvoices").where("subId", "==", results[0].subscriptionId).get()).size, 1);
  const stale = await w.gw.provider.searchInvoices({ preapprovalId: pre.id });
  w.gw.setPaymentStatus(charge.paymentId, "refunded");
  w.gw.provider.searchInvoices = async () => stale;
  await send("payment", charge.paymentId, "refund");
  assert.equal((await db.collection("sites").doc(siteId).get()).data().published, false);
  assert.equal((await db.collection("publicSites").doc("pagamento-concorrente").get()).exists, false);
});

test("Firestore real: criação remota seguida de timeout mantém trava e recupera a referência", async () => {
  const w = setup();
  const uid = "emulator_timeout";
  const { siteId } = await w.save({ auth: authFor(uid), data: { site: { ...baseSite, name: "Timeout no Emulador" } } });
  const original = w.gw.provider.createPreapproval;
  w.gw.provider.createPreapproval = async (input) => { await original(input); throw new Error("timeout após criar"); };
  await assert.rejects(w.create({ auth: authFor(uid), data: { siteId } }), (e) => e.code === "unavailable");
  const pending = await w.create({ auth: authFor(uid), data: { siteId } });
  assert.equal(pending.processing, true);
  w.advance(CREATION_LOCK_MS + 1);
  const recovered = await w.create({ auth: authFor(uid), data: { siteId } });
  assert.equal(recovered.subscriptionId, pending.subscriptionId);
  assert.equal(recovered.reused, true);
  assert.equal(w.gw.count("createPreapproval"), 1);
});
