const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("../helpers/browser");

const VALID = { apiKey: "chave-de-teste-valida-123", projectId: "agendafacil-dev-test", authDomain: "x", appId: "y" };
const UID = "AbC123dEf456GhI789jKl012MnO3"; // 28 alfanuméricos, como um uid real do Firebase Auth
const OTHER = "ZzY987wXv654UtS321rQp098LmN1";
const user = { uid: UID, email: "ana@ex.com", emailVerified: true };
const EDITOR = ["render-shared.js", "site-store.js", "firebase-config.js", "auth-shared.js", "app.js"];
const PANEL = ["render-shared.js", "site-store.js", "firebase-config.js", "auth-shared.js", "painel.js"];
const CONTENT = ["background", "end", "interval", "logo", "logoImage", "name", "primary", "schedule", "segment", "start", "work"];
const SERVER_STATE = ["published", "paymentStatus", "ownerUid", "slug", "slugClaim", "publishedSlug", "publishedHash", "contentHash", "subscriptionId", "subscriptionStatus", "accessUntil", "publishState"];
const GENERIC = "Não consegui salvar agora. Tente de novo.";
const site = { segment: "barbershop", name: "Site Existente", primary: "#c89b3c", background: "#161514", logo: "initial", logoImage: "", schedule: "semanal", work: "solo", start: "09:00", end: "20:00", interval: "30" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const typeName = (page, name) => { const i = page.doc.querySelector("#business-name"); i.value = name; i.dispatchEvent(new page.w.Event("input", { bubbles: true })); };
const keys = (o) => Object.keys(o).sort().join();
const editor = (state, extra = {}) => loadPage("editor.html", { scripts: EDITOR, config: VALID, appMode: "spark", state, ...extra });

test("CAUSA RAIZ CORRIGIDA: no Spark, editar o nome grava o rascunho direto no Firestore, sem Cloud Functions", async () => {
  const page = await editor({ user, docs: {} });
  await page.tick();
  typeName(page, "Barbearia Nova");
  await wait(2300);
  assert.equal(page.calls.callable.length, 0, "nenhuma Cloud Function foi chamada");
  const [op, key, data] = page.calls.writes[0];
  assert.equal(op, "set");
  assert.equal(key, `sites/${UID}s1`);
  assert.equal(keys(data), [...CONTENT, "ownerUid", "published", "paymentStatus", "createdAt", "updatedAt"].sort().join(), "apenas conteúdo + campos iniciais permitidos pelas regras");
  assert.equal(data.ownerUid, UID);
  assert.equal(data.published, false);
  assert.equal(data.paymentStatus, "unpaid");
  assert.equal(data.name, "Barbearia Nova");
  assert.equal(data.createdAt.__serverTimestamp, true, "timestamps vêm do servidor do Firestore");
  assert.equal(page.doc.querySelector("#save-status").textContent, "Salvo ✓");
  assert.match(page.w.location.search, new RegExp(`site=${UID}s1`));

  typeName(page, "Barbearia Nova Dois");
  await wait(2300);
  const [op2, key2, data2] = page.calls.writes[1];
  assert.equal(op2, "update");
  assert.equal(key2, `sites/${UID}s1`);
  assert.equal(keys(data2), [...CONTENT, "updatedAt"].sort().join());
  for (const f of SERVER_STATE) assert.equal(f in data2, false, `o navegador nunca grava ${f}`);
});

test("o navegador jamais envia campos de estado (publicação, assinatura, pagamento, endereço) ao salvar", async () => {
  const page = await editor({ user, docs: {} });
  await page.tick();
  typeName(page, "Barbearia Nova");
  await wait(2300);
  const [, , data] = page.calls.writes[0];
  for (const f of ["slug", "slugClaim", "publishedSlug", "publishedHash", "contentHash", "subscriptionId", "subscriptionStatus", "accessUntil", "publishState"]) assert.equal(f in data, false, f);
  assert.equal(data.published, false);
  assert.equal(data.paymentStatus, "unpaid");
});

test("ID do documento = <uid>s1..s10: pega o primeiro livre, ignora sites de outros usuários e respeita o limite de 10", async () => {
  const mine = (n) => [`sites/${UID}s${n}`, { ...site, ownerUid: UID, published: false }];
  const docs = Object.fromEntries([mine(1), mine(2), [`sites/${OTHER}s1`, { ...site, ownerUid: OTHER }]]);
  const page = await editor({ user, docs });
  await page.tick();
  typeName(page, "Barbearia Nova");
  await wait(2300);
  assert.equal(page.calls.writes[0][1], `sites/${UID}s3`);

  const full = Object.fromEntries(Array.from({ length: 10 }, (_, i) => mine(i + 1)));
  const page2 = await editor({ user, docs: full });
  await page2.tick();
  typeName(page2, "Barbearia Nova");
  await wait(2300);
  assert.equal(page2.calls.writes.length, 0);
  assert.match(page2.doc.querySelector("#toast").textContent, /Limite de 10 sites/);
});

test("não grava dados inválidos (validação antes de gravar): nome curto, reservado e cor inválida", async () => {
  const page = await editor({ user, docs: {} });
  await page.tick();
  typeName(page, "ab");
  await wait(2300);
  assert.equal(page.calls.writes.length, 0, "nome com menos de 3 caracteres não é salvo");
  typeName(page, "Admin");
  await wait(2300);
  assert.equal(page.calls.writes.length, 0, "nome reservado não é salvo");
});

test("ERRO REAL, não genérico: permission-denied explica regras/projeto, e o mesmo aviso não se repete a cada edição", async () => {
  const state = { user, docs: {}, writeError: () => Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }) };
  const page = await editor(state);
  await page.tick();
  const toast = () => page.doc.querySelector("#toast").textContent;
  typeName(page, "Barbearia A1");
  await wait(2300);
  assert.notEqual(toast(), GENERIC);
  assert.match(toast(), /permission-denied/);
  assert.match(toast(), /firebase deploy --only firestore:rules/);
  assert.equal(page.doc.querySelector("#save-status").textContent, "Não salvo");
  assert.match(page.doc.querySelector("#save-status").title, /permission-denied/);
  page.doc.querySelector("#toast").textContent = "";
  typeName(page, "Barbearia A2");
  await wait(2300);
  assert.equal(toast(), "", "mesma causa dentro de 20 s: não repete o toast");
  state.writeError = () => Object.assign(new Error("offline"), { code: "unavailable" });
  typeName(page, "Barbearia A3");
  await wait(2300);
  assert.match(toast(), /conexão/, "causa diferente: aviso novo");
});

test("modo Blaze: falha das Cloud Functions mostra a causa (nunca a frase genérica antiga)", async () => {
  const cases = { "functions/not-found": /Cloud Functions/, "functions/internal": /Cloud Functions/, "functions/unavailable": /conexão/, "functions/unauthenticated": /sessão/ };
  await Promise.all(Object.entries(cases).map(async ([code, pattern]) => {
    const state = { user, callables: { saveSite: async () => { throw Object.assign(new Error("x"), { code }); } } };
    const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, appMode: "blaze", state });
    await page.tick();
    typeName(page, "Barbearia Nova");
    await wait(2300);
    const text = page.doc.querySelector("#toast").textContent;
    assert.notEqual(text, GENERIC, code);
    assert.match(text, pattern, code);
  }));
});

test("SPARK: publicar/assinar explica a limitação do Blaze, sem chamar função nem abrir checkout", async () => {
  const page = await editor({ user, docs: {} });
  await page.tick();
  assert.equal(page.doc.querySelector("#mode-notice").hidden, false);
  assert.match(page.doc.querySelector("#mode-notice").textContent, /Blaze/);
  assert.match(page.doc.querySelector("#mode-notice").textContent, /Nada será cobrado/);
  assert.match(page.doc.querySelector("#env-info").textContent, /Projeto: agendafacil-dev-test · modo Spark/);
  assert.match(page.doc.querySelector("#publish-button").textContent, /requer plano Blaze/);
  page.doc.querySelector("#publish-button").click();
  await page.tick(60);
  assert.match(page.doc.querySelector("#toast").textContent, /plano Blaze/);
  assert.equal(page.calls.callable.length, 0);
  assert.equal(page.doc.querySelector("#checkout-modal").hasAttribute("open"), false);
  assert.deepEqual([...page.navigations], []);
});

test("SPARK: site já publicado (por Functions) não é editado direto: sem gravação e com explicação", async () => {
  const docs = { [`sites/${UID}s1`]: { ...site, ownerUid: UID, published: true, publishedSlug: "site-existente", subscriptionId: "SUB1" } };
  const page = await editor({ user, docs }, { url: `http://localhost/editor.html?site=${UID}s1` });
  await page.tick(60);
  typeName(page, "Outro Nome Qualquer");
  await wait(2300);
  assert.equal(page.calls.writes.length, 0);
  assert.match(page.doc.querySelector("#toast").textContent, /publicado/);
  assert.match(page.doc.querySelector("#toast").textContent, /Cloud Functions/);
});

test("o app RECUSA iniciar com a configuração do projeto ANTIGO (agenda-legacy-example) e não toca nele", async () => {
  const legacy = { ...VALID, projectId: "agenda-legacy-example" };
  const login = await loadPage("login.html", { scripts: ["firebase-config.js", "auth-shared.js", "login.js"], config: legacy, state: {} });
  assert.equal(login.w.AF.ready, false);
  assert.match(login.w.AF.initError, /projeto antigo/);
  assert.equal(login.calls.init, 0, "initializeApp nunca foi chamado");
  assert.match(login.doc.querySelector("#auth-message").textContent, /projeto antigo/);
  const ok = await loadPage("login.html", { scripts: ["firebase-config.js", "auth-shared.js"], config: VALID, state: {} });
  assert.equal(ok.w.AF.ready, true);
  assert.equal(ok.w.AF.projectId, "agendafacil-dev-test");
});

// ------------------------------------------------------------------ painel no Spark
const panel = (docs, extra = {}) => loadPage("painel.html", { scripts: PANEL, config: VALID, appMode: "spark", state: { user, docs, ...extra } });
const card = (page, name) => [...page.doc.querySelectorAll(".site-card")].find((c) => c.querySelector("h2").textContent === name);
const btn = (c, text) => [...c.querySelectorAll("button,a")].find((b) => b.textContent === text);

test("painel Spark: só ações que funcionam; rascunho mostra endereço derivado do nome e permite excluir", async () => {
  const docs = {
    [`sites/${UID}s1`]: { ...site, name: "Rascunho A", ownerUid: UID, published: false },
    [`sites/${OTHER}s1`]: { ...site, name: "De Outra Pessoa", ownerUid: OTHER },
  };
  const page = await panel(docs);
  await page.tick(60);
  const c = card(page, "Rascunho A");
  assert.ok(c);
  assert.equal(card(page, "De Outra Pessoa"), undefined);
  assert.match(c.textContent, /endereço \/s\/rascunho-a/);
  assert.match(c.textContent, /Cloud Functions \(plano Blaze\)/);
  assert.ok(btn(c, "Continuar editando"));
  assert.ok(btn(c, "Excluir rascunho"));
  assert.equal([...c.querySelectorAll("button,a")].some((b) => /Assinar|Cancelar|atualizar|Concluir/.test(b.textContent)), false);
  assert.match(page.doc.querySelector("#env-info").textContent, /modo Spark/);

  page.confirms.answer = false;
  btn(c, "Excluir rascunho").click();
  await page.tick();
  assert.equal(page.calls.writes.length, 0, "sem confirmação nada é apagado");
  page.confirms.answer = true;
  btn(c, "Excluir rascunho").click();
  await page.tick();
  assert.deepEqual(page.calls.writes.map((w) => [w[0], w[1]]), [["delete", `sites/${UID}s1`]]);
  assert.equal(page.calls.callable.length, 0);
});

test("painel Spark: excluir conta apaga os rascunhos e o usuário; bloqueia com site publicado/assinatura; exige confirmação e login recente", async () => {
  const draft = (n) => [`sites/${UID}s${n}`, { ...site, name: `Rascunho ${n}`, ownerUid: UID, published: false }];
  const ok = await panel(Object.fromEntries([draft(1), draft(2)]));
  await ok.tick(60);
  const click = async (p, answer) => { p.prompts.answer = answer; p.doc.querySelector("#delete-account").click(); await p.tick(40); };
  await click(ok, null);
  assert.equal(ok.calls.writes.length, 0);
  await click(ok, "excluir");
  assert.match(ok.doc.querySelector("#panel-message").textContent, /Digite EXCLUIR/);
  assert.equal(ok.calls.userDeleted, 0);
  await click(ok, "EXCLUIR");
  assert.deepEqual(ok.calls.writes.map((w) => w[0] + ":" + w[1]).sort(), [`delete:sites/${UID}s1`, `delete:sites/${UID}s2`]);
  assert.equal(ok.calls.userDeleted, 1);
  assert.ok(ok.redirects.includes("login.html"));
  assert.equal(ok.calls.callable.length, 0, "no Spark não depende de Cloud Functions");

  const blocked = await panel({ [`sites/${UID}s1`]: { ...site, ownerUid: UID, published: true, publishedSlug: "x", subscriptionId: "SUB" } });
  await blocked.tick(60);
  await click(blocked, "EXCLUIR");
  assert.match(blocked.doc.querySelector("#panel-message").textContent, /site publicado ou com assinatura/);
  assert.equal(blocked.calls.writes.length, 0);
  assert.equal(blocked.calls.userDeleted, 0);

  const recent = await panel(Object.fromEntries([draft(1)]), { userDeleteError: "auth/requires-recent-login" });
  await recent.tick(60);
  await click(recent, "EXCLUIR");
  assert.match(recent.doc.querySelector("#panel-message").textContent, /entre novamente/);
  assert.equal(recent.redirects.includes("login.html"), false);
});

test("painel Blaze continua usando as Cloud Functions (comportamento anterior preservado)", async () => {
  const docs = { [`sites/${UID}s1`]: { ...site, name: "Pendente", ownerUid: UID, published: false, subscriptionId: "SUB1" }, "subscriptions/SUB1": { ownerUid: UID, siteId: `${UID}s1`, status: "pending", initPoint: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=1" } };
  const page = await loadPage("painel.html", { scripts: PANEL, config: VALID, appMode: "blaze", state: { user, docs, callables: { syncSubscription: async () => ({}) } } });
  await page.tick(60);
  const c = card(page, "Pendente");
  assert.ok(btn(c, "Concluir assinatura"));
  btn(c, "Já paguei — atualizar").click();
  await page.tick();
  assert.equal(page.calls.callable.filter((x) => x[0] === "syncSubscription").length, 1);
  assert.match(page.doc.querySelector("#env-info").textContent, /modo Blaze/);
});
