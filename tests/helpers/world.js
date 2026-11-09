// Monta um "mundo" de teste: Firestore falso + gateway falso + relógio controlável + handlers reais.
const { createFakeDb, FieldValue } = require("./fakeFirestore");
const { createFakeGateway } = require("./fakeMercadoPago");
const { makeSaveSite } = require("../../functions/lib/sites");
const { makeEngine, makeCreateSubscription, makeCancelSubscription, makeSyncSubscription, makePublishChanges, makeReconcile, makeWebhook } = require("../../functions/lib/subscriptions");
const { signForTest } = require("../../functions/lib/webhook-signature");

const SECRET = "segredo-de-teste-do-webhook";
const baseSite = { segment: "barbershop", primary: "#c89b3c", background: "#161514", logo: "initial", logoImage: "", schedule: "semanal", work: "solo", start: "09:00", end: "20:00", interval: "30" };
const authFor = (uid, extra = {}) => ({ uid, token: { email: `${uid}@ex.com`, email_verified: true, ...extra } });
const code = async (p) => { try { await p; return "ok"; } catch (e) { return e.code || e.message; } };

function world({ appBaseUrl = "https://app-teste.web.app" } = {}) {
  const db = createFakeDb();
  const gw = createFakeGateway();
  let t = Date.UTC(2026, 5, 1, 12, 0, 0);
  const clock = { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
  gw.clock = clock.now;
  const common = { db, FieldValue, getProvider: () => gw.provider, now: clock.now };
  const engine = makeEngine(common);
  const w = {
    db, gw, clock, engine, seq: 0,
    save: makeSaveSite({ db, FieldValue, now: clock.now, afterSave: (id) => engine.applyState(id, null) }),
    create: makeCreateSubscription({ ...common, getAppBaseUrl: () => appBaseUrl }),
    cancel: makeCancelSubscription({ ...common, engine }),
    sync: makeSyncSubscription({ ...common, engine }),
    publishChanges: makePublishChanges({ db, engine }),
    reconcile: makeReconcile({ ...common, engine }),
    webhook: makeWebhook({ ...common, engine, getSecret: () => SECRET }),
    SECRET,
  };
  w.newSite = async (uid, name) => (await w.save({ auth: authFor(uid), data: { site: { ...baseSite, name } } })).siteId;
  w.subscribe = async (uid, siteId) => {
    const out = await w.create({ auth: authFor(uid), data: { siteId } });
    return { ...out, preId: db._store.get(`subscriptions/${out.subscriptionId}`).mpPreapprovalId };
  };
  w.sub = (id) => db._store.get(`subscriptions/${id}`);
  w.siteDoc = (id) => db._store.get(`sites/${id}`);
  w.pub = (slug) => db._store.get(`publicSites/${slug}`);
  w.events = () => [...db._store.entries()].filter(([k]) => k.startsWith("webhookEvents/")).map(([, v]) => v);
  w.invoices = (subId) => [...db._store.entries()].filter(([k, v]) => k.startsWith("subscriptionInvoices/") && v.subId === subId).map(([, v]) => v);
  w.hook = async (topic, dataId, o = {}) => {
    const requestId = o.requestId ?? `req-${++w.seq}`;
    const headers = { "x-request-id": requestId };
    if (o.sign !== false) headers["x-signature"] = signForTest({ secret: o.secret ?? SECRET, dataId: o.signId ?? dataId, requestId: o.sigRequestId ?? requestId, ts: o.ts ?? clock.now() });
    const req = { method: o.method || "POST", query: { "data.id": String(dataId), type: topic, ...(o.query || {}) }, body: o.body || {}, headers };
    const res = { code: 0, body: "" };
    res.status = (c) => { res.code = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    await (o.handler || w.webhook)(req, res);
    return res;
  };
  // Pagamento aprovado de uma assinatura e notificação correspondente
  w.pay = async (preId, status = "approved", opts = {}) => {
    w.gw.authorize(preId);
    const c = w.gw.charge(preId, status, opts);
    const res = await w.hook("subscription_authorized_payment", c.invoiceId);
    return { ...c, res };
  };
  return w;
}

module.exports = { world, authFor, code, baseSite, SECRET };
