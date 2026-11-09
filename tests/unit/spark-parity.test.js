const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { validateSiteInput, ALLOWED_FIELDS, SEGMENTS: SERVER_SEGMENTS, MAX_LOGO_CHARS } = require("../../functions/lib/validate");
const { MAX_SITES_PER_USER } = require("../../functions/lib/sites");
const { RESERVED } = require("../../functions/lib/slug");
const { world, authFor, baseSite, code } = require("../helpers/world");

const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
function loadStore() {
  const dom = new JSDOM("<!doctype html><html></html>", { runScripts: "outside-only" });
  dom.window.eval(read("public/render-shared.js"));
  dom.window.eval(read("public/site-store.js"));
  return dom.window.AgendaFacilStore;
}
const Store = loadStore();

const ok = { segment: "barbershop", name: "Maicon do Corte", primary: "#C89B3C", background: "#161514", logo: "initial", logoImage: "", schedule: "semanal", work: "solo", start: "09:00", end: "20:00", interval: "30" };
const png = "data:image/png;base64,iVBORw0KGgo=";
const cases = {
  "padrão do construtor": ok,
  "logo upload válido": { ...ok, logo: "upload", logoImage: png },
  "ícone descarta a imagem": { ...ok, logo: "star", logoImage: png },
  "intervalo numérico": { ...ok, interval: 45 },
  "nome com espaços extras": { ...ok, name: "  Studio   Ana  " },
  "nome acentuado": { ...ok, name: "Ateliê da Ânia & Cia" },
  "nome vazio": { ...ok, name: "" },
  "nome longo (46)": { ...ok, name: "a".repeat(46) },
  "nome só símbolos": { ...ok, name: "!!!" },
  "nome reservado": { ...ok, name: "Admin" },
  "caractere de controle": { ...ok, name: "ab\u0000c" },
  "nome não é texto": { ...ok, name: 123 },
  "segmento __proto__": { ...ok, segment: "__proto__" },
  "cor inválida": { ...ok, primary: "red" },
  "fundo inválido": { ...ok, background: "#12345" },
  "logo gif": { ...ok, logo: "gif" },
  "logo upload vazio": { ...ok, logo: "upload", logoImage: "" },
  "logo com aspas (XSS)": { ...ok, logo: "upload", logoImage: 'x" onerror="alert(1)' },
  "logo externo": { ...ok, logo: "upload", logoImage: "https://evil.example/t.png" },
  "logo svg": { ...ok, logo: "upload", logoImage: "data:image/svg+xml;base64,PHN2Zz4=" },
  "logo grande demais": { ...ok, logo: "upload", logoImage: "data:image/png;base64," + "A".repeat(MAX_LOGO_CHARS) },
  "agenda inválida": { ...ok, schedule: "weekly" },
  "atendimento inválido": { ...ok, work: "grupo" },
  "hora inválida": { ...ok, start: "25:00" },
  "fim antes do início": { ...ok, start: "20:00", end: "09:00" },
  "intervalo inválido": { ...ok, interval: "5" },
  "campo de estado": { ...ok, published: true },
  "dono forjado": { ...ok, ownerUid: "outro" },
  "assinatura forjada": { ...ok, subscriptionId: "x" },
};

test("PARIDADE: a validação do navegador aceita/recusa exatamente o que o servidor aceita/recusa", () => {
  for (const [label, input] of Object.entries(cases)) {
    let server = null;
    try { server = validateSiteInput(input).clean; } catch { server = null; }
    let client = null;
    try { client = Store.validateDraft(input); } catch { client = null; }
    assert.equal(client !== null, server !== null, `${label}: navegador=${client !== null} servidor=${server !== null}`);
    if (server) assert.equal(JSON.stringify(client), JSON.stringify(server), `${label}: mesmo conteúdo normalizado`);
  }
});

test("as listas do navegador, do servidor e das REGRAS do Firestore são a mesma (fonte única verificada)", () => {
  const rules = read("firestore.rules");
  const list = (name) => [...rules.match(new RegExp(`function ${name}\\(\\) \\{\\s*return \\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal([...list("contentFields")].sort().join(), [...ALLOWED_FIELDS].sort().join(), "campos de conteúdo: regras == servidor");
  assert.equal([...Store.CONTENT_FIELDS].sort().join(), [...ALLOWED_FIELDS].sort().join(), "campos de conteúdo: navegador == servidor");
  const inRule = (field) => [...rules.match(new RegExp(`d\\.${field} in \\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(inRule("segment").join(), SERVER_SEGMENTS.join());
  assert.equal(inRule("segment").join(), Store.SEGMENTS.join());
  assert.equal(inRule("schedule").join(), Store.SCHEDULES.join());
  assert.equal(inRule("work").join(), Store.WORKS.join());
  assert.equal(inRule("interval").join(), Store.INTERVALS.join());
  assert.equal(inRule("logo").join(), Store.ICON_LOGOS.join());
  assert.match(rules, new RegExp(`size\\(\\) <= ${MAX_LOGO_CHARS}\\b`), "limite do logo nas regras == servidor");
  assert.equal(Store.MAX_LOGO_CHARS, MAX_LOGO_CHARS);
  assert.equal(Store.MAX_SITES, MAX_SITES_PER_USER, "limite de sites: navegador == servidor");
  assert.match(rules, new RegExp(`s\\(\\[1-9\\]\\|${MAX_SITES_PER_USER}\\)\\$`), "limite de sites nas regras == servidor");
  assert.equal([...Store.RESERVED].sort().join(), [...RESERVED].sort().join(), "nomes reservados: navegador == servidor");
});

test("REGRAS de rascunho: texto das regras garante dono, estado intocável, publicado imutável e sem escrita aberta", () => {
  const rules = read("firestore.rules");
  const sites = rules.match(/match \/sites\/\{siteId\} \{[\s\S]*?\n    \}\n/)[0];
  assert.doesNotMatch(rules, /allow\s+(write|create|update|delete)[^;]*:\s*if\s+true/);
  assert.match(sites, /allow get, list: if request\.auth != null && resource\.data\.ownerUid == request\.auth\.uid/);
  // cada instrução "allow" é analisada ISOLADAMENTE (uma condição de outra instrução não pode "emprestar" a garantia)
  const stmt = {};
  for (const m of sites.matchAll(/allow ([a-z, ]+):([\s\S]*?);(?=\n\s*(?:allow|\}))/g)) stmt[m[1].trim()] = m[2];
  assert.deepEqual(Object.keys(stmt).sort(), ["create", "delete", "get, list", "update"]);
  const create = stmt.create, update = stmt.update, del = stmt.delete;
  // create
  assert.match(create, /request\.resource\.data\.ownerUid == request\.auth\.uid/);
  assert.match(create, /request\.resource\.data\.published == false/);
  assert.match(create, /request\.resource\.data\.paymentStatus == 'unpaid'/);
  assert.match(create, /keys\(\)\.hasOnly\(contentFields\(\)\.concat\(initFields\(\)\)\)/);
  assert.match(create, /keys\(\)\.hasAll\(contentFields\(\)\.concat\(initFields\(\)\)\)/);
  assert.match(create, /siteId\.matches\('\^' \+ request\.auth\.uid \+ 's\(\[1-9\]\|10\)\$'\)/);
  assert.match(create, /request\.auth\.uid\.matches\('\^\[A-Za-z0-9\]\{20,36\}\$'\)/);
  assert.match(create, /createdAt == request\.time/);
  assert.match(create, /updatedAt == request\.time/);
  assert.match(create, /validContent\(request\.resource\.data\)/);
  // update: só dono, só rascunho, só campos de conteúdo (+updatedAt), tempo do servidor, conteúdo válido
  assert.match(update, /resource\.data\.ownerUid == request\.auth\.uid/);
  assert.match(update, /resource\.data\.get\('published', false\) == false/);
  assert.match(update, /affectedKeys\(\)\.hasOnly\(contentFields\(\)\.concat\(\['updatedAt'\]\)\)/);
  assert.match(update, /updatedAt == request\.time/);
  assert.match(update, /validContent\(request\.resource\.data\)/);
  // delete: só dono, só rascunho sem assinatura
  assert.match(del, /resource\.data\.ownerUid == request\.auth\.uid/);
  assert.match(del, /resource\.data\.get\('published', false\) == false/);
  assert.match(del, /resource\.data\.get\('subscriptionId', null\) == null/);
  // toda operação de escrita exige login
  for (const op of ["create", "update", "delete"]) assert.match(stmt[op], /request\.auth != null/, op);
  // nenhum campo de estado entra na lista do navegador
  const content = rules.match(/function contentFields\(\) \{\s*return \[([^\]]*)\]/)[1];
  for (const f of ["published", "paymentStatus", "ownerUid", "slug", "slugClaim", "publishedSlug", "publishedHash", "contentHash", "subscriptionId", "subscriptionStatus", "accessUntil", "publishState"]) assert.doesNotMatch(content, new RegExp(`'${f}'`), f);
  // coleções de estado/pagamento continuam fechadas
  for (const col of ["subscriptions"]) assert.match(rules, new RegExp(`match /${col}/`));
  for (const col of ["subscriptionInvoices", "webhookEvents", "slugClaims", "incidents", "payments"]) assert.match(rules, new RegExp(`match /${col}/\\{[^}]+\\}\\s*\\{\\s*allow read, write: if false;`), col);
});

// ------------------------------------------------------------------ Spark -> Blaze (migração de plano sem perder rascunhos)
const UID = "AbC123dEf456GhI789jKl012MnO3";
const clientDraft = (n = 1, name = "Barbearia do Spark") => [`sites/${UID}s${n}`, { ...baseSite, name, ownerUid: UID, published: false, paymentStatus: "unpaid", createdAt: "TS", updatedAt: "TS" }];

test("SPARK→BLAZE: rascunho criado no navegador (sem slug/hash) assina, publica e trava o endereço", async () => {
  const w = world();
  const [key, doc] = clientDraft();
  w.db.seed(key, doc);
  const siteId = `${UID}s1`;
  const s = await w.subscribe(UID, siteId);
  assert.equal(w.db._store.get(`slugClaims/barbearia-do-spark`).state, "reserved");
  await w.pay(s.preId, "approved");
  assert.equal(w.siteDoc(siteId).published, true);
  assert.equal(w.pub("barbearia-do-spark").siteId, siteId);
  assert.equal(w.siteDoc(siteId).slug, "barbearia-do-spark", "o endereço fica gravado no site ao publicar");
  // renomear depois de publicado não muda a URL (a trava funciona mesmo para sites nascidos no Spark)
  const out = await w.save({ auth: authFor(UID), data: { siteId, site: { ...baseSite, name: "Nome Totalmente Novo" } } });
  assert.equal(out.slug, "barbearia-do-spark");
  await w.publishChanges({ auth: authFor(UID), data: { siteId } });
  assert.equal(w.pub("barbearia-do-spark").name, "Nome Totalmente Novo");
  assert.equal(w.pub("nome-totalmente-novo"), undefined);
});

test("SPARK→BLAZE: isolamento mantido — outro usuário não assina nem edita o rascunho criado no navegador", async () => {
  const w = world();
  const [key, doc] = clientDraft();
  w.db.seed(key, doc);
  const siteId = `${UID}s1`;
  assert.equal(await code(w.create({ auth: authFor("outroUsuarioQualquer1234567"), data: { siteId } })), "not-found");
  assert.equal(await code(w.save({ auth: authFor("outroUsuarioQualquer1234567"), data: { siteId, site: { ...baseSite, name: "Invadido Aqui" } } })), "not-found");
  assert.equal(w.siteDoc(siteId).name, "Barbearia do Spark");
});

// ------------------------------------------------------------------ fiação das páginas
test("FIAÇÃO: todo script/CSS local referenciado existe e a ordem de carga está correta", () => {
  const pub = path.join(root, "public");
  for (const file of fs.readdirSync(pub).filter((f) => f.endsWith(".html"))) {
    const html = read("public/" + file);
    const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith("data:"));
    for (const ref of refs) assert.equal(fs.existsSync(path.join(pub, ref.replace(/^\//, ""))), true, `${file} referencia ${ref}, que não existe`);
    const scripts = refs.filter((r) => r.endsWith(".js")).map((r) => r.replace(/^\//, ""));
    const before = (a, b) => assert.ok(scripts.indexOf(a) !== -1 && scripts.indexOf(a) < scripts.indexOf(b), `${file}: ${a} deve carregar antes de ${b}`);
    if (scripts.includes("auth-shared.js")) before("app-mode.js", "auth-shared.js"); // AF.mode lê APP_MODE ao iniciar
    if (scripts.includes("auth-shared.js")) before("firebase-config.js", "auth-shared.js");
    if (file === "editor.html") { before("render-shared.js", "site-store.js"); before("site-store.js", "app.js"); }
    if (file === "painel.html") { before("render-shared.js", "site-store.js"); before("site-store.js", "painel.js"); }
  }
});

test("o modo Spark vem DESLIGADO de Functions por padrão neste repositório e o código não depende de segredos", () => {
  assert.match(read("public/app-mode.js"), /window\.APP_MODE = "spark"/);
  const front = fs.readdirSync(path.join(root, "public")).filter((f) => /\.(js|html)$/.test(f)).map((f) => read("public/" + f)).join("\n");
  assert.doesNotMatch(front, /APP_USR-|TEST-[0-9a-f]{8}|access_token|MERCADOPAGO|BEGIN [A-Z ]*PRIVATE KEY/);
});
