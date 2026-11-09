const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const fnRequire = createRequire(path.join(__dirname, "../../functions/package.json"));

test("Functions carregam com os SDKs reais e credencial sintética, sem rede nem segredos", async (t) => {
  const app = fnRequire("firebase-admin/app");
  const descriptor = Object.getOwnPropertyDescriptor(app, "initializeApp");
  const initializeApp = app.initializeApp;
  let credentialCalls = 0;
  // Par de chaves descartável, gerado só em memória. Nunca lê credenciais do computador.
  const { privateKey } = require("node:crypto").generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credential = app.cert({ projectId: "demo-agendafacil", clientEmail: "offline@demo-agendafacil.iam.gserviceaccount.com", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) });
  credential.getAccessToken = async () => { credentialCalls++; throw new Error("Credenciais de rede proibidas neste teste."); };
  Object.defineProperty(app, "initializeApp", { configurable: true, value: () => initializeApp({
    projectId: "demo-agendafacil",
    credential,
  }) });
  t.after(async () => {
    Object.defineProperty(app, "initializeApp", descriptor);
    for (const instance of app.getApps()) await app.deleteApp(instance);
  });
  const handlers = fnRequire("./index.js");
  const expected = ["saveSite", "createSubscription", "cancelSubscription", "syncSubscription", "publishChanges", "deleteAccount", "paymentWebhook", "reconcileSubscriptions", "retryWebhookEvents"];
  assert.deepEqual(Object.keys(handlers).sort(), expected.sort());
  for (const name of expected) { assert.equal(typeof handlers[name], "function"); assert.ok(handlers[name].__endpoint, name); }
  for (const name of expected) {
    const endpoint = handlers[name].__endpoint;
    assert.equal(endpoint.minInstances, 0, name);
    assert.equal(endpoint.maxInstances, name === "reconcileSubscriptions" || name === "retryWebhookEvents" ? 1 : 3, name);
    assert.equal(endpoint.availableMemoryMb, 256, name);
  }
  assert.equal(credentialCalls, 0);
});
