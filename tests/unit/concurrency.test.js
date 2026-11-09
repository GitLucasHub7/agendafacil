const test = require("node:test");
const assert = require("node:assert/strict");
const { world, authFor, code, baseSite } = require("../helpers/world");

const subsOf = (w, siteId) => [...w.db._store.entries()].filter(([k, v]) => k.startsWith("subscriptions/") && v.siteId === siteId);

test("CORRIDA 1: duas chamadas simultâneas de createSubscription para o MESMO site => 1 única criação remota", async () => {
  const w = world();
  w.gw.delayMs = 30;
  const siteId = await w.newSite("alice", "Maicon do Corte");
  const call = () => w.create({ auth: authFor("alice"), data: { siteId } }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code }));
  const results = await Promise.all([call(), call(), call(), call()]);
  assert.equal(w.gw.count("createPreapproval"), 1, "somente um preapproval pode ser criado no gateway");
  assert.equal(subsOf(w, siteId).filter(([, v]) => v.status !== "cancelled").length, 1, "somente uma assinatura viva no Firestore");
  const withLink = results.filter((x) => x.ok && x.r.initPoint);
  const processing = results.filter((x) => x.ok && x.r.processing);
  assert.equal(withLink.length >= 1, true, "quem criou recebe o link");
  assert.equal(withLink.length + processing.length, 4, "as demais recebem o mesmo fluxo ou 'em processamento', nunca outra criação");
  const ids = new Set(results.filter((x) => x.ok).map((x) => x.r.subscriptionId));
  assert.equal(ids.size, 1, "todas apontam para a MESMA assinatura");
});

test("CORRIDA 2: dois sites com o MESMO slug assinando ao mesmo tempo => só um abre checkout; o outro recebe erro claro, sem cobrança", async () => {
  const w = world();
  w.gw.delayMs = 30;
  const a = await w.newSite("alice", "Meu Endereco");
  const b = await w.newSite("bob", "Meu Endereco"); // mesmo slug
  const [ra, rb] = await Promise.all([
    w.create({ auth: authFor("alice"), data: { siteId: a } }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, message: e.message })),
    w.create({ auth: authFor("bob"), data: { siteId: b } }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, message: e.message })),
  ]);
  const winners = [ra, rb].filter((x) => x.ok);
  const losers = [ra, rb].filter((x) => !x.ok);
  assert.equal(winners.length, 1, "exatamente um vence");
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, "already-exists");
  assert.match(losers[0].message, /endereço/i);
  assert.equal(w.gw.count("createPreapproval"), 1, "o perdedor NUNCA chega ao Mercado Pago");
});
