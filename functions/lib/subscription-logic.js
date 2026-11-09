// Lógica PURA do ciclo de vida da assinatura (sem I/O): dado o estado local e o estado ATUAL do gateway,
// decide o novo estado interno, os registros de cobrança e a ação de publicação.
// Nunca usa o conteúdo bruto de uma notificação: só dados que o chamador buscou no gateway.
const { PLAN, GRACE_DAYS, DAY_MS, STATUS, addMonths } = require("./plan");

// Mapeamento Mercado Pago (pagamento da cobrança) -> estado interno da cobrança.
// Documentado em docs/ASSINATURAS.md. Desconhecido => "pending" (não ativa nem revoga nada).
function mapPaymentStatus(paymentStatus, invoiceStatus) {
  const p = String(paymentStatus || "").toLowerCase();
  if (p === "approved") return { status: "approved" };
  if (p === "in_mediation") return { status: "approved", disputed: true }; // contestação aberta: ainda não revoga
  if (p === "refunded") return { status: "refunded" };
  if (p === "charged_back") return { status: "charged_back" };
  if (p === "rejected" || p === "cancelled") return { status: "rejected" };
  if (p === "pending" || p === "in_process" || p === "authorized") return { status: "pending" };
  const i = String(invoiceStatus || "").toLowerCase();
  if (i === "recycling" || i === "cancelled") return { status: "rejected" }; // tentativa falhou, nova tentativa agendada
  return { status: "pending" };
}

// Transições permitidas da cobrança (impede que uma notificação antiga "desfaça" um estado mais novo).
const ALLOWED = {
  pending: ["pending", "approved", "rejected"],
  rejected: ["rejected", "approved", "pending"],
  approved: ["approved", "refunded", "charged_back"],
  refunded: ["refunded"],
  charged_back: ["charged_back"],
};

function hasCredit(inv) {
  return inv.status === "approved" && inv.credited === true && typeof inv.periodEnd === "number";
}

function entitled(status, paidThrough, graceUntil, now) {
  if (status === STATUS.ACTIVE) return true;
  if (status === STATUS.PAST_DUE) return typeof graceUntil === "number" && now <= graceUntil;
  if (status === STATUS.CANCELLED) return typeof paidThrough === "number" && now < paidThrough;
  return false;
}

/**
 * @param {object} p
 * @param {number} p.now
 * @param {object} p.sub         registro local da assinatura (com id)
 * @param {object|null} p.site   documento do site (com id) ou null
 * @param {{ok:boolean, slug?:string, clean?:object}} p.siteCheck  validação dos campos do site
 * @param {object[]} p.invoices  cobranças locais desta assinatura
 * @param {{preapproval?:object, invoices?:object[]}|null} p.gateway  estado ATUAL buscado no gateway
 * @param {{exists:boolean, siteId?:string}} p.publicTarget  publicSites/{slug do site}
 * @param {Array<{slug:string, siteId?:string}>} p.stalePublic  outros slugs públicos antigos deste site
 */
function reduce({ now, sub, site, siteCheck, invoices, gateway, publicTarget, stalePublic, forceRepublish, claimTarget }) {
  const pre = (gateway && gateway.preapproval) || null;
  if (pre && (pre.id !== sub.mpPreapprovalId || pre.externalReference !== sub.id)) {
    return { error: "identity_mismatch" };
  }

  const anomalies = new Set(sub.anomalies || []);
  const mpStatus = pre ? String(pre.status || "").toLowerCase() : sub.mpStatus || "pending";

  let planOk = !anomalies.has("plan_mismatch");
  if (pre) {
    planOk = pre.amountCents === PLAN.priceCents && pre.currency === PLAN.currency && pre.frequency === PLAN.frequency && pre.frequencyType === PLAN.frequencyType;
    if (!planOk) anomalies.add("plan_mismatch");
  }

  // 1) Cobranças
  const byId = new Map((invoices || []).map((i) => [i.id, { ...i }]));
  const touched = new Map();
  let revoked = null; // "refunded" | "charged_back" quando uma cobrança creditada foi revogada AGORA
  let disputed = false;

  for (const g of (gateway && gateway.invoices) || []) {
    if (g.preapprovalId !== sub.mpPreapprovalId) {
      anomalies.add("foreign_invoice");
      continue;
    }
    const id = `inv_${g.id}`;
    const prev = byId.get(id);
    const mapped = mapPaymentStatus(g.paymentStatus, g.status);
    const rec = prev || { id, subId: sub.id, siteId: sub.siteId, ownerUid: sub.ownerUid, mpInvoiceId: String(g.id), status: "pending", credited: false, createdAtMs: now };

    let next = mapped.status;
    if (prev && !ALLOWED[prev.status].includes(next)) {
      anomalies.add("regression_ignored");
      next = prev.status;
    }
    const amountOk = g.amountCents === PLAN.priceCents && (!g.currency || g.currency === PLAN.currency);

    rec.mpPaymentId = g.paymentId ? String(g.paymentId) : rec.mpPaymentId || null;
    rec.mpPaymentStatus = g.paymentStatus || null;
    rec.mpInvoiceStatus = g.status || null;
    rec.amountCents = g.amountCents;
    rec.debitDateMs = g.debitDateMs || null;
    rec.retryAttempt = g.retryAttempt || 0;
    rec.disputed = Boolean(mapped.disputed);
    if (rec.disputed) disputed = true;

    if (next === "approved" && typeof rec.periodEnd !== "number" && rec.credited !== true) {
      if (amountOk && planOk) {
        let base = 0;
        for (const other of byId.values()) if (other.id !== id && hasCredit(other)) base = Math.max(base, other.periodEnd);
        for (const other of touched.values()) if (other.id !== id && hasCredit(other)) base = Math.max(base, other.periodEnd);
        const start = Math.max(base, now); // pagamento atrasado só cobre a partir de agora; antecipado é contíguo
        rec.periodStart = start;
        rec.periodEnd = addMonths(start, 1);
        rec.credited = true;
        rec.approvedAtMs = now;
      } else {
        anomalies.add(amountOk ? "plan_mismatch" : "invoice_amount_mismatch");
        rec.credited = false;
      }
    }
    if (prev && prev.status === "approved" && (next === "refunded" || next === "charged_back")) {
      revoked = next === "charged_back" || revoked === "charged_back" ? "charged_back" : "refunded";
      rec.credited = false;
      rec.revokedAtMs = now;
    }
    rec.status = next;
    rec.updatedAtMs = now;
    byId.set(id, rec);
    touched.set(id, rec);
  }
  const allInvoices = [...byId.values()];
  disputed = allInvoices.some((i) => i.disputed === true && i.status === "approved");

  // 2) Período pago (cobranças aprovadas, creditadas e não revogadas)
  let paidThrough = null;
  for (const inv of allInvoices) if (hasCredit(inv)) paidThrough = Math.max(paidThrough || 0, inv.periodEnd);
  const everPaid = allInvoices.some((i) => i.credited === true || i.revokedAtMs);
  const newest = [...allInvoices].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))[0];
  const lastPaymentFailed = Boolean(newest && newest.status === "rejected");

  // 3) Estado interno
  let status = sub.status;
  let reason = sub.statusReason || null;
  let graceUntil = null;
  const cancelled = mpStatus === "cancelled" || sub.requestedCancel === true;
  const sideEffects = [];

  if (cancelled) {
    if (paidThrough && paidThrough > now) {
      status = STATUS.CANCELLED;
      reason = sub.requestedCancel ? "user" : sub.cancelReason || "gateway";
    } else if (sub.requestedCancel) {
      status = STATUS.CANCELLED;
      reason = sub.cancelReason || "user";
    } else if (everPaid || sub.status === STATUS.PAST_DUE || sub.status === STATUS.SUSPENDED) {
      status = STATUS.SUSPENDED; // o gateway esgotou as tentativas de cobrança
      reason = revoked ? (revoked === "charged_back" ? "chargeback" : "refund") : sub.statusReason === "chargeback" || sub.statusReason === "refund" ? sub.statusReason : "payment_failed";
    } else {
      status = STATUS.CANCELLED;
      reason = lastPaymentFailed ? "payment_failed" : sub.cancelReason || "gateway";
    }
  } else if (revoked && !(paidThrough && paidThrough > now)) {
    status = STATUS.SUSPENDED; // estorno/contestação: sem carência
    reason = revoked === "charged_back" ? "chargeback" : "refund";
    if (revoked === "charged_back") sideEffects.push("cancel_preapproval"); // para de cobrar uma assinatura contestada
  } else if (paidThrough && paidThrough > now) {
    status = STATUS.ACTIVE;
    reason = null;
  } else if (!paidThrough && !everPaid) {
    status = sub.status === STATUS.CANCELLED || sub.status === STATUS.SUSPENDED ? sub.status : STATUS.PENDING;
  } else if (sub.status === STATUS.SUSPENDED && (sub.statusReason === "refund" || sub.statusReason === "chargeback")) {
    status = STATUS.SUSPENDED; // nunca "rebaixa" uma suspensão por estorno para carência
  } else {
    graceUntil = (paidThrough || sub.currentPeriodEnd || now) + GRACE_DAYS * DAY_MS;
    if (now <= graceUntil) {
      status = STATUS.PAST_DUE;
      reason = "payment_overdue";
    } else {
      status = STATUS.SUSPENDED;
      reason = "grace_expired";
    }
  }
  if (status === STATUS.PAST_DUE && graceUntil === null) graceUntil = sub.graceUntil || null;

  const accessUntil = status === STATUS.PAST_DUE ? graceUntil : paidThrough;
  const isEntitled = entitled(status, paidThrough, graceUntil, now);

  // 4) Publicação: só a assinatura ATUAL do site, e só se o dono bate.
  const out = { error: null, entitled: isEntitled, sub: {}, invoices: [...touched.values()], publish: { action: "noop" }, siteMirror: null, sideEffects, anomalies: [] };
  const isCurrent = Boolean(site && site.subscriptionId === sub.id && site.ownerUid === sub.ownerUid);
  if (site && site.ownerUid !== sub.ownerUid) anomalies.add("owner_mismatch");

  if (isCurrent) {
    if (isEntitled) {
      if (!siteCheck || !siteCheck.ok) {
        anomalies.add("site_invalid");
      } else if ((publicTarget && publicTarget.exists && publicTarget.siteId !== site.id) || (claimTarget && claimTarget.exists && claimTarget.live && claimTarget.siteId !== site.id)) {
        anomalies.add("slug_conflict"); // outro site detém o endereço (publicado ou reservado): nunca publicamos por cima
      } else {
        const claimMissing = claimTarget ? !(claimTarget.exists && claimTarget.siteId === site.id && claimTarget.state === "published") : false;
        const needs = forceRepublish === true || claimMissing || !site.published || !publicTarget.exists || site.publishedSlug !== siteCheck.slug || (stalePublic && stalePublic.length > 0);
        if (needs) out.publish = { action: "publish", slug: siteCheck.slug, clean: siteCheck.clean };
      }
    } else if (site.published || (publicTarget && publicTarget.exists && publicTarget.siteId === site.id) || (stalePublic && stalePublic.length)) {
      out.publish = { action: "unpublish" };
    }
    const finalPublished = out.publish.action === "publish" ? true : out.publish.action === "unpublish" ? false : Boolean(site.published);
    out.siteMirror = {
      subscriptionId: sub.id,
      subscriptionStatus: status,
      accessUntil: accessUntil || null,
      published: finalPublished,
      publishState: finalPublished ? "published" : status === STATUS.PENDING ? "none" : status,
    };
  }

  out.sub = {
    status,
    statusReason: reason,
    mpStatus,
    currentPeriodEnd: paidThrough,
    graceUntil: status === STATUS.PAST_DUE || (status === STATUS.SUSPENDED && reason === "grace_expired") ? graceUntil : null,
    accessUntil: accessUntil || null,
    disputed,
    nextPaymentDate: pre ? pre.nextPaymentDate || null : sub.nextPaymentDate || null,
    mpLastModified: pre ? pre.lastModified || null : sub.mpLastModified || null,
    anomalies: [...anomalies],
    settled: mpStatus === "cancelled" && !isEntitled && (status === STATUS.CANCELLED || status === STATUS.SUSPENDED) && !(out.siteMirror && out.siteMirror.published),
    cancelledAt: status === STATUS.CANCELLED ? sub.cancelledAt || now : sub.cancelledAt || null,
    cancelReason: status === STATUS.CANCELLED ? reason : sub.cancelReason || null,
  };
  out.anomalies = [...anomalies];
  return out;
}

module.exports = { reduce, mapPaymentStatus, entitled, ALLOWED };
