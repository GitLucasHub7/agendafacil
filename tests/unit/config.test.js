const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const fb = JSON.parse(read("firebase.json"));
const headers = Object.fromEntries(fb.hosting.headers[0].headers.map((h) => [h.key, h.value]));

test("Hosting: cabeçalhos de segurança e CSP sem unsafe-inline/unsafe-eval em scripts", () => {
  const csp = headers["Content-Security-Policy"];
  const directive = (name) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) || "");
  assert.ok(directive("script-src"));
  assert.doesNotMatch(directive("script-src"), /unsafe-inline|unsafe-eval|\*\s|https:\s|http:/);
  assert.match(directive("object-src"), /'none'/);
  assert.match(directive("frame-ancestors"), /'none'/);
  assert.match(directive("base-uri"), /'self'/);
  assert.match(directive("default-src"), /'self'/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.ok(headers["Referrer-Policy"]);
  assert.ok(headers["Permissions-Policy"]);
  assert.equal(fb.hosting.headers[0].source, "**");
});

test("Hosting continua reescrevendo /s/** para site.html", () => {
  assert.deepEqual(fb.hosting.rewrites, [{ source: "/s/**", destination: "/site.html" }]);
});

test("Functions: runtime suportado (Node 22) em firebase.json e engines", () => {
  assert.equal(fb.functions[0].runtime, "nodejs22");
  assert.equal(JSON.parse(read("functions/package.json")).engines.node, "22");
});

test("SDK instalado oferece os clientes usados pela integração, sem chamadas de rede", () => {
  const { createSubscriptionProvider } = require("../../functions/payments/subscriptionProvider");
  const provider = createSubscriptionProvider("FAKE-OFFLINE-TOKEN");
  for (const name of ["createPreapproval", "cancelPreapproval", "getPreapproval", "findPreapprovalByExternalReference", "getInvoice", "searchInvoices", "getPayment"]) assert.equal(typeof provider[name], "function", name);
});

test("Nenhum segredo no front-end e o servidor nunca lê ownerUid do navegador", () => {
  const frontend = fs.readdirSync(path.join(root, "public")).filter((f) => /\.(js|html)$/.test(f)).map((f) => read("public/" + f)).join("\n");
  assert.doesNotMatch(frontend, /APP_USR-|TEST-[0-9a-f]{8}|access_token|MERCADOPAGO_ACCESS_TOKEN|BEGIN [A-Z ]*PRIVATE KEY/);
  const server = read("functions/lib/sites.js") + read("functions/lib/subscriptions.js") + read("functions/index.js");
  assert.doesNotMatch(server, /data\.ownerUid|body\.ownerUid|request\.data\.[a-zA-Z.]*ownerUid/);
  assert.match(server, /ownerUid: uid/);
  assert.match(server, /ownerUid: auth\.uid/);
});

test("Regras do Firestore: escrita restrita, leitura de rascunhos só pelo dono, payments fechado", () => {
  const rules = read("firestore.rules");
  assert.doesNotMatch(rules, /allow\s+(write|create|update|delete)[^;]*:\s*if\s+true/);
  assert.doesNotMatch(rules, /allow\s+read\s*:\s*if\s+true/);
  assert.match(rules, /match \/sites\/\{siteId\}[\s\S]*resource\.data\.ownerUid == request\.auth\.uid/);
  assert.match(rules, /match \/publicSites\/\{slug\}[\s\S]*allow list: if false/);
  assert.match(rules, /match \/payments\/\{paymentId\}[\s\S]*allow read, write: if false/);
  assert.match(rules, /match \/subscriptions\/\{subscriptionId\}[\s\S]*resource\.data\.ownerUid == request\.auth\.uid/);
  assert.match(rules, /match \/subscriptions\/\{subscriptionId\}[\s\S]*allow create, update, delete: if false/);
  assert.match(rules, /match \/subscriptionInvoices\/\{invoiceId\}[\s\S]*allow read, write: if false/);
  assert.match(rules, /match \/webhookEvents\/\{eventId\}[\s\S]*allow read, write: if false/);
  assert.match(rules, /match \/\{document=\*\*\}[\s\S]*if false/);
});

test("Front-end: sem innerHTML com dados dinâmicos, sem eval e sem localStorage de rascunho", () => {
  for (const f of ["app.js", "painel.js", "login.js", "site.js", "auth-shared.js", "render-shared.js"]) {
    const src = read("public/" + f);
    assert.doesNotMatch(src, /eval\(|new Function|document\.write/, f);
    assert.doesNotMatch(src, /localStorage\.(set|get)Item\(["']agenda-facil/, f);
  }
  assert.doesNotMatch(read("public/painel.js"), /innerHTML/);
  assert.doesNotMatch(read("public/login.js"), /innerHTML/);
});

test("Assinaturas: preço fica só no servidor e nenhum segredo/preço vem do navegador", () => {
  const { PLAN } = require("../../functions/lib/plan");
  assert.equal(PLAN.priceCents, 2190);
  assert.equal(PLAN.currency, "BRL");
  const server = read("functions/lib/subscriptions.js");
  assert.doesNotMatch(server, /request\.data(\.|\s*\|\|\s*\{\}\)\.)(price|amount|priceCents|transaction_amount)/);
  const frontend = fs.readdirSync(path.join(root, "public")).filter((f) => /\.(js|html)$/.test(f)).map((f) => read("public/" + f)).join("\n");
  // O front só EXIBE o preço em texto; nunca o envia nem manipula dados de cartão/assinatura do gateway.
  assert.doesNotMatch(frontend, /transaction_amount|card_token|auto_recurring|MERCADOPAGO|priceCents/);
});

test("Webhook e agendador exportados; createCharge (Pix avulso) removida das Functions", () => {
  const index = read("functions/index.js");
  for (const name of ["saveSite", "createSubscription", "cancelSubscription", "syncSubscription", "paymentWebhook", "reconcileSubscriptions"]) assert.match(index, new RegExp(`exports\\.${name}\\b`));
  assert.doesNotMatch(index, /exports\.createCharge/);
});
