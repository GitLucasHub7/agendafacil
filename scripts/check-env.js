#!/usr/bin/env node
/*
 * Verificação OFFLINE de um ambiente antes do deploy. Não acessa rede, Firebase nem Mercado Pago.
 *
 *   node scripts/check-env.js staging            -> verifica o alias "staging" do .firebaserc
 *   node scripts/check-env.js --predeploy        -> usado pelo firebase.json: confere o projeto que está sendo implantado
 *   (com --functions: predeploy das Cloud Functions; no modo Spark o deploy de Functions é bloqueado)
 *
 * Garante que Hosting/Functions de um projeto NÃO sejam implantados com a configuração web (firebase-config.js),
 * APP_BASE_URL ou segredos de outro. Segredos do Secret Manager NÃO podem ser conferidos daqui (ver docs/LANCAMENTO.md).
 * Escape de emergência (não recomendado): AF_SKIP_ENV_CHECK=1.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parseBaseUrl } = require("../functions/lib/base-url");

const PLACEHOLDER = /SEU-PROJETO|COLOQUE_AQUI|PLACEHOLDER|CHANGE[-_]?ME/i;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function loadWebConfig(root) {
  const sandbox = { window: {} };
  vm.runInNewContext(read(root, "public/firebase-config.js"), sandbox, { timeout: 1000 });
  return { config: sandbox.window.FIREBASE_CONFIG || {}, appCheckKey: sandbox.window.APPCHECK_SITE_KEY || "" };
}

// Modo explícito: ausência/erro bloqueia a validação em vez de ativar pagamentos.
function loadMode(root) {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(read(root, "public/app-mode.js"), sandbox, { timeout: 1000 });
    return ["spark", "blaze"].includes(sandbox.window.APP_MODE) ? sandbox.window.APP_MODE : null;
  } catch {
    return null;
  }
}

function checkEnvironment({ root, alias, projectId, allowCustomDomain = false, target = "hosting" }) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  // 1) .firebaserc
  let rc = {};
  try {
    rc = JSON.parse(read(root, ".firebaserc"));
  } catch {
    err(".firebaserc ausente ou inválido.");
  }
  const projects = (rc && rc.projects) || {};
  if (!projectId && alias) projectId = projects[alias];
  if (!alias && projectId) alias = ["prod", "staging", "dev"].find((a) => projects[a] === projectId);
  if (!alias) err(`O projeto "${projectId || "?"}" não corresponde a nenhum alias (dev/staging/prod) do .firebaserc.`);
  if (!projectId) {
    err(`Alias "${alias}" sem projeto no .firebaserc.`);
    return { errors, warnings, notes, alias, projectId };
  }
  if (PLACEHOLDER.test(projectId)) err(`.firebaserc: o alias "${alias}" ainda tem placeholder ("${projectId}"). Preencha com o ID real do projeto.`);
  else if (!PROJECT_ID.test(projectId)) err(`ID de projeto inválido: "${projectId}".`);
  if (projectId === "agenda-legacy-example") err("O projeto legado agenda-legacy-example não pode receber esta versão.");
  const sameId = Object.entries(projects).filter(([a, id]) => a !== "default" && id === projectId).map(([a]) => a);
  if (sameId.length > 1) err(`O mesmo projeto aparece em mais de um alias (${sameId.join(", ")}): ambientes precisam ser projetos distintos.`);

  // 2) configuração web do Firebase
  let web;
  try {
    web = loadWebConfig(root);
  } catch (e) {
    err(`public/firebase-config.js ilegível: ${e.message}`);
  }
  if (web) {
    const c = web.config;
    if (c.projectId !== projectId) err(`public/firebase-config.js é do projeto "${c.projectId}", mas o deploy é para "${projectId}". Troque o arquivo pelo do ambiente.`);
    if (!c.apiKey || PLACEHOLDER.test(String(c.apiKey))) err("public/firebase-config.js: apiKey ausente ou com placeholder.");
    if (c.authDomain && ![`${projectId}.firebaseapp.com`, `${projectId}.web.app`].includes(c.authDomain)) {
      err(`authDomain "${c.authDomain}" não pertence ao projeto "${projectId}" (use ${projectId}.firebaseapp.com ou .web.app).`);
    }
    if (c.storageBucket && !String(c.storageBucket).startsWith(projectId)) warn(`storageBucket "${c.storageBucket}" não começa com o ID do projeto.`);
    if (alias === "prod" && loadMode(root) !== "spark" && !web.appCheckKey) err("Produção exige window.APPCHECK_SITE_KEY preenchida em public/firebase-config.js.");
    if (alias === "staging" && !web.appCheckKey) warn("Staging sem APPCHECK_SITE_KEY: o App Check ainda não foi testado (necessário antes da produção).");
  }

  // 3) modo do app e funções (Spark não tem Cloud Functions)
  const mode = loadMode(root);
  if (!mode) err('public/app-mode.js ausente ou inválido: defina APP_MODE como "spark" ou "blaze".');
  if (mode === "spark") {
    if (alias && alias !== "dev") err(`public/app-mode.js está em "spark", mas o ambiente "${alias}" precisa de Cloud Functions (plano Blaze). Use "blaze" aqui.`);
    if (target === "functions") err("Cloud Functions não estão disponíveis no plano Spark. Faça o deploy só de Hosting e regras: firebase deploy --only hosting,firestore --project <alias>.");
    notes.push('Modo "spark": os rascunhos são salvos no Firestore; publicar e assinar (Mercado Pago) ficam indisponíveis até migrar para o Blaze.');
  } else if (mode === "blaze") {
    // functions/.env.<alias|projeto>
    const envRel = [`functions/.env.${alias}`, `functions/.env.${projectId}`].find((f) => exists(root, f));
    if (!envRel) {
      err(`Arquivo functions/.env.${alias} (ou .env.${projectId}) ausente. Copie functions/.env.example.`);
    } else {
      const env = parseEnv(read(root, envRel));
      const base = parseBaseUrl(env.APP_BASE_URL);
      if (!base.ok) err(`${envRel}: APP_BASE_URL inválida (${base.error}).`);
      else {
        const defaults = [`${projectId}.web.app`, `${projectId}.firebaseapp.com`];
        if (!defaults.includes(base.host)) {
          if (allowCustomDomain) warn(`APP_BASE_URL usa domínio próprio (${base.host}); confirme DNS/HTTPS e domínio autorizado no Authentication.`);
          else err(`${envRel}: APP_BASE_URL (${base.host}) não é ${defaults.join(" nem ")}. O lançamento inicial usa o domínio padrão; domínio próprio só com --allow-custom-domain.`);
        }
      }
      const enforce = String(env.ENFORCE_APP_CHECK || "").toLowerCase() === "true";
      if (alias === "prod" && !enforce) err(`${envRel}: ENFORCE_APP_CHECK deve ser true em produção.`);
      if (alias === "staging" && !enforce) warn(`${envRel}: ENFORCE_APP_CHECK=false em staging; teste com true antes da produção.`);
      if (/MERCADOPAGO|ACCESS_TOKEN|WEBHOOK_SECRET|APP_USR|TEST-/i.test(read(root, envRel))) err(`${envRel}: não coloque segredos aqui; use o Secret Manager.`);
    }
  }

  // 4) firebase.json, regras e runtime
  try {
    const fb = JSON.parse(read(root, "firebase.json"));
    if (!(fb.hosting && (fb.hosting.rewrites || []).some((r) => r.source === "/s/**" && r.destination === "/site.html"))) err("firebase.json: rewrite /s/** -> /site.html ausente.");
    const csp = (((fb.hosting && fb.hosting.headers) || []).flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy") || {}).value || "";
    if (!csp) err("firebase.json: Content-Security-Policy ausente.");
    if (/unsafe-eval|script-src[^;]*unsafe-inline/.test(csp)) err("firebase.json: CSP permite unsafe-eval/unsafe-inline em scripts.");
    const fn = [].concat(fb.functions || [])[0] || {};
    if (fn.runtime !== "nodejs22") err(`firebase.json: runtime das Functions é "${fn.runtime}"; use nodejs22.`);
    if (!(fb.firestore && fb.firestore.rules && exists(root, fb.firestore.rules))) err("firebase.json: arquivo de regras do Firestore ausente.");
  } catch (e) {
    err(`firebase.json ilegível: ${e.message}`);
  }
  try {
    const rules = read(root, "firestore.rules");
    if (/allow\s+(write|create|update|delete)[^;]*:\s*if\s+true/.test(rules)) err("firestore.rules: há escrita liberada ao cliente (if true).");
    for (const col of ["slugClaims", "subscriptionInvoices", "webhookEvents", "payments", "incidents"]) {
      if (!new RegExp(`match /${col}/\\{[^}]+\\}\\s*\\{\\s*allow read, write: if false;`).test(rules)) err(`firestore.rules: coleção ${col} deve estar fechada ao cliente.`);
    }
  } catch (e) {
    err(`firestore.rules ilegível: ${e.message}`);
  }
  try {
    if (JSON.parse(read(root, "functions/package.json")).engines.node !== "22") err("functions/package.json: engines.node deve ser 22.");
  } catch (e) {
    err(`functions/package.json ilegível: ${e.message}`);
  }

  notes.push("Não verificável aqui: segredos no Secret Manager, restrição de referrer da chave de API, domínio autorizado, webhook no Mercado Pago, plano Blaze.");
  return { errors, warnings, notes, alias, projectId };
}

function main(argv, env = process.env, root = path.resolve(__dirname, "..")) {
  if (env.AF_SKIP_ENV_CHECK === "1") {
    console.warn("⚠ AF_SKIP_ENV_CHECK=1: verificação de ambiente PULADA por sua conta e risco.");
    return 0;
  }
  const predeploy = argv.includes("--predeploy");
  const allowCustomDomain = argv.includes("--allow-custom-domain") || env.AF_ALLOW_CUSTOM_DOMAIN === "1";
  const aliasArg = argv.find((a) => !a.startsWith("--"));
  if (!predeploy && !aliasArg) {
    console.error("Uso: node scripts/check-env.js <dev|staging|prod> | --predeploy");
    return 2;
  }
  if (predeploy && !env.GCLOUD_PROJECT) {
    console.error("Não foi possível identificar o projeto do deploy (GCLOUD_PROJECT ausente). Rode com --project <alias> ou use AF_SKIP_ENV_CHECK=1.");
    return 1;
  }
  const result = checkEnvironment({ root, alias: predeploy ? undefined : aliasArg, projectId: predeploy ? env.GCLOUD_PROJECT : undefined, allowCustomDomain, target: argv.includes("--functions") ? "functions" : "hosting" });
  console.log(`Ambiente: ${result.alias || "?"} (projeto ${result.projectId || "?"})`);
  for (const w of result.warnings) console.warn(`  ⚠ ${w}`);
  for (const e of result.errors) console.error(`  ✖ ${e}`);
  for (const n of result.notes) console.log(`  ℹ ${n}`);
  if (result.errors.length) {
    console.error(`\n${result.errors.length} problema(s) impedem o deploy. Corrija e rode de novo.`);
    return 1;
  }
  console.log("\nVerificação de ambiente OK.");
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { checkEnvironment, parseEnv, main };
