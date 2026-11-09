const test = require("node:test");
const assert = require("node:assert/strict");
const { world, authFor, code, baseSite } = require("../helpers/world");
const { DAY_MS, GRACE_DAYS } = require("../../functions/lib/plan");

const PUBLIC_KEYS = ["background", "end", "interval", "logo", "logoImage", "name", "primary", "publishedAt", "schedule", "segment", "siteId", "slug", "start", "work"];

async function liveSite(w, uid = "alice", name = "Maicon do Corte") {
  const siteId = await w.newSite(uid, name);
  const s = await w.subscribe(uid, siteId);
  await w.pay(s.preId, "approved");
  return { siteId, ...s };
}
const edit = (w, uid, siteId, patch) => w.save({ auth: authFor(uid), data: { siteId, site: { ...baseSite, ...patch } } });

test("publicação real: cópia pública contém SOMENTE campos públicos (nada de dono, pagamento ou assinatura)", async () => {
  const w = world();
  const { siteId } = await liveSite(w);
  const pub = w.pub("maicon-do-corte");
  assert.deepEqual(Object.keys(pub).sort(), PUBLIC_KEYS);
  assert.equal(pub.siteId, siteId);
  assert.equal(JSON.stringify(pub).includes("alice"), false);
});

test("editar site no ar: dados salvos como rascunho; a versão pública só muda ao publicar as alterações", async () => {
  const w = world();
  const { siteId } = await liveSite(w);
  const out = await edit(w, "alice", siteId, { name: "Barbearia Renomeada", primary: "#112233" });
  assert.equal(out.slug, "maicon-do-corte", "URL pública estável");
  assert.equal(out.hasUnpublishedChanges, true);
  assert.equal(w.pub("maicon-do-corte").name, "Maicon do Corte", "visitante ainda vê a versão publicada");
  assert.equal(w.siteDoc(siteId).name, "Barbearia Renomeada", "rascunho preservado");

  const res = await w.publishChanges({ auth: authFor("alice"), data: { siteId } });
  assert.deepEqual({ ...res }, { published: true, hasUnpublishedChanges: false });
  assert.equal(w.pub("maicon-do-corte").name, "Barbearia Renomeada");
  assert.equal(w.pub("maicon-do-corte").primary, "#112233");
  assert.equal(w.pub("barbearia-renomeada"), undefined, "nenhum endereço novo foi criado");
  assert.equal((await edit(w, "alice", siteId, { name: "Barbearia Renomeada", primary: "#112233" })).hasUnpublishedChanges, false);
});

test("publishChanges: só o dono, só site no ar e só com direito de acesso", async () => {
  const w = world();
  const { siteId, subscriptionId } = await liveSite(w);
  const draftOnly = await w.newSite("alice", "Outro Site");
  assert.equal(await code(w.publishChanges({ data: { siteId } })), "unauthenticated");
  assert.equal(await code(w.publishChanges({ auth: authFor("bob"), data: { siteId } })), "not-found");
  assert.equal(await code(w.publishChanges({ auth: authFor("alice"), data: { siteId: draftOnly } })), "not-found", "site sem assinatura");
  assert.equal(await code(w.publishChanges({ auth: authFor("alice"), data: { siteId: "../x" } })), "invalid-argument");
  // assinatura em carência ainda permite
  const end = w.sub(subscriptionId).currentPeriodEnd;
  await edit(w, "alice", siteId, { name: "Em Carencia" });
  w.clock.set(end + DAY_MS);
  await w.reconcile();
  assert.equal(w.sub(subscriptionId).status, "past_due");
  assert.equal(await code(w.publishChanges({ auth: authFor("alice"), data: { siteId } })), "ok");
  // suspenso: o site saiu do ar, então não há o que publicar
  w.clock.set(end + (GRACE_DAYS + 1) * DAY_MS);
  await w.reconcile();
  assert.equal(await code(w.publishChanges({ auth: authFor("alice"), data: { siteId } })), "failed-precondition");
});

test("suspensão preserva o conteúdo; site suspenso é editável e o slug volta a acompanhar o nome; reativar republica", async () => {
  const w = world();
  const { siteId, subscriptionId, preId } = await liveSite(w);
  const end = w.sub(subscriptionId).currentPeriodEnd;
  w.clock.set(end + (GRACE_DAYS + 1) * DAY_MS);
  const retry = w.gw.charge(preId, "rejected");
  await w.hook("payment", retry.paymentId);
  assert.equal(w.sub(subscriptionId).status, "suspended");
  assert.equal(w.pub("maicon-do-corte"), undefined);
  assert.equal(w.siteDoc(siteId).name, "Maicon do Corte");
  assert.equal(w.siteDoc(siteId).published, false);

  const out = await edit(w, "alice", siteId, { name: "Novo Nome do Negocio" });
  assert.equal(out.slug, "novo-nome-do-negocio");
  w.gw.setPaymentStatus(retry.paymentId, "approved");
  await w.hook("payment", retry.paymentId);
  assert.equal(w.sub(subscriptionId).status, "active");
  assert.equal(w.pub("novo-nome-do-negocio").siteId, siteId);
  assert.equal(w.pub("maicon-do-corte"), undefined);
});

test("publicação sem assinatura válida é impossível: pendente, recusada ou de outro site não publica", async () => {
  const w = world();
  const a = await w.newSite("alice", "Site A");
  const b = await w.newSite("alice", "Site B");
  const sa = await w.subscribe("alice", a);
  await w.pay(sa.preId, "rejected");
  assert.equal(w.siteDoc(a).published, false);
  const sb = await w.subscribe("alice", b);
  await w.pay(sb.preId, "approved");
  assert.equal(w.siteDoc(b).published, true);
  assert.equal(w.siteDoc(a).published, false);
  assert.equal(await code(w.publishChanges({ auth: authFor("alice"), data: { siteId: a } })), "failed-precondition");
  // o navegador não consegue marcar nada: saveSite rejeita campos de estado
  for (const field of ["published", "paymentStatus", "subscriptionStatus", "publishedSlug", "ownerUid"]) {
    assert.equal(await code(w.save({ auth: authFor("alice"), data: { siteId: a, site: { ...baseSite, name: "Site A", [field]: true } } })), "invalid-argument", field);
  }
  assert.equal(w.pub("site-a"), undefined);
});

test("slug: nome reservado, caracteres inválidos e duplicado são tratados no servidor", async () => {
  const w = world();
  assert.equal(await code(w.save({ auth: authFor("alice"), data: { site: { ...baseSite, name: "Admin" } } })), "invalid-argument");
  assert.equal(await code(w.save({ auth: authFor("alice"), data: { site: { ...baseSite, name: "!!!" } } })), "invalid-argument");
  const odd = await w.save({ auth: authFor("alice"), data: { site: { ...baseSite, name: "Ateliê da Ânia & Cia!" } } });
  assert.equal(odd.slug, "atelie-da-ania-cia");
  await liveSite(w, "alice", "Meu Endereço");
  const dup = await w.newSite("bob", "Meu Endereço");
  assert.equal(await code(w.create({ auth: authFor("bob"), data: { siteId: dup } })), "already-exists");
  assert.equal(w.pub("meu-endereco").siteId !== dup, true);
});

test("XSS: nome malicioso é guardado como texto puro e só chega à cópia pública como texto", async () => {
  const w = world();
  const evil = '<img src=x onerror="alert(1)">Loja';
  const siteId = await w.newSite("alice", evil);
  const s = await w.subscribe("alice", siteId);
  await w.pay(s.preId, "approved");
  const pub = [...w.db._store.entries()].find(([k]) => k.startsWith("publicSites/"))[1];
  assert.equal(pub.name, evil);
  assert.match(pub.slug, /^[a-z0-9-]+$/);
});
