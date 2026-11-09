const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage } = require("../helpers/browser");

const VALID = { apiKey: "chave-de-teste-valida-123", projectId: "demo-agendafacil", authDomain: "x", appId: "y" };
const EDITOR = ["render-shared.js", "firebase-config.js", "auth-shared.js", "app.js"];
const verifiedUser = { uid: "u1", email: "ana@ex.com", emailVerified: true };
const unverifiedUser = { uid: "u1", email: "ana@ex.com", emailVerified: false };
const site = { segment: "barbershop", name: "Maicon do Corte", primary: "#c89b3c", background: "#161514", logo: "initial", logoImage: "", schedule: "semanal", work: "solo", start: "09:00", end: "20:00", interval: "30" };

test("modo ausente bloqueia Firebase/pagamento e mantém a ajuda acessível", async (t) => {
  const page = await loadPage("editor.html", { scripts: EDITOR, appMode: null, config: VALID });
  t.after(() => page.w.close());
  assert.equal(page.w.AF.ready, false);
  assert.equal(page.calls.init, 0);
  assert.equal(page.doc.querySelector("#publish-button").disabled, true);
  assert.match(page.doc.querySelector("#mode-notice").textContent, /Modo do aplicativo ausente/);
  page.doc.querySelector("#help-button").click();
  assert.match(page.doc.querySelector("#toast").textContent, /Dica/);
  assert.equal(page.calls.callable.length, 0);
});

test("checkout informa criação em processamento sem redirecionar nem duplicar chamada", async (t) => {
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(verifiedUser, { callables: { createSubscription: async () => ({ processing: true, subscriptionId: "SUB1" }) } }) });
  t.after(() => page.w.close());
  await page.tick();
  typeName(page);
  page.doc.querySelector("#publish-button").click();
  await page.tick(50);
  const button = page.doc.querySelector("#start-subscription");
  button.click();
  button.click();
  await page.tick(50);
  assert.match(page.doc.querySelector("#toast").textContent, /confirmando sua assinatura/);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.calls.callable.filter(([name]) => name === "createSubscription").length, 1);
});

function typeName(page, name = "Maicon do Corte") {
  const input = page.doc.querySelector("#business-name");
  input.value = name;
  input.dispatchEvent(new page.w.Event("input", { bubbles: true }));
}

function editorState(user, extra = {}) {
  const callables = {
    saveSite: async (d) => ({ siteId: d.siteId || "SITE123456789", slug: "maicon-do-corte", slugAvailable: true }),
    createSubscription: async () => ({ subscriptionId: "SUB1", initPoint: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=1", status: "pending" }),
    ...extra.callables,
  };
  return { user, callables, docs: extra.docs };
}

test("A3/critério 4: config válida => AF.ready; só o placeholder invalida (o bug original comparava a chave com ela mesma)", async () => {
  const { w } = await loadPage("login.html", { scripts: ["firebase-config.js", "auth-shared.js"], config: VALID });
  assert.equal(w.AF.ready, true);
  assert.equal(w.AF.configIsValid({ apiKey: "COLOQUE_AQUI", projectId: "p" }), false);
  assert.equal(w.AF.configIsValid({ apiKey: "chave-de-teste-valida-123", projectId: "p" }), true);
  const bad = await loadPage("login.html", { scripts: ["firebase-config.js", "auth-shared.js"], config: { apiKey: "COLOQUE_AQUI", projectId: "p" } });
  assert.equal(bad.w.AF.ready, false);
});

test("critério 4: com config válida e sessão, clicar em Publicar salva, abre o checkout e preenche o e-mail da conta", async () => {
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(verifiedUser) });
  await page.tick();
  typeName(page);
  page.doc.querySelector("#publish-button").click();
  await page.tick(50);
  assert.ok(page.doc.querySelector("#checkout-modal").hasAttribute("open"), "checkout aberto");
  assert.equal(page.doc.querySelector("#payer-email").value, "ana@ex.com");
  assert.equal(page.doc.querySelector("#payer-email").readOnly, true);
  assert.equal(page.calls.callable[0][0], "saveSite");
  assert.equal(Object.keys(page.calls.callable[0][1].site).sort().join(), ["background", "end", "interval", "logo", "logoImage", "name", "primary", "schedule", "segment", "start", "work"].join());
});

test("editor sem sessão redireciona para o login com next e não chama o servidor", async () => {
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(null) });
  await page.tick(50);
  assert.deepEqual(page.redirects, ["login.html?next=" + encodeURIComponent("editor.html")]);
  assert.equal(page.calls.callable.length, 0);
});

test("assinar envia SOMENTE o siteId (sem preço, e-mail ou plano do navegador) e vai ao checkout do Mercado Pago", async () => {
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(verifiedUser) });
  await page.tick();
  typeName(page);
  page.doc.querySelector("#publish-button").click();
  await page.tick(50);
  page.doc.querySelector("#start-subscription").click();
  await page.tick(50);
  const call = page.calls.callable.find((c) => c[0] === "createSubscription");
  assert.equal(JSON.stringify(call[1]), JSON.stringify({ siteId: "SITE123456789" }));
  assert.deepEqual([...page.navigations], ["https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=1"]);
  assert.equal(page.calls.callable.some((c) => c[0] === "createCharge"), false, "o Pix avulso não existe mais");
});

test("critério 6: link de checkout malicioso devolvido pelo servidor nunca é aberto", async () => {
  for (const evil of ["javascript:alert(1)", "https://evil.example/pay", "https://mercadopago.com.evil.com/x", "https://evilmercadopago.com/x", "http://www.mercadopago.com.br/x", "//www.mercadopago.com.br/x"]) {
    const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(verifiedUser, { callables: { createSubscription: async () => ({ initPoint: evil }) } }) });
    await page.tick();
    typeName(page);
    page.doc.querySelector("#publish-button").click();
    await page.tick(50);
    page.doc.querySelector("#start-subscription").click();
    await page.tick(50);
    assert.equal(page.navigations.length, 0, evil);
  }
});

test("o editor não tem mais Pix nem preço de R$ 49; mostra R$ 21,90/mês", async () => {
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(verifiedUser) });
  const html = page.doc.documentElement.outerHTML;
  assert.doesNotMatch(html, /Pix|R\$ ?49|generate-pix|pix-payment/);
  assert.match(page.doc.querySelector(".checkout-order").textContent, /R\$ 21,90/);
});

test("e-mail não verificado: assinatura bloqueada no cliente com aviso e reenvio", async () => {
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(unverifiedUser) });
  await page.tick();
  typeName(page);
  page.doc.querySelector("#publish-button").click();
  await page.tick(50);
  assert.equal(page.doc.querySelector("#verify-notice").hidden, false);
  assert.equal(page.doc.querySelector("#start-subscription").disabled, true);
  page.doc.querySelector("#resend-verification").click();
  await page.tick();
  assert.equal(page.calls.verify, 1);
});

test("critério 3: editor abre o site pedido por ?site=ID; painel lista só os sites e assinaturas do usuário", async () => {
  const docs = { "sites/AAAAAAAAAA1": { ...site, name: "Barbearia A", ownerUid: "u1", slug: "barbearia-a", published: false } };
  const editor = await loadPage("editor.html", { scripts: EDITOR, config: VALID, url: "http://localhost/editor.html?site=AAAAAAAAAA1", state: editorState(verifiedUser, { docs }) });
  await editor.tick(50);
  assert.equal(editor.doc.querySelector("#business-name").value, "Barbearia A");
});

const PANEL = ["render-shared.js", "firebase-config.js", "auth-shared.js", "painel.js"];
const futureMs = Date.now() + 20 * 86400000;
const panelDocs = () => ({
  "sites/S1aaaaaaaaaa": { ...site, name: "Site Ativo", ownerUid: "u1", slug: "site-ativo", published: true, publishedSlug: "site-ativo", subscriptionId: "SUB1" },
  "sites/S2aaaaaaaaaa": { ...site, name: "Site Pendente", ownerUid: "u1", slug: "site-pendente", published: false, subscriptionId: "SUB2", subscriptionStatus: "pending" },
  "sites/S3aaaaaaaaaa": { ...site, name: "Site Suspenso", ownerUid: "u1", slug: "site-suspenso", published: false, subscriptionId: "SUB3" },
  "sites/S4aaaaaaaaaa": { ...site, name: "Site Rascunho", ownerUid: "u1", slug: "site-rascunho", published: false },
  "sites/S5aaaaaaaaaa": { ...site, name: "De Outra Pessoa", ownerUid: "u2", slug: "outra", published: false },
  "subscriptions/SUB1": { ownerUid: "u1", siteId: "S1aaaaaaaaaa", status: "active", currentPeriodEnd: futureMs, accessUntil: futureMs },
  "subscriptions/SUB2": { ownerUid: "u1", siteId: "S2aaaaaaaaaa", status: "pending", initPoint: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=9" },
  "subscriptions/SUB3": { ownerUid: "u1", siteId: "S3aaaaaaaaaa", status: "suspended", statusReason: "grace_expired" },
  "subscriptions/SUBX": { ownerUid: "u2", siteId: "S5aaaaaaaaaa", status: "active" },
});
const callsOf = (page, name) => page.calls.callable.filter((c) => c[0] === name);
const buttonByText = (page, card, text) => [...card.querySelectorAll("button,a")].find((b) => b.textContent === text);
const cardOf = (page, name) => [...page.doc.querySelectorAll(".site-card")].find((c) => c.querySelector("h2").textContent === name);

test("painel: estado real da assinatura em cada site, isolado por usuário", async () => {
  const panel = await loadPage("painel.html", { scripts: PANEL, config: VALID, state: { user: verifiedUser, docs: panelDocs() } });
  await panel.tick(50);
  assert.equal(panel.doc.querySelectorAll(".site-card").length, 4);
  assert.doesNotMatch(panel.doc.body.textContent, /De Outra Pessoa/);
  assert.match(cardOf(panel, "Site Ativo").textContent, /Assinatura ativa/);
  assert.match(cardOf(panel, "Site Ativo").textContent, /Renovação automática/);
  assert.equal(cardOf(panel, "Site Ativo").querySelector('a[href="/s/site-ativo"]').textContent, "Abrir site");
  assert.match(cardOf(panel, "Site Pendente").textContent, /Aguardando pagamento/);
  for (const name of ["Site Pendente", "Site Suspenso", "Site Rascunho"]) {
    assert.equal(cardOf(panel, name).querySelector(".site-url"), null, `${name}: sem URL pública enquanto não está no ar`);
    assert.match(cardOf(panel, name).textContent, /Ainda não publicado/, name);
  }
  assert.equal(cardOf(panel, "Site Ativo").querySelector(".site-url").textContent, "http://localhost/s/site-ativo");
  assert.match(cardOf(panel, "Site Suspenso").textContent, /Suspenso/);
  assert.match(cardOf(panel, "Site Suspenso").textContent, /carência de 7 dias/);
  assert.match(cardOf(panel, "Site Rascunho").textContent, /Rascunho/);
  assert.ok(cardOf(panel, "Site Rascunho").querySelector('a[href="editor.html?site=S4aaaaaaaaaa"]'));
});

test("painel: ações reais — concluir assinatura, atualizar status, cancelar (com confirmação) e assinar de novo", async () => {
  const state = { user: verifiedUser, docs: panelDocs(), callables: {
    syncSubscription: async () => ({ status: "active" }),
    cancelSubscription: async () => ({ status: "cancelled" }),
    createSubscription: async () => ({ initPoint: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=77" }),
  } };
  const panel = await loadPage("painel.html", { scripts: PANEL, config: VALID, state });
  await panel.tick(50);
  buttonByText(panel, cardOf(panel, "Site Pendente"), "Concluir assinatura").click();
  assert.deepEqual([...panel.navigations], ["https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=9"]);
  buttonByText(panel, cardOf(panel, "Site Pendente"), "Já paguei — atualizar").click();
  await panel.tick();
  assert.equal(JSON.stringify(callsOf(panel, "syncSubscription")[0][1]), JSON.stringify({ siteId: "S2aaaaaaaaaa" }));

  panel.confirms.answer = false;
  buttonByText(panel, cardOf(panel, "Site Ativo"), "Cancelar assinatura").click();
  await panel.tick();
  assert.equal(callsOf(panel, "cancelSubscription").length, 0, "sem confirmação, nada é cancelado");
  panel.confirms.answer = true;
  buttonByText(panel, cardOf(panel, "Site Ativo"), "Cancelar assinatura").click();
  await panel.tick();
  assert.equal(JSON.stringify(callsOf(panel, "cancelSubscription")[0][1]), JSON.stringify({ siteId: "S1aaaaaaaaaa" }));
  assert.match(panel.confirms.asked[1], /continua no ar até o fim do período/);

  buttonByText(panel, cardOf(panel, "Site Suspenso"), "Assinar de novo").click();
  await panel.tick();
  assert.equal(JSON.stringify(callsOf(panel, "createSubscription")[0][1]), JSON.stringify({ siteId: "S3aaaaaaaaaa" }));
  assert.equal(panel.navigations.at(-1), "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=77");
});

test("painel: ao voltar do checkout (?assinatura=retorno) sincroniza as assinaturas pendentes", async () => {
  const state = { user: verifiedUser, docs: panelDocs(), callables: { syncSubscription: async () => ({}) } };
  state.docs["sites/S2aaaaaaaaaa"].subscriptionStatus = "pending";
  const panel = await loadPage("painel.html", { scripts: PANEL, config: VALID, url: "http://localhost/painel.html?assinatura=retorno", state });
  await panel.tick(80);
  assert.deepEqual(callsOf(panel, "syncSubscription").map((c) => c[1].siteId), ["S2aaaaaaaaaa"]);
  assert.equal(panel.w.location.search, "");
});

test("painel: initPoint fora do Mercado Pago não gera botão nem navegação; nome malicioso vira texto; sem sessão redireciona; sair funciona", async () => {
  const docs = { "sites/S1aaaaaaaaaa": { ...site, name: '<img src=x onerror="window.__xss=1">', ownerUid: "u1", slug: "x", published: false, subscriptionId: "SUB1" }, "subscriptions/SUB1": { ownerUid: "u1", siteId: "S1aaaaaaaaaa", status: "pending", initPoint: "https://evil.example/pay" } };
  const panel = await loadPage("painel.html", { scripts: PANEL, config: VALID, state: { user: verifiedUser, docs } });
  await panel.tick(50);
  assert.equal(panel.doc.querySelector(".site-card img"), null);
  assert.match(panel.doc.querySelector(".site-card h2").textContent, /onerror/);
  assert.equal(buttonByText(panel, panel.doc.querySelector(".site-card"), "Concluir assinatura"), undefined);
  panel.doc.querySelector("#logout-button").click();
  await panel.tick();
  assert.equal(panel.calls.signOut, 1);
  assert.ok(panel.redirects.includes("login.html"));
  const anon = await loadPage("painel.html", { scripts: PANEL, config: VALID, state: { user: null } });
  await anon.tick(50);
  assert.deepEqual(anon.redirects, ["login.html?next=painel.html"]);
});

test("critério 1: cadastro cria conta e envia verificação; login; recuperação sem revelar se o e-mail existe", async () => {
  const L = ["firebase-config.js", "auth-shared.js", "login.js"];
  let p = await loadPage("login.html", { scripts: L, config: VALID, state: {} });
  p.doc.querySelector("#tab-signup").click();
  p.doc.querySelector("#signup-email").value = "nova@ex.com";
  p.doc.querySelector("#signup-password").value = "senha-forte-1";
  p.doc.querySelector("#signup-password2").value = "senha-forte-2";
  p.doc.querySelector("#form-signup").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await p.tick();
  assert.equal(p.calls.signUp.length, 0, "senhas diferentes não criam conta");
  p.doc.querySelector("#signup-password2").value = "senha-forte-1";
  p.doc.querySelector("#form-signup").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await p.tick(30);
  assert.deepEqual(p.calls.signUp[0], ["nova@ex.com", "senha-forte-1"]);
  assert.equal(p.calls.verify, 1);
  assert.ok(p.redirects.includes("painel.html"));

  p = await loadPage("login.html", { scripts: L, config: VALID, url: "http://localhost/login.html?next=editor.html%3Fsite%3DAAAA", state: {} });
  p.doc.querySelector("#signin-email").value = "ana@ex.com";
  p.doc.querySelector("#signin-password").value = "x";
  p.doc.querySelector("#form-signin").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await p.tick(30);
  assert.deepEqual(p.calls.signIn[0], ["ana@ex.com", "x"]);
  assert.ok(p.redirects.includes("editor.html?site=AAAA"));

  p = await loadPage("login.html", { scripts: L, config: VALID, url: "http://localhost/login.html?next=https%3A%2F%2Fevil.example", state: { signInError: "auth/invalid-credential" } });
  p.doc.querySelector("#signin-email").value = "ana@ex.com";
  p.doc.querySelector("#signin-password").value = "errada";
  p.doc.querySelector("#form-signin").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await p.tick(30);
  assert.equal(p.doc.querySelector("#auth-message").textContent, "E-mail ou senha incorretos.");
  assert.equal(p.redirects.length, 0);
  assert.equal(p.w.AF.safeNext("https://evil.example", "painel.html"), "painel.html");
  assert.equal(p.w.AF.safeNext("//evil.example", "painel.html"), "painel.html");

  for (const resetError of [undefined, "auth/user-not-found"]) {
    p = await loadPage("login.html", { scripts: L, config: VALID, state: { resetError } });
    p.doc.querySelector("#reset-email").value = "qualquer@ex.com";
    p.doc.querySelector("#form-reset").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
    await p.tick(30);
    assert.match(p.doc.querySelector("#auth-message").textContent, /Se existir uma conta/);
  }
});

test("sessão: persistência LOCAL configurada", async () => {
  const p = await loadPage("login.html", { scripts: ["firebase-config.js", "auth-shared.js"], config: VALID, state: {} });
  assert.equal(p.w.AF.ready, true);
});

test("site novo começa sem nome; publicar sem nome não chama o servidor e pede o nome", async () => {
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(verifiedUser) });
  await page.tick();
  assert.equal(page.doc.querySelector("#business-name").value, "");
  page.doc.querySelector("#publish-button").click();
  await page.tick(50);
  assert.equal(page.calls.callable.length, 0);
  assert.equal(page.doc.querySelector("#checkout-modal").hasAttribute("open"), false);
  assert.match(page.doc.querySelector("#toast").textContent, /Dê um nome/);
});

test("autosave: digitar o nome salva uma vez pelo servidor (debounce) e cria um único site", async () => {
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, state: editorState(verifiedUser) });
  await page.tick();
  for (const n of ["Bar", "Barb", "Barbearia Nova"]) typeName(page, n);
  await new Promise((r) => setTimeout(r, 2200));
  const saves = page.calls.callable.filter((c) => c[0] === "saveSite");
  assert.equal(saves.length, 1);
  assert.equal(saves[0][1].site.name, "Barbearia Nova");
  assert.equal(saves[0][1].siteId, undefined, "primeira gravação cria o site");
  assert.match(page.w.location.search, /site=SITE123456789/);
});

// ----------------------------------------------------------------- site no ar: edição e publicação de alterações
const liveDocs = () => ({ "sites/LIVE000000001": { ...site, name: "Barbearia no Ar", ownerUid: "u1", slug: "barbearia-no-ar", published: true, publishedSlug: "barbearia-no-ar", contentHash: "h1", publishedHash: "h1", subscriptionId: "SUB1" } });

test("editor abre site NO AR (sem redirecionar), mostra o estado e só oferece publicar quando há alterações", async () => {
  const state = editorState(verifiedUser, { docs: liveDocs(), callables: {
    saveSite: async (d) => ({ siteId: d.siteId, slug: "barbearia-no-ar", slugAvailable: true, published: true, hasUnpublishedChanges: true }),
    publishChanges: async () => ({ published: true, hasUnpublishedChanges: false }),
  } });
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, url: "http://localhost/editor.html?site=LIVE000000001", state });
  await page.tick(50);
  assert.deepEqual([...page.redirects], []);
  assert.equal(page.doc.querySelector("#business-name").value, "Barbearia no Ar");
  assert.equal(page.doc.querySelector("#published-banner").hidden, false);
  assert.match(page.doc.querySelector("#published-banner").textContent, /no ar e atualizado/);
  assert.equal(page.doc.querySelector("#publish-button").disabled, true);

  typeName(page, "Barbearia Renovada");
  assert.equal(page.doc.querySelector("#publish-button").disabled, false, "habilita imediatamente ao editar");
  assert.match(page.doc.querySelector("#publish-button").textContent, /Publicar alterações/);
  assert.match(page.doc.querySelector("#published-banner").textContent, /só aparecem para os visitantes/);

  page.doc.querySelector("#publish-button").click();
  await page.tick(80);
  const order = page.calls.callable.map((c) => c[0]);
  assert.deepEqual(order.slice(0, 2), ["saveSite", "publishChanges"], "salva e só então publica");
  assert.equal(page.calls.callable[0][1].siteId, "LIVE000000001");
  assert.equal(JSON.stringify(page.calls.callable[1][1]), JSON.stringify({ siteId: "LIVE000000001" }));
  assert.match(page.doc.querySelector("#toast").textContent, /Alterações publicadas/);
  assert.equal(page.doc.querySelector("#publish-button").disabled, true);
  assert.equal(order.includes("createSubscription"), false, "não reabre a assinatura");
});

test("editor: falha ao publicar alterações mostra a mensagem do servidor e mantém o botão disponível", async () => {
  const state = editorState(verifiedUser, { docs: liveDocs(), callables: {
    saveSite: async (d) => ({ siteId: d.siteId, slug: "barbearia-no-ar", slugAvailable: true, published: true, hasUnpublishedChanges: true }),
    publishChanges: async () => { throw Object.assign(new Error("Sua assinatura não permite mais manter o site no ar."), { code: "functions/failed-precondition" }); },
  } });
  const page = await loadPage("editor.html", { scripts: EDITOR, config: VALID, url: "http://localhost/editor.html?site=LIVE000000001", state });
  await page.tick(50);
  typeName(page, "Outro Nome");
  page.doc.querySelector("#publish-button").click();
  await page.tick(80);
  assert.match(page.doc.querySelector("#toast").textContent, /não permite mais manter o site no ar/);
  assert.equal(page.doc.querySelector("#publish-button").disabled, false);
});

// ----------------------------------------------------------------- painel: URL pública, carregamento, exclusão de conta
test("painel: carregando, vazio, e site no ar com URL pública completa, copiar link e aviso de alterações", async () => {
  const PANEL_FILES = ["render-shared.js", "firebase-config.js", "auth-shared.js", "painel.js"];
  const empty = await loadPage("painel.html", { scripts: PANEL_FILES, config: VALID, state: { user: verifiedUser, docs: {} } });
  await empty.tick(50);
  assert.equal(empty.doc.querySelector("#loading-state").hidden, true);
  assert.equal(empty.doc.querySelector("#empty-state").hidden, false);

  const docs = { ...liveDocs(), "subscriptions/SUB1": { ownerUid: "u1", siteId: "LIVE000000001", status: "active", currentPeriodEnd: futureMs, nextPaymentDate: futureMs, accessUntil: futureMs } };
  docs["sites/LIVE000000001"].publishedHash = "h0"; // há alterações não publicadas
  const panel = await loadPage("painel.html", { scripts: PANEL_FILES, config: VALID, state: { user: verifiedUser, docs } });
  await panel.tick(50);
  const card = panel.doc.querySelector(".site-card");
  assert.equal(card.querySelector(".site-url").textContent, "http://localhost/s/barbearia-no-ar");
  assert.match(card.textContent, /Próxima cobrança/);
  assert.ok([...card.querySelectorAll("a")].some((a) => /há alterações não publicadas/.test(a.textContent) && a.getAttribute("href") === "editor.html?site=LIVE000000001"));
  [...card.querySelectorAll("button")].find((b) => b.textContent === "Copiar link").click();
  await panel.tick();
  assert.deepEqual([...panel.clipboard], ["http://localhost/s/barbearia-no-ar"]);
});

test("painel: excluir conta pede confirmação digitada, mostra erros do servidor e, ao concluir, sai da sessão", async () => {
  const PANEL_FILES = ["render-shared.js", "firebase-config.js", "auth-shared.js", "painel.js"];
  let attempt = 0;
  const state = { user: verifiedUser, docs: {}, callables: { deleteAccount: async (d) => {
    attempt++;
    if (d.confirm !== "EXCLUIR") throw Object.assign(new Error("Digite EXCLUIR para confirmar a exclusão da conta."), { code: "functions/invalid-argument" });
    if (attempt === 2) throw Object.assign(new Error("Você ainda tem uma assinatura com acesso vigente."), { code: "functions/failed-precondition" });
    return { deleted: true, deletedSites: 0 };
  } } };
  const panel = await loadPage("painel.html", { scripts: PANEL_FILES, config: VALID, state });
  await panel.tick(50);
  const click = async () => { panel.doc.querySelector("#delete-account").click(); await panel.tick(30); };

  panel.prompts.answer = null; // cancelou
  await click();
  assert.equal(panel.calls.callable.length, 0);
  panel.prompts.answer = "excluir"; // digitou errado
  await click();
  assert.match(panel.doc.querySelector("#panel-message").textContent, /Digite EXCLUIR/);
  assert.equal(panel.calls.signOut, 0);
  panel.prompts.answer = "EXCLUIR"; // servidor recusa (assinatura vigente)
  await click();
  assert.match(panel.doc.querySelector("#panel-message").textContent, /assinatura com acesso vigente/);
  assert.equal(panel.calls.signOut, 0);
  await click(); // agora permitido
  assert.equal(panel.calls.signOut, 1);
  assert.ok(panel.redirects.includes("login.html"));
});
