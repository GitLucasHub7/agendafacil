const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseBaseUrl, buildBackUrl } = require("../../functions/lib/base-url");
const { withAppCheck } = require("../../functions/lib/guards");
const { checkEnvironment, main } = require("../../scripts/check-env");
const { loadPage } = require("../helpers/browser");

const repo = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");

// ------------------------------------------------------------------ APP_BASE_URL
test("APP_BASE_URL: aceita só origem https segura de domínio público", () => {
  for (const ok of ["https://meu-app.web.app", "https://meu-app.firebaseapp.com/", "  https://app.exemplo.com.br  "]) assert.equal(parseBaseUrl(ok).ok, true, ok);
  assert.equal(parseBaseUrl("https://MEU-APP.web.app").origin, "https://meu-app.web.app");
  assert.equal(buildBackUrl("https://meu-app.web.app"), "https://meu-app.web.app/painel.html?assinatura=retorno");
});

test("APP_BASE_URL: rejeita http, credenciais, query, fragmento, caminho, porta, IP, localhost e domínios reservados", () => {
  const bad = ["", undefined, null, 42, "http://meu-app.web.app", "ftp://x.web.app", "https://user:pass@meu-app.web.app", "https://u@meu-app.web.app",
    "https://meu-app.web.app?x=1", "https://meu-app.web.app/?x=1", "https://meu-app.web.app#frag", "https://meu-app.web.app/painel", "https://meu-app.web.app:8443",
    "https://localhost", "https://127.0.0.1", "https://10.0.0.5", "https://[::1]", "https://semponto", "https://app.local", "https://x.internal", "https://a..b.com", "https://-ruim.com",
    "https://meu app.web.app", "javascript:alert(1)", "//meu-app.web.app", "https://app.example", "https://app.test"];
  for (const v of bad) assert.equal(parseBaseUrl(v).ok, false, String(v));
});

// ------------------------------------------------------------------ App Check
test("App Check (servidor): quando exigido, nenhuma callable roda sem token válido; desligado, passa", async () => {
  let ran = 0;
  const handler = async () => { ran++; return "ok"; };
  const on = withAppCheck(handler, () => true);
  await assert.rejects(() => on({ auth: { uid: "u" } }), (e) => e.code === "unauthenticated");
  await assert.rejects(() => on({ app: {} }), (e) => e.code === "unauthenticated");
  assert.equal(ran, 0);
  assert.equal(await on({ app: { appId: "1:2:web:3" } }), "ok");
  assert.equal(await withAppCheck(handler, () => false)({}), "ok");
});

test("App Check (servidor): TODAS as callables passam pelo guarda e há agendadores + webhook com limites", () => {
  const index = read("functions/index.js");
  const callables = (index.match(/onCall\(/g) || []).length;
  const guarded = (index.match(/onCall\([^\n]*guard\(/g) || []).length;
  assert.equal(callables >= 6, true);
  assert.equal(guarded, callables, "toda onCall usa guard()");
  assert.match(index, /exports\.retryWebhookEvents = onSchedule/);
  assert.match(index, /exports\.reconcileSubscriptions = onSchedule/);
  assert.match(index, /onRequest\(\{ secrets, timeoutSeconds: 60, maxInstances: 3 \}/);
  assert.match(index, /defineBoolean\("ENFORCE_APP_CHECK", \{ default: false \}\)/);
});

const VALID = { apiKey: "chave-de-teste-valida-123", projectId: "agenda-stg-123", authDomain: "x", appId: "y" };
test("App Check (cliente): ativa com a chave configurada; sem chave não ativa; sem SDK só avisa", async () => {
  const on = await loadPage("login.html", { scripts: ["firebase-config.js", "auth-shared.js"], config: VALID, appCheckKey: "site-key-123", state: {} });
  assert.equal(JSON.stringify(on.calls.appCheck), JSON.stringify([["site-key-123", true]]));
  assert.equal(on.w.AF.appCheck, true);
  const off = await loadPage("login.html", { scripts: ["firebase-config.js", "auth-shared.js"], config: VALID, state: {} });
  assert.equal(off.calls.appCheck.length, 0);
  assert.equal(off.w.AF.appCheck, false);
  const noSdk = await loadPage("login.html", { scripts: ["firebase-config.js", "auth-shared.js"], config: VALID, appCheckKey: "k", state: { noAppCheckSdk: true } });
  assert.equal(noSdk.w.AF.ready, true, "o app continua funcionando");
  assert.equal(noSdk.w.AF.appCheck, false);
});

test("Páginas que usam Firebase carregam o SDK do App Check e a CSP o permite sem afrouxar scripts inline", () => {
  for (const f of ["editor.html", "painel.html", "login.html", "index.html"]) assert.match(read("public/" + f), /firebase-app-check-compat\.js/, f);
  const fb = JSON.parse(read("firebase.json"));
  const csp = fb.hosting.headers[0].headers.find((h) => h.key === "Content-Security-Policy").value;
  assert.match(csp, /script-src[^;]*https:\/\/www\.google\.com\/recaptcha\//);
  assert.match(csp, /frame-src[^;]*https:\/\/www\.google\.com\/recaptcha\//);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.deepEqual(fb.hosting.rewrites, [{ source: "/s/**", destination: "/site.html" }]);
});

// ------------------------------------------------------------------ verificador de ambiente
function project(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afenv-"));
  const w = (rel, content) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
  for (const f of ["firebase.json", "firestore.rules", "functions/package.json"]) w(f, over[f] ?? read(f));
  w(".firebaserc", over[".firebaserc"] ?? JSON.stringify({ projects: { default: "agenda-dev-123", dev: "agenda-dev-123", staging: "agenda-stg-123", prod: "agenda-prd-123" } }));
  w("public/firebase-config.js", over["public/firebase-config.js"] ?? `window.FIREBASE_CONFIG = { apiKey: "AIzaFAKEKEYPARATESTES0000000000000000", authDomain: "agenda-stg-123.firebaseapp.com", projectId: "agenda-stg-123", storageBucket: "agenda-stg-123.firebasestorage.app", appId: "1:1:web:1" };\nwindow.APPCHECK_SITE_KEY = "chave-appcheck";`);
  w("public/app-mode.js", over["public/app-mode.js"] ?? 'window.APP_MODE = "blaze";');
  w("functions/.env.staging", over["functions/.env.staging"] ?? "APP_BASE_URL=https://agenda-stg-123.web.app\nENFORCE_APP_CHECK=true\n");
  return root;
}
const run = (root, o = {}) => checkEnvironment({ root, alias: "staging", ...o });

test("check-env: configuração correta de staging passa sem erros", () => {
  const r = run(project());
  assert.deepEqual(r.errors, []);
  assert.equal(r.projectId, "agenda-stg-123");
});

test("check-env: placeholders do .firebaserc, projeto trocado e authDomain de outro projeto bloqueiam", () => {
  assert.match(run(project({ ".firebaserc": JSON.stringify({ projects: { staging: "SEU-PROJETO-STAGING" } }) })).errors.join("\n"), /placeholder/);
  const mixed = run(project({ "public/firebase-config.js": `window.FIREBASE_CONFIG = { apiKey: "AIzaFAKEKEYPARATESTES0000000000000000", authDomain: "agenda-prd-123.firebaseapp.com", projectId: "agenda-prd-123", storageBucket: "agenda-prd-123.firebasestorage.app" };` }));
  assert.match(mixed.errors.join("\n"), /é do projeto "agenda-prd-123", mas o deploy é para "agenda-stg-123"/);
  assert.match(mixed.errors.join("\n"), /authDomain/);
  const sameProject = run(project({ ".firebaserc": JSON.stringify({ projects: { staging: "agenda-stg-123", prod: "agenda-stg-123" } }) }));
  assert.match(sameProject.errors.join("\n"), /projetos distintos/);
  assert.match(run(project({ "public/firebase-config.js": `window.FIREBASE_CONFIG = { apiKey: "COLOQUE_AQUI", projectId: "agenda-stg-123" };` })).errors.join("\n"), /apiKey/);
});

test("check-env: APP_BASE_URL inválida, de outro projeto ou domínio próprio (sem autorização) bloqueia", () => {
  for (const bad of ["http://agenda-stg-123.web.app", "https://agenda-stg-123.web.app?x=1", "https://localhost", "https://agenda-prd-123.web.app", "https://www.meudominio.com.br", ""]) {
    const r = run(project({ "functions/.env.staging": `APP_BASE_URL=${bad}\nENFORCE_APP_CHECK=true\n` }));
    assert.equal(r.errors.length > 0, true, bad);
  }
  const custom = project({ "functions/.env.staging": "APP_BASE_URL=https://www.meudominio.com.br\nENFORCE_APP_CHECK=true\n" });
  assert.equal(run(custom, { allowCustomDomain: true }).errors.length, 0);
  assert.match(run(custom, { allowCustomDomain: true }).warnings.join("\n"), /domínio próprio/);
  assert.match(run(project({ "functions/.env.staging": "APP_BASE_URL=https://agenda-stg-123.web.app\n" })).warnings.join("\n"), /ENFORCE_APP_CHECK=false/);
});

test("check-env: segredos no .env, regras abertas, runtime antigo e CSP frouxa bloqueiam; produção exige App Check", () => {
  assert.match(run(project({ "functions/.env.staging": "APP_BASE_URL=https://agenda-stg-123.web.app\nMERCADOPAGO_ACCESS_TOKEN=abc\n" })).errors.join("\n"), /segredos/);
  assert.match(run(project({ "firestore.rules": read("firestore.rules") + "\nmatch /x/{y} { allow write: if true; }" })).errors.join("\n"), /escrita liberada/);
  assert.match(run(project({ "firestore.rules": read("firestore.rules").replace(/match \/slugClaims\/\{slug\} \{\s*allow read, write: if false;\s*\}/, "") })).errors.join("\n"), /slugClaims/);
  const fb = JSON.parse(read("firebase.json"));
  fb.functions[0].runtime = "nodejs20";
  assert.match(run(project({ "firebase.json": JSON.stringify(fb) })).errors.join("\n"), /nodejs22/);
  const fb2 = JSON.parse(read("firebase.json"));
  fb2.hosting.headers[0].headers[0].value += " 'unsafe-eval'";
  assert.match(run(project({ "firebase.json": JSON.stringify(fb2) })).errors.join("\n"), /unsafe-eval/);
  const prod = project({ ".firebaserc": JSON.stringify({ projects: { prod: "agenda-stg-123" } }), "functions/.env.prod": "APP_BASE_URL=https://agenda-stg-123.web.app\nENFORCE_APP_CHECK=false\n", "public/firebase-config.js": `window.FIREBASE_CONFIG = { apiKey: "AIzaFAKEKEYPARATESTES0000000000000000", authDomain: "agenda-stg-123.firebaseapp.com", projectId: "agenda-stg-123" };` });
  fs.writeFileSync(path.join(prod, "functions/.env.prod"), "APP_BASE_URL=https://agenda-stg-123.web.app\nENFORCE_APP_CHECK=false\n");
  const r = checkEnvironment({ root: prod, alias: "prod" });
  assert.match(r.errors.join("\n"), /ENFORCE_APP_CHECK deve ser true/);
  assert.match(r.errors.join("\n"), /APPCHECK_SITE_KEY/);
});

test("check-env --predeploy: descobre o alias pelo projeto implantado; falha fechada sem GCLOUD_PROJECT; bloqueia projeto desconhecido", () => {
  const quiet = (fn) => { const l = console.log, w = console.warn, e = console.error; console.log = console.warn = console.error = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; console.error = e; } };
  const root = project();
  assert.equal(quiet(() => main(["--predeploy"], { GCLOUD_PROJECT: "agenda-stg-123" }, root)), 0);
  assert.equal(quiet(() => main(["--predeploy"], {}, root)), 1);
  assert.equal(quiet(() => main(["--predeploy"], { GCLOUD_PROJECT: "projeto-desconhecido" }, root)), 1);
  assert.equal(quiet(() => main(["--predeploy"], { GCLOUD_PROJECT: "agenda-prd-123" }, root)), 1, "prod sem .env.prod/config próprios");
  assert.equal(quiet(() => main([], {}, root)), 2);
  assert.equal(quiet(() => main(["--predeploy"], { AF_SKIP_ENV_CHECK: "1" }, root)), 0);
});

test("firebase.json liga o verificador ao predeploy de Hosting e Functions", () => {
  const fb = JSON.parse(read("firebase.json"));
  assert.deepEqual(fb.hosting.predeploy, ["node scripts/check-assets.js", "node scripts/check-env.js --predeploy"]);
  assert.deepEqual(fb.functions[0].predeploy, ["node scripts/check-env.js --predeploy --functions"]);
});

test("o webhook processa exatamente os 3 tópicos que o painel do Mercado Pago deve enviar", () => {
  const src = read("functions/lib/subscriptions.js");
  const topics = src.match(/const KNOWN_TOPICS = \[(.*?)\];/s)[1].split(",").map((t) => t.trim().replace(/"/g, "")).sort();
  assert.deepEqual(topics, ["payment", "subscription_authorized_payment", "subscription_preapproval"]);
  for (const doc of ["docs/LANCAMENTO.md"]) if (fs.existsSync(path.join(repo, doc))) for (const t of topics) assert.match(read(doc), new RegExp(t), doc);
});

test("use-env: copia a config do ambiente só se corresponder ao projeto; não deixa configuração errada instalada", () => {
  const { useEnv } = require("../../scripts/use-env");
  const root = project();
  const dest = path.join(root, "public/firebase-config.js");
  const original = fs.readFileSync(dest, "utf8");
  fs.mkdirSync(path.join(root, "config/env"), { recursive: true });
  assert.match(useEnv({ root, alias: "staging" }).error, /não existe/);
  assert.match(useEnv({ root, alias: "../x" }).error, /alias inválido/);
  fs.writeFileSync(path.join(root, "config/env/staging.firebase-config.js"), `window.FIREBASE_CONFIG = { apiKey: "AIzaFAKEKEYPARATESTES0000000000000000", authDomain: "agenda-prd-123.firebaseapp.com", projectId: "agenda-prd-123" };`);
  assert.match(useEnv({ root, alias: "staging" }).error, /não corresponde/);
  assert.equal(fs.readFileSync(dest, "utf8"), original, "arquivo original restaurado");
  fs.writeFileSync(path.join(root, "config/env/staging.firebase-config.js"), original);
  assert.deepEqual(useEnv({ root, alias: "staging" }), { ok: true, projectId: "agenda-stg-123" });
});


// ------------------------------------------------------------------ modo Spark no verificador
const SPARK = 'window.APP_MODE = "spark";';
function devProject(mode) {
  const rc = JSON.stringify({ projects: { default: "agenda-dev-123", dev: "agenda-dev-123", staging: "agenda-stg-123", prod: "agenda-prd-123" } });
  const cfg = `window.FIREBASE_CONFIG = { apiKey: "AIzaFAKEKEYPARATESTES0000000000000000", authDomain: "agenda-dev-123.firebaseapp.com", projectId: "agenda-dev-123", storageBucket: "agenda-dev-123.firebasestorage.app" };`;
  const root = project({ ".firebaserc": rc, "public/firebase-config.js": cfg, "public/app-mode.js": `window.APP_MODE = "${mode}";` });
  fs.rmSync(path.join(root, "functions/.env.staging")); // dev no Spark não tem .env de Functions
  return root;
}

test("check-env (Spark): dev no Spark passa SEM exigir .env/segredos/App Check e avisa que publicar/assinar ficam indisponíveis", () => {
  const r = checkEnvironment({ root: devProject("spark"), alias: "dev" });
  assert.deepEqual(r.errors, []);
  assert.match(r.notes.join("\n"), /spark/i);
  assert.match(r.notes.join("\n"), /indisponíveis/);
});

test("check-env (Spark): staging e produção em Spark são bloqueados; deploy de Functions em Spark é bloqueado", () => {
  for (const alias of ["staging", "prod"]) {
    const root = project({ "public/app-mode.js": SPARK });
    const r = checkEnvironment({ root, alias });
    assert.match(r.errors.join("\n"), new RegExp(`ambiente "${alias}" precisa de Cloud Functions`), alias);
  }
  const fn = checkEnvironment({ root: devProject("spark"), alias: "dev", target: "functions" });
  assert.match(fn.errors.join("\n"), /Cloud Functions não estão disponíveis no plano Spark/);
  assert.match(fn.errors.join("\n"), /--only hosting,firestore/);
  const host = checkEnvironment({ root: devProject("spark"), alias: "dev", target: "hosting" });
  assert.deepEqual(host.errors, [], "deploy de Hosting em Spark continua permitido");
});

test("check-env (Blaze): exige configuração; modo ausente ou inválido bloqueia", () => {
  assert.match(checkEnvironment({ root: devProject("blaze"), alias: "dev" }).errors.join("\n"), /functions\/\.env\.dev/);
  const root = project();
  fs.rmSync(path.join(root, "public/app-mode.js"));
  assert.match(checkEnvironment({ root, alias: "staging" }).errors.join("\n"), /app-mode.js ausente ou inválido/);
  fs.writeFileSync(path.join(root, "public/app-mode.js"), 'window.APP_MODE = "typo";');
  assert.match(checkEnvironment({ root, alias: "staging" }).errors.join("\n"), /app-mode.js ausente ou inválido/);
});

test("check-env: a configuração do projeto ANTIGO (agenda-legacy-example) nunca passa em dev/staging/prod", () => {
  const root = devProject("spark");
  fs.writeFileSync(path.join(root, "public/firebase-config.js"), `window.FIREBASE_CONFIG = { apiKey: "AIzaFAKEKEYPARATESTES0000000000000000", authDomain: "agenda-legacy-example.firebaseapp.com", projectId: "agenda-legacy-example" };`);
  assert.match(checkEnvironment({ root, alias: "dev" }).errors.join("\n"), /é do projeto "agenda-legacy-example", mas o deploy é para "agenda-dev-123"/);
});
