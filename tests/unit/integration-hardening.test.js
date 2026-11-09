const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { world, authFor, code } = require("../helpers/world");
const { CREATION_LOCK_MS, DAY_MS } = require("../../functions/lib/plan");
const { createSubscriptionProvider, normalizePreapproval } = require("../../functions/payments/subscriptionProvider");
const { checkAssets } = require("../../scripts/check-assets");

test("timeout DEPOIS de criar no gateway: recupera a mesma assinatura, sem duplicar", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Timeout Seguro");
  const original = w.gw.provider.createPreapproval;
  w.gw.provider.createPreapproval = async (params) => {
    await original(params);
    throw Object.assign(new Error("timeout após criação"), { code: "ETIMEDOUT" });
  };
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  const subId = w.siteDoc(siteId).subscriptionId;
  assert.equal(await code(w.cancel({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  w.clock.advance(CREATION_LOCK_MS + 1);
  const result = await w.create({ auth: authFor("alice"), data: { siteId } });
  assert.equal(result.subscriptionId, subId);
  assert.equal(result.reused, true);
  assert.equal(w.gw.count("createPreapproval"), 1);
});

test("reconciliação não libera criação incerta nem assinatura cujo cancelamento falhou", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Reserva Segura");
  w.gw.failNext = "createPreapproval";
  await code(w.create({ auth: authFor("alice"), data: { siteId } }));
  w.clock.advance(40 * DAY_MS);
  await w.reconcile();
  assert.equal(w.sub(w.siteDoc(siteId).subscriptionId).creationState, "creating");
  const other = await w.newSite("bob", "Cancelamento Seguro");
  const s = await w.subscribe("bob", other);
  w.clock.advance(40 * DAY_MS);
  w.gw.failNext = "cancelPreapproval";
  const result = await w.reconcile();
  assert.equal(result.errors, 1);
  assert.equal(w.sub(s.subscriptionId).requestedCancel, false);
});

test("webhook payment: estorno atual prevalece sobre índice de cobranças atrasado", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Estorno Seguro");
  const s = await w.subscribe("alice", siteId);
  const charge = await w.pay(s.preId);
  const stale = await w.gw.provider.searchInvoices({ preapprovalId: s.preId });
  w.gw.setPaymentStatus(charge.paymentId, "refunded");
  w.gw.provider.searchInvoices = async () => stale;
  assert.equal((await w.hook("payment", charge.paymentId)).code, 200);
  assert.equal(w.invoices(s.subscriptionId)[0].status, "refunded");
  assert.equal(w.siteDoc(siteId).published, false);
  assert.equal(w.pub("estorno-seguro"), undefined);
});

test("webhook de cobrança: consulta direta atual prevalece sobre busca atrasada", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Consulta Atual");
  const s = await w.subscribe("alice", siteId);
  const charge = await w.pay(s.preId);
  const stale = await w.gw.provider.searchInvoices({ preapprovalId: s.preId });
  w.gw.setPaymentStatus(charge.paymentId, "charged_back");
  w.gw.provider.searchInvoices = async () => stale;
  assert.equal((await w.hook("subscription_authorized_payment", charge.invoiceId)).code, 200);
  assert.equal(w.invoices(s.subscriptionId)[0].status, "charged_back");
  assert.equal(w.siteDoc(siteId).published, false);
});

function sdkFor(search) {
  return { MercadoPagoConfig: class {}, PreApproval: class { search(p) { return search(p); } }, Invoice: class { search(p) { return search(p); } }, Payment: class {} };
}
test("novo checkout exige cancelar o anterior vencido; falha mantém uma única assinatura", async () => {
  const w = world();
  const siteId = await w.newSite("alice", "Checkout Seguro");
  const first = await w.subscribe("alice", siteId);
  w.clock.advance(40 * DAY_MS);
  w.gw.failNext = "cancelPreapproval";
  assert.equal(await code(w.create({ auth: authFor("alice"), data: { siteId } })), "unavailable");
  assert.equal(w.gw.count("createPreapproval"), 1);
  const next = await w.subscribe("alice", siteId);
  assert.notEqual(next.subscriptionId, first.subscriptionId);
  assert.equal(w.gw.pre.get(first.preId).status, "cancelled");
});
test("recuperação percorre a segunda página e aceita as duas grafias de cancelamento", async () => {
  const offsets = [];
  const p = createSubscriptionProvider("FAKE", sdkFor(async ({ options }) => {
    offsets.push(options.offset);
    return { paging: { total: 51 }, results: options.offset === 0 ? Array.from({ length: 50 }, (_, i) => ({ id: i, external_reference: "outro", status: "pending" })) : [{ id: "alvo", external_reference: "ref", status: "pending" }] };
  }));
  assert.equal((await p.findPreapprovalByExternalReference({ externalReference: "ref", payerEmail: "a@example.test" })).id, "alvo");
  assert.deepEqual(offsets, [0, 50]);
  assert.equal(normalizePreapproval({ id: "x", status: "canceled" }).status, "cancelled");
});

test("busca incompleta ou sem parâmetros falha sem afirmar ausência de assinatura", async () => {
  const p = createSubscriptionProvider("FAKE", sdkFor(async () => ({ paging: { total: 80 }, results: [] })));
  await assert.rejects(p.findPreapprovalByExternalReference({ externalReference: "ref", payerEmail: "a@example.test" }), /Paginação incompleta/);
  await assert.rejects(p.findPreapprovalByExternalReference({ externalReference: "ref" }), /pagador/);
  const invalid = createSubscriptionProvider("FAKE", sdkFor(async () => ({})));
  await assert.rejects(invalid.searchInvoices({ preapprovalId: "x" }), /incompleta/);
});

test("paginação de cobranças inclui todos os registros, mesmo além de cinquenta", async () => {
  const p = createSubscriptionProvider("FAKE", sdkFor(async ({ options }) => ({ paging: { total: 51 }, results: Array.from({ length: options.offset === 0 ? 50 : 1 }, (_, i) => ({ id: options.offset + i, preapproval_id: "pre" })) })));
  assert.equal((await p.searchInvoices({ preapprovalId: "pre" })).length, 51);
});

test("pacote de Hosting completo; falta de app-mode.js e ordem incorreta bloqueiam publicação", (t) => {
  assert.deepEqual(checkAssets(path.join(__dirname, "../..")), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afassets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public/index.html"), '<script src="auth-shared.js"></script><script src="app-mode.js"></script>');
  const errors = checkAssets(root).join("\n");
  assert.match(errors, /recurso ausente.*app-mode/);
  assert.match(errors, /app-mode.js precisa carregar antes/);
});
