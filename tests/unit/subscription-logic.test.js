const test = require("node:test");
const assert = require("node:assert/strict");
const { reduce } = require("../../functions/lib/subscription-logic");
const { PLAN, GRACE_DAYS, DAY_MS, addMonths } = require("../../functions/lib/plan");

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const sub0 = (over = {}) => ({ id: "SUB1", ownerUid: "alice", siteId: "SITE1", mpPreapprovalId: "PRE1", status: "pending", mpStatus: "pending", ...over });
const site0 = (over = {}) => ({ id: "SITE1", ownerUid: "alice", subscriptionId: "SUB1", published: false, ...over });
const check = { ok: true, slug: "meu-site", clean: { name: "Meu Site" } };
const pre = (over = {}) => ({ id: "PRE1", externalReference: "SUB1", status: "authorized", amountCents: PLAN.priceCents, currency: "BRL", frequency: 1, frequencyType: "months", ...over });
const inv = (id, paymentStatus, over = {}) => ({ id, preapprovalId: "PRE1", paymentId: "P" + id, paymentStatus, status: "processed", amountCents: PLAN.priceCents, currency: "BRL", ...over });

function run(state, input, now = T0) {
  return reduce({ now, sub: state.sub, site: state.site === undefined ? site0() : state.site, siteCheck: check, invoices: state.invoices || [], gateway: input, publicTarget: state.publicTarget || { exists: false }, stalePublic: [] });
}
// aplica o resultado de volta ao "estado local" para encadear etapas
function apply(state, out) {
  const invs = new Map((state.invoices || []).map((i) => [i.id, i]));
  for (const i of out.invoices) invs.set(i.id, i);
  const sub = { ...state.sub, ...out.sub, mpStatus: out.sub.mpStatus };
  const site = out.siteMirror ? { ...(state.site || site0()), ...out.siteMirror, publishedSlug: out.publish.action === "publish" ? out.publish.slug : (state.site || site0()).publishedSlug } : state.site;
  return { sub, site, invoices: [...invs.values()], publicTarget: { exists: out.publish.action === "publish" ? true : out.publish.action === "unpublish" ? false : (state.publicTarget || {}).exists, siteId: "SITE1" } };
}

test("assinatura apenas AUTORIZADA (sem pagamento aprovado) não ativa nem publica", () => {
  const out = run({ sub: sub0() }, { preapproval: pre({ status: "authorized" }), invoices: [] });
  assert.equal(out.sub.status, "pending");
  assert.equal(out.publish.action, "noop");
  assert.equal(out.siteMirror.published, false);
});

test("pagamento PENDENTE ou RECUSADO na primeira cobrança não ativa", () => {
  for (const ps of ["pending", "in_process", "rejected", "cancelled"]) {
    const out = run({ sub: sub0() }, { preapproval: pre(), invoices: [inv("1", ps)] });
    assert.equal(out.sub.status, "pending", ps);
    assert.equal(out.publish.action, "noop", ps);
    assert.equal(out.sub.currentPeriodEnd, null, ps);
  }
});

test("pagamento APROVADO ativa, define 1 mês de período e publica", () => {
  const out = run({ sub: sub0() }, { preapproval: pre(), invoices: [inv("1", "approved")] });
  assert.equal(out.sub.status, "active");
  assert.equal(out.sub.currentPeriodEnd, addMonths(T0, 1));
  assert.deepEqual(out.publish, { action: "publish", slug: "meu-site", clean: { name: "Meu Site" } });
  assert.equal(out.siteMirror.published, true);
  assert.equal(out.invoices[0].credited, true);
});

test("NOTIFICAÇÃO DUPLICADA é idempotente: não estende o período nem republica", () => {
  let st = { sub: sub0() };
  const g = { preapproval: pre(), invoices: [inv("1", "approved")] };
  st = apply(st, run(st, g));
  const end1 = st.sub.currentPeriodEnd;
  for (let i = 0; i < 3; i++) {
    const out = run(st, g, T0 + 5 * 1000 + i);
    assert.equal(out.sub.currentPeriodEnd, end1);
    assert.equal(out.publish.action, "noop");
    st = apply(st, out);
  }
  assert.equal(st.invoices.length, 1);
});

test("FORA DE ORDEM: evento antigo 'pending' depois de 'approved' não regride o estado", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const out = run(st, { preapproval: pre(), invoices: [inv("1", "pending")] }, T0 + 1000);
  assert.equal(out.sub.status, "active");
  assert.equal(out.invoices[0].status, "approved");
  assert.ok(out.sub.anomalies.includes("regression_ignored"));
});

test("renovação: segunda cobrança aprovada é contígua (período + 1 mês), sem duplicar", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const end1 = st.sub.currentPeriodEnd;
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("2", "approved")] }, end1 - DAY_MS));
  assert.equal(st.sub.currentPeriodEnd, addMonths(end1, 1));
  assert.equal(st.sub.status, "active");
});

test("falha na renovação: período vencido => past_due (site continua no ar na carência)", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const end1 = st.sub.currentPeriodEnd;
  const out = run(st, { preapproval: pre(), invoices: [inv("2", "rejected")] }, end1 + DAY_MS);
  assert.equal(out.sub.status, "past_due");
  assert.equal(out.sub.graceUntil, end1 + GRACE_DAYS * DAY_MS);
  assert.equal(out.publish.action, "noop", "continua publicado durante a carência");
});

test("UMA recusa isolada com período ainda vigente NÃO despublica nem altera o estado", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const out = run(st, { preapproval: pre(), invoices: [inv("2", "rejected")] }, T0 + 2 * DAY_MS);
  assert.equal(out.sub.status, "active");
  assert.equal(out.publish.action, "noop");
});

test("fim da carência => suspended e despublica; dados preservados (site não é apagado)", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const end1 = st.sub.currentPeriodEnd;
  const out = run(st, { preapproval: pre(), invoices: [inv("2", "rejected")] }, end1 + (GRACE_DAYS + 1) * DAY_MS);
  assert.equal(out.sub.status, "suspended");
  assert.equal(out.sub.statusReason, "grace_expired");
  assert.equal(out.publish.action, "unpublish");
  assert.equal(out.siteMirror.published, false);
  assert.equal(out.siteMirror.publishState, "suspended");
});

test("RECUPERAÇÃO: pagamento aprovado após a suspensão reativa e republica", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const end1 = st.sub.currentPeriodEnd;
  const late = end1 + (GRACE_DAYS + 3) * DAY_MS;
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("2", "rejected")] }, late));
  assert.equal(st.sub.status, "suspended");
  const out = run(st, { preapproval: pre(), invoices: [inv("2", "approved")] }, late + DAY_MS);
  assert.equal(out.sub.status, "active");
  assert.equal(out.publish.action, "publish");
  assert.equal(out.sub.currentPeriodEnd, addMonths(late + DAY_MS, 1), "período novo começa no pagamento, sem creditar o intervalo sem acesso");
});

test("gateway cancelou após 3 recusas (cobrança paga antes) => suspended por falha de pagamento", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const out = run(st, { preapproval: pre({ status: "cancelled" }), invoices: [inv("2", "rejected")] }, st.sub.currentPeriodEnd + DAY_MS);
  assert.equal(out.sub.status, "suspended");
  assert.equal(out.sub.statusReason, "payment_failed");
  assert.equal(out.publish.action, "unpublish");
});

test("cancelamento pelo usuário: acesso até o fim do período pago, depois despublica", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const end1 = st.sub.currentPeriodEnd;
  st.sub = { ...st.sub, requestedCancel: true };
  const mid = run(st, { preapproval: pre({ status: "cancelled" }) }, T0 + 5 * DAY_MS);
  assert.equal(mid.sub.status, "cancelled");
  assert.equal(mid.sub.accessUntil, end1);
  assert.equal(mid.publish.action, "noop", "ainda no ar dentro do período pago");
  st = apply(st, mid);
  const after = run(st, null, end1 + 1000);
  assert.equal(after.sub.status, "cancelled");
  assert.equal(after.publish.action, "unpublish");
});

test("cancelar uma assinatura que nunca foi paga: cancelled sem acesso", () => {
  const out = run({ sub: sub0({ requestedCancel: true }) }, { preapproval: pre({ status: "cancelled" }), invoices: [] });
  assert.equal(out.sub.status, "cancelled");
  assert.equal(out.publish.action, "noop");
});

test("ESTORNO do único pagamento: suspende imediatamente (sem carência) e despublica", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const out = run(st, { preapproval: pre(), invoices: [inv("1", "refunded")] }, T0 + DAY_MS);
  assert.equal(out.sub.status, "suspended");
  assert.equal(out.sub.statusReason, "refund");
  assert.equal(out.sub.currentPeriodEnd, null);
  assert.equal(out.publish.action, "unpublish");
});

test("CONTESTAÇÃO: aberta (in_mediation) só sinaliza; chargeback suspende e manda cancelar a cobrança", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  const open = run(st, { preapproval: pre(), invoices: [inv("1", "in_mediation")] }, T0 + DAY_MS);
  assert.equal(open.sub.status, "active");
  assert.equal(open.sub.disputed, true);
  assert.equal(open.publish.action, "noop");
  st = apply(st, open);
  const lost = run(st, { preapproval: pre(), invoices: [inv("1", "charged_back")] }, T0 + 2 * DAY_MS);
  assert.equal(lost.sub.status, "suspended");
  assert.equal(lost.sub.statusReason, "chargeback");
  assert.deepEqual(lost.sideEffects, ["cancel_preapproval"]);
  assert.equal(lost.publish.action, "unpublish");
});

test("estorno de uma cobrança antiga não derruba o período vigente de outra", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("2", "approved")] }, st.sub.currentPeriodEnd - DAY_MS));
  const out = run(st, { preapproval: pre(), invoices: [inv("1", "refunded")] }, T0 + 2 * DAY_MS);
  assert.equal(out.sub.status, "active");
  assert.equal(out.publish.action, "noop");
});

test("PREÇO ADULTERADO no gateway: não ativa, não credita período, registra anomalia", () => {
  const bad = run({ sub: sub0() }, { preapproval: pre({ amountCents: 100 }), invoices: [inv("1", "approved", { amountCents: 100 })] });
  assert.equal(bad.sub.status, "pending");
  assert.equal(bad.publish.action, "noop");
  assert.ok(bad.sub.anomalies.includes("plan_mismatch"));
  const badInv = run({ sub: sub0() }, { preapproval: pre(), invoices: [inv("1", "approved", { amountCents: 100 })] });
  assert.equal(badInv.sub.status, "pending");
  assert.ok(badInv.sub.anomalies.includes("invoice_amount_mismatch"));
});

test("IDENTIDADE: preapproval de outra assinatura/usuário é rejeitado", () => {
  assert.equal(run({ sub: sub0() }, { preapproval: pre({ externalReference: "OUTRA" }) }).error, "identity_mismatch");
  assert.equal(run({ sub: sub0() }, { preapproval: pre({ id: "PRE_X" }) }).error, "identity_mismatch");
  const foreign = run({ sub: sub0() }, { preapproval: pre(), invoices: [inv("9", "approved", { preapprovalId: "OUTRA_ASSINATURA" })] });
  assert.equal(foreign.sub.status, "pending");
  assert.ok(foreign.sub.anomalies.includes("foreign_invoice"));
});

test("ISOLAMENTO: assinatura que não é a ATUAL do site, ou de outro dono, não publica nem despublica", () => {
  const paid = { preapproval: pre(), invoices: [inv("1", "approved")] };
  assert.equal(run({ sub: sub0(), site: site0({ subscriptionId: "OUTRA_SUB" }) }, paid).publish.action, "noop");
  assert.equal(run({ sub: sub0(), site: site0({ ownerUid: "bob" }) }, paid).publish.action, "noop");
  const stale = run({ sub: sub0({ status: "cancelled", requestedCancel: true }), site: site0({ subscriptionId: "SUB_NOVA", published: true }) }, { preapproval: pre({ status: "cancelled" }) });
  assert.equal(stale.publish.action, "noop", "sub antiga cancelada não derruba o site da sub nova");
  assert.equal(stale.siteMirror, null);
});

test("slug em conflito ou site inválido: não publica, registra anomalia", () => {
  const paid = { preapproval: pre(), invoices: [inv("1", "approved")] };
  const conflict = run({ sub: sub0(), publicTarget: { exists: true, siteId: "OUTRO_SITE" } }, paid);
  assert.equal(conflict.publish.action, "noop");
  assert.ok(conflict.sub.anomalies.includes("slug_conflict"));
  const out = reduce({ now: T0, sub: sub0(), site: site0(), siteCheck: { ok: false }, invoices: [], gateway: paid, publicTarget: { exists: false }, stalePublic: [] });
  assert.equal(out.publish.action, "noop");
  assert.ok(out.sub.anomalies.includes("site_invalid"));
});

test("reconciliação sem gateway (tick) aplica só regras de tempo", () => {
  let st = { sub: sub0() };
  st = apply(st, run(st, { preapproval: pre(), invoices: [inv("1", "approved")] }));
  assert.equal(run(st, null, T0 + 10 * DAY_MS).sub.status, "active");
  const end1 = st.sub.currentPeriodEnd;
  assert.equal(run(st, null, end1 + DAY_MS).sub.status, "past_due");
  assert.equal(run(st, null, end1 + (GRACE_DAYS + 1) * DAY_MS).sub.status, "suspended");
});
