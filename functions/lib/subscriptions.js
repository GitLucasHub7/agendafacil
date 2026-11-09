// Orquestração das assinaturas: criação, cancelamento, sincronização, reconciliação e webhook.
// A lógica de decisão está em subscription-logic.js (pura). Aqui ficam transações, gateway e efeitos.
const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const { validateSiteInput, pickSiteFields, contentHash } = require("./validate");
const { reduce } = require("./subscription-logic");
const { PLAN, STATUS, DAY_MS, PENDING_ABANDON_DAYS, MANUAL_SYNC_COOLDOWN_MS, CREATION_LOCK_MS, CREATION_HARD_TTL_MS } = require("./plan");
const { isLive, blocks, reservedClaim, publishedClaim, heldClaim } = require("./slug-claims");
const { parseBaseUrl, buildBackUrl } = require("./base-url");
const { requireAuth, parseSiteId, loadOwnedSite, toHttpsError } = require("./sites");
const { verifySignature } = require("./webhook-signature");

const KNOWN_TOPICS = ["subscription_preapproval", "subscription_authorized_payment", "payment"];
const CHECKOUT_URL = /^https:\/\/([a-z0-9-]+\.)*mercadopago\.com(\.[a-z]{2})?\//i;

// Firestore rejeita `undefined`.
function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function siteCheckOf(siteData) {
  if (!siteData) return { ok: false };
  try {
    const v = validateSiteInput(pickSiteFields(siteData));
    // Site no ar mantém o endereço: renomear o negócio não muda a URL pública.
    const slug = siteData.published && siteData.slug ? siteData.slug : v.slug;
    return { ok: true, slug, clean: v.clean };
  } catch {
    return { ok: false };
  }
}

function makeEngine({ db, FieldValue, getProvider, now = () => Date.now() }) {
  /** Aplica (em transação) o estado ATUAL do gateway ao estado local e controla a publicação. */
  async function applyState(subId, gateway, options = {}) {
    const ts = now();
    const result = await db.runTransaction(async (tx) => {
      const subRef = db.collection("subscriptions").doc(subId);
      const subSnap = await tx.get(subRef);
      if (!subSnap.exists) return { error: "no_subscription" };
      const sub = { id: subId, ...subSnap.data() };

      const siteRef = db.collection("sites").doc(sub.siteId);
      const siteSnap = await tx.get(siteRef);
      const invSnap = await tx.get(db.collection("subscriptionInvoices").where("subId", "==", subId));
      const site = siteSnap.exists ? { id: sub.siteId, ...siteSnap.data() } : null;
      const siteCheck = siteCheckOf(site);

      let publicTarget = { exists: false };
      let claimTarget;
      const stalePublic = [];
      const publicDocs = new Map();
      const claimDocs = new Map();
      if (site) {
        const slugs = [...new Set([siteCheck.ok ? siteCheck.slug : null, site.publishedSlug || null].filter(Boolean))];
        for (const slug of slugs) {
          const snap = await tx.get(db.collection("publicSites").doc(slug));
          publicDocs.set(slug, snap);
          if (siteCheck.ok && slug === siteCheck.slug) publicTarget = { exists: snap.exists, siteId: snap.exists ? snap.data().siteId : undefined };
          else if (snap.exists && snap.data().siteId === site.id) stalePublic.push({ slug, siteId: site.id });
        }
        // Reservas de endereço: o alvo e as que este site já detém (antigas ou novas).
        const claimSlugs = [...new Set([siteCheck.ok ? siteCheck.slug : null, site.slugClaim || null, site.publishedSlug || null].filter(Boolean))];
        for (const slug of claimSlugs) claimDocs.set(slug, await tx.get(db.collection("slugClaims").doc(slug)));
        if (siteCheck.ok) {
          const c = claimDocs.get(siteCheck.slug);
          claimTarget = { exists: c.exists, siteId: c.exists ? c.data().siteId : undefined, state: c.exists ? c.data().state : undefined, live: c.exists ? isLive(c.data(), ts) : false };
        }
      }

      const out = reduce({ now: ts, sub, site, siteCheck, invoices: invSnap.docs.map((d) => ({ id: d.id, ...d.data() })), gateway, publicTarget, stalePublic, claimTarget, forceRepublish: options.forceRepublish === true });
      if (out.error) return { error: out.error };

      tx.update(subRef, clean({ ...out.sub, lastSyncAtMs: ts, updatedAt: FieldValue.serverTimestamp() }));
      for (const rec of out.invoices) tx.set(db.collection("subscriptionInvoices").doc(rec.id), clean({ ...rec, updatedAt: FieldValue.serverTimestamp() }));

      if (out.siteMirror) {
        const mirror = { ...out.siteMirror, accessUntil: out.siteMirror.accessUntil };
        const owned = (slug) => {
          const c = claimDocs.get(slug);
          return c && c.exists && c.data().siteId === site.id ? c.data() : null;
        };
        if (out.publish.action === "publish") {
          tx.set(db.collection("publicSites").doc(out.publish.slug), clean({ ...out.publish.clean, slug: out.publish.slug, siteId: site.id, publishedAt: ts }));
          for (const stale of stalePublic) tx.delete(db.collection("publicSites").doc(stale.slug));
          // O endereço passa a ser detido por ESTE site; reservas antigas dele em outros slugs são liberadas.
          tx.set(db.collection("slugClaims").doc(out.publish.slug), publishedClaim({ slug: out.publish.slug, siteId: site.id, ownerUid: sub.ownerUid, subscriptionId: sub.id, now: ts, prev: owned(out.publish.slug) }));
          for (const slug of claimDocs.keys()) if (slug !== out.publish.slug && owned(slug)) tx.delete(db.collection("slugClaims").doc(slug));
          mirror.slugClaim = out.publish.slug;
          mirror.slug = out.publish.slug; // trava o endereço (rascunhos criados no modo Spark nascem sem este campo)
          mirror.publishedSlug = out.publish.slug;
          mirror.publishedAt = ts;
          mirror.publishedHash = contentHash(out.publish.clean);
          mirror.contentHash = mirror.publishedHash;
        } else if (out.publish.action === "unpublish") {
          for (const [slug, snap] of publicDocs) if (snap.exists && snap.data().siteId === site.id) tx.delete(db.collection("publicSites").doc(slug));
          // Endereço retido para o dono poder voltar (SLUG_RETENTION_DAYS); ninguém mais o ocupa silenciosamente.
          for (const slug of claimDocs.keys()) {
            const c = owned(slug);
            if (c) tx.set(db.collection("slugClaims").doc(slug), heldClaim({ slug, siteId: site.id, ownerUid: c.ownerUid, subscriptionId: c.subscriptionId, now: ts, prev: c }));
          }
          mirror.publishedSlug = null;
          mirror.publishedHash = null;
        } else if (!out.entitled && !mirror.published && (out.sub.status === STATUS.CANCELLED || out.sub.status === STATUS.SUSPENDED)) {
          // Assinatura que nunca chegou a publicar e terminou: libera a reserva do checkout (não a retenção de quem já publicou).
          for (const slug of claimDocs.keys()) {
            const c = owned(slug);
            if (c && c.state === "reserved") {
              tx.delete(db.collection("slugClaims").doc(slug));
              if (site.slugClaim === slug) mirror.slugClaim = null;
            }
          }
        }
        tx.update(siteRef, clean(mirror));
      }
      return { status: out.sub.status, publish: out.publish.action, anomalies: out.anomalies, sideEffects: out.sideEffects, mpPreapprovalId: sub.mpPreapprovalId };
    });

    if (result.sideEffects && result.sideEffects.includes("cancel_preapproval") && result.mpPreapprovalId) {
      try {
        await getProvider().cancelPreapproval(result.mpPreapprovalId);
      } catch (err) {
        console.error("Não foi possível cancelar a assinatura contestada no gateway:", result.mpPreapprovalId, err && err.message);
      }
    }
    return result;
  }

  /** Busca o estado atual da assinatura (e de suas cobranças) no gateway e aplica. */
  async function syncFromGateway(subId) {
    const snap = await db.collection("subscriptions").doc(subId).get();
    if (!snap.exists) return { error: "no_subscription" };
    const sub = snap.data();
    if (!sub.mpPreapprovalId) return applyState(subId, null);
    const provider = getProvider();
    const preapproval = await provider.getPreapproval(sub.mpPreapprovalId);
    let invoices = [];
    try {
      invoices = await provider.searchInvoices({ preapprovalId: sub.mpPreapprovalId });
    } catch (err) {
      console.warn("Busca de cobranças falhou (segue só com a assinatura):", err && err.message);
    }
    return applyState(subId, { preapproval, invoices });
  }

  async function findSubscription({ externalReference, preapprovalId }) {
    if (externalReference) {
      const snap = await db.collection("subscriptions").doc(String(externalReference)).get();
      if (snap.exists) return { id: snap.id, ...snap.data() };
    }
    if (preapprovalId) {
      const q = await db.collection("subscriptions").where("mpPreapprovalId", "==", String(preapprovalId)).get();
      if (q.docs.length) return { id: q.docs[0].id, ...q.docs[0].data() };
    }
    return null;
  }

  return { applyState, syncFromGateway, findSubscription };
}

function publicView(sub, site) {
  return { subscriptionId: sub.id, status: sub.status, reason: sub.statusReason || null, accessUntil: sub.accessUntil || null, published: Boolean(site && site.published) };
}

/** Registra o incidente, tenta cancelar a assinatura remota e marca a local como falha. Nunca lança. */
async function compensateOrphan({ db, FieldValue, getProvider, now }, { sub, pre, reason, error }) {
  let remoteCancelled = false;
  try {
    await getProvider().cancelPreapproval(pre.id);
    remoteCancelled = true;
  } catch (err) {
    console.error("Compensação: não foi possível cancelar a assinatura remota (ação manual necessária):", pre.id, err && err.message);
  }
  try {
    await db.collection("incidents").doc().set({ type: "orphan_preapproval", reason, subscriptionId: sub.id, siteId: sub.siteId, ownerUid: sub.ownerUid, mpPreapprovalId: pre.id, remoteCancelled, error: error ? String(error.message || error).slice(0, 300) : null, createdAtMs: now() });
  } catch (err) {
    console.error("Compensação: falha ao registrar o incidente:", err && err.message);
  }
  if (remoteCancelled) {
    await failCreation({ db, FieldValue, now }, sub, { mpPreapprovalId: pre.id });
  } else {
    // Não libera uma segunda assinatura enquanto a primeira ainda pode cobrar.
    await db.collection("subscriptions").doc(sub.id).update({ mpPreapprovalId: pre.id, creationState: "needs_cancel", settled: false, updatedAt: FieldValue.serverTimestamp() });
  }
  return { result: remoteCancelled ? "orphan_cancelled" : "orphan_needs_manual_cancel", subId: sub.id };
}

/** Encerra uma criação que falhou e libera a reserva do endereço (se ainda for desta assinatura). */
async function failCreation({ db, FieldValue }, sub, extra = {}) {
  try {
    await db.runTransaction(async (tx) => {
      const subRef = db.collection("subscriptions").doc(sub.id);
      const siteRef = db.collection("sites").doc(sub.siteId);
      const subSnap = await tx.get(subRef);
      const siteSnap = await tx.get(siteRef);
      const slug = sub.slug || (siteSnap.exists ? siteSnap.data().slugClaim : null);
      const claimSnap = slug ? await tx.get(db.collection("slugClaims").doc(slug)) : null;
      if (subSnap.exists) tx.update(subRef, { ...extra, creationState: "failed", status: STATUS.CANCELLED, statusReason: "create_failed", requestedCancel: true, settled: true, updatedAt: FieldValue.serverTimestamp() });
      if (claimSnap && claimSnap.exists && claimSnap.data().subscriptionId === sub.id && claimSnap.data().state === "reserved") {
        tx.delete(db.collection("slugClaims").doc(slug));
        if (siteSnap.exists && siteSnap.data().slugClaim === slug) tx.update(siteRef, { slugClaim: null });
      }
    });
  } catch (err) {
    console.error("Não foi possível encerrar a criação falha:", sub.id, err && err.message);
  }
}

function makeCreateSubscription({ db, FieldValue, getProvider, getAppBaseUrl, now = () => Date.now() }) {
  const ctx = { db, FieldValue, getProvider, now };

  // Transação ÚNICA: trava de criação por site + reserva do endereço + registro da assinatura.
  // O Firestore reexecuta a transação se outra escrita concorrente mudar o que foi lido: por isso duas
  // chamadas simultâneas nunca abrem dois preapprovals nem dois sites reservam o mesmo slug.
  async function reserve(uid, siteId) {
    return db.runTransaction(async (tx) => {
      const ts = now();
      const siteRef = db.collection("sites").doc(siteId);
      const siteSnap = await tx.get(siteRef);
      if (!siteSnap.exists || siteSnap.data().ownerUid !== uid) return { type: "not-found" };
      const site = { id: siteId, ...siteSnap.data() };
      const check = siteCheckOf(site);
      if (!check.ok) return { type: "invalid-site" };
      const slug = check.slug;

      let existing = null;
      if (site.subscriptionId) {
        const s = await tx.get(db.collection("subscriptions").doc(site.subscriptionId));
        if (s.exists) existing = { id: s.id, ...s.data() };
      }
      const claimSnap = await tx.get(db.collection("slugClaims").doc(slug));
      const pubSnap = await tx.get(db.collection("publicSites").doc(slug));
      const oldClaimSnap = site.slugClaim && site.slugClaim !== slug ? await tx.get(db.collection("slugClaims").doc(site.slugClaim)) : null;

      if (existing) {
        if (existing.creationState === "needs_cancel") return { type: "processing", subscriptionId: existing.id };
        if (existing.status === STATUS.ACTIVE || existing.status === STATUS.PAST_DUE) return { type: "already" };
        const alive = existing.status === STATUS.PENDING && existing.requestedCancel !== true && existing.mpStatus !== "cancelled";
        if (alive && existing.creationState === "creating") {
          if (ts - (existing.creationStartedAtMs || 0) < CREATION_LOCK_MS) return { type: "processing", subscriptionId: existing.id };
          return { type: "recover", sub: existing };
        }
        if (alive && existing.creationState !== "failed" && existing.initPoint && ts - (existing.createdAtMs || 0) < PENDING_ABANDON_DAYS * DAY_MS) {
          // Checkout pendente reaproveitado: garante que a RESERVA acompanha o endereço atual (o dono pode ter renomeado o site).
          if ((pubSnap.exists && pubSnap.data().siteId !== siteId) || (claimSnap.exists && blocks(claimSnap.data(), siteId, ts))) return { type: "slug-taken" };
          const ownClaim = claimSnap.exists && claimSnap.data().siteId === siteId ? claimSnap.data() : null;
          if (!ownClaim || ownClaim.state === "reserved") {
            tx.set(db.collection("slugClaims").doc(slug), reservedClaim({ slug, siteId, ownerUid: uid, subscriptionId: existing.id, now: ts, prev: ownClaim }));
          }
          if (oldClaimSnap && oldClaimSnap.exists && oldClaimSnap.data().siteId === siteId && oldClaimSnap.data().state === "reserved") tx.delete(db.collection("slugClaims").doc(site.slugClaim));
          if (existing.slug !== slug) tx.update(db.collection("subscriptions").doc(existing.id), { slug, updatedAt: FieldValue.serverTimestamp() });
          if (site.slugClaim !== slug) tx.update(siteRef, { slugClaim: slug });
          return { type: "reuse", subscriptionId: existing.id, initPoint: existing.initPoint };
        }
        if (existing.mpPreapprovalId && existing.mpStatus !== "cancelled") return { type: "retire", sub: existing };
      }

      // Endereço: outro site publicado ou com reserva vigente => erro claro, ANTES de qualquer chamada ao gateway.
      if ((pubSnap.exists && pubSnap.data().siteId !== siteId) || (claimSnap.exists && blocks(claimSnap.data(), siteId, ts))) return { type: "slug-taken" };

      const subRef = db.collection("subscriptions").doc();
      tx.set(db.collection("slugClaims").doc(slug), reservedClaim({ slug, siteId, ownerUid: uid, subscriptionId: subRef.id, now: ts, prev: claimSnap.exists && claimSnap.data().siteId === siteId ? claimSnap.data() : null }));
      if (oldClaimSnap && oldClaimSnap.exists && oldClaimSnap.data().siteId === siteId && oldClaimSnap.data().state !== "published") tx.delete(db.collection("slugClaims").doc(site.slugClaim));
      tx.set(subRef, {
        ownerUid: uid,
        siteId,
        slug,
        status: STATUS.PENDING,
        statusReason: null,
        mpStatus: "pending",
        mpPreapprovalId: null,
        initPoint: null,
        creationState: "creating",
        creationStartedAtMs: ts,
        priceCents: PLAN.priceCents,
        currency: PLAN.currency,
        currentPeriodEnd: null,
        graceUntil: null,
        accessUntil: null,
        requestedCancel: false,
        anomalies: [],
        settled: false,
        createdAtMs: ts,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(siteRef, { subscriptionId: subRef.id, subscriptionStatus: STATUS.PENDING, slugClaim: slug, updatedAt: FieldValue.serverTimestamp() });
      return { type: "created", subscriptionId: subRef.id, slug };
    });
  }

  // Criação marcada como "em andamento" há tempo demais: descobre se o gateway chegou a criar algo.
  async function recover(sub, payerEmail) {
    const age = now() - (sub.creationStartedAtMs || 0);
    let remote;
    try {
      remote = await getProvider().findPreapprovalByExternalReference({ externalReference: sub.id, payerEmail });
    } catch (err) {
      console.warn("Recuperação: consulta ao gateway falhou:", sub.id, err && err.message);
      remote = undefined; // resultado desconhecido
    }
    if (remote) {
      await db.collection("subscriptions").doc(sub.id).update({ mpPreapprovalId: remote.id, initPoint: remote.initPoint, mpStatus: String(remote.status || "pending").toLowerCase(), creationState: "ready", updatedAt: FieldValue.serverTimestamp() });
      return { type: "reuse", subscriptionId: sub.id, initPoint: remote.initPoint };
    }
    if (remote === null) {
      await failCreation(ctx, sub);
      return { type: "retry" };
    }
    if (age > CREATION_HARD_TTL_MS) {
      await db.collection("incidents").doc(`creation_${sub.id}`).set({ type: "creation_unresolved", subscriptionId: sub.id, siteId: sub.siteId, ownerUid: sub.ownerUid, createdAtMs: now() });
    }
    return { type: "processing", subscriptionId: sub.id };
  }

  return async (request) => {
    const auth = requireAuth(request);
    if (auth.token?.email_verified !== true) throw new HttpsError("failed-precondition", "Confirme seu e-mail antes de assinar.");
    const payerEmail = auth.token?.email;
    if (typeof payerEmail !== "string" || !payerEmail.includes("@")) throw new HttpsError("failed-precondition", "Sua conta não tem um e-mail válido.");
    const base = parseBaseUrl(getAppBaseUrl());
    if (!base.ok) {
      console.error("APP_BASE_URL inválida:", base.error);
      throw new HttpsError("failed-precondition", "Configuração do servidor incompleta. Tente novamente mais tarde.");
    }

    // O cliente só informa QUAL site. Preço, moeda, periodicidade, referência e e-mail vêm do servidor.
    const siteId = parseSiteId((request.data || {}).siteId);
    const { data: site } = await loadOwnedSite(db, siteId, auth.uid);
    try {
      validateSiteInput(pickSiteFields(site));
    } catch (err) {
      throw toHttpsError(err);
    }

    let decision;
    for (let attempt = 0; attempt < 3; attempt++) {
      decision = await reserve(auth.uid, siteId);
      if (decision.type === "recover") decision = await recover(decision.sub, payerEmail);
      if (decision.type === "retire") {
        try {
          await getProvider().cancelPreapproval(decision.sub.mpPreapprovalId);
        } catch {
          throw new HttpsError("unavailable", "Não foi possível encerrar a assinatura anterior. Aguarde antes de tentar novamente.");
        }
        await failCreation(ctx, decision.sub, { mpStatus: "cancelled" });
        decision = { type: "retry" };
      }
      if (decision.type !== "retry") break;
    }
    if (decision.type === "not-found") throw new HttpsError("not-found", "Site não encontrado.");
    if (decision.type === "invalid-site") throw new HttpsError("invalid-argument", "Revise os dados do site antes de assinar.");
    if (decision.type === "already") throw new HttpsError("failed-precondition", "Esse site já tem uma assinatura vigente.");
    if (decision.type === "slug-taken") throw new HttpsError("already-exists", "Esse endereço já está em uso ou reservado por outro site. Escolha outro nome para o negócio.");
    if (decision.type === "processing") return { subscriptionId: decision.subscriptionId, status: STATUS.PENDING, processing: true };
    if (decision.type === "reuse") return { subscriptionId: decision.subscriptionId, initPoint: decision.initPoint, status: STATUS.PENDING, reused: true };
    if (decision.type !== "created") throw new HttpsError("unavailable", "Não foi possível iniciar a assinatura agora. Tente de novo em instantes.");

    // Chamada remota FORA da transação, mas já protegida pela trava persistida acima.
    const sub = { id: decision.subscriptionId, siteId, ownerUid: auth.uid, slug: decision.slug };
    let pre;
    try {
      pre = await getProvider().createPreapproval({
        reason: PLAN.reason,
        externalReference: sub.id,
        payerEmail,
        backUrl: buildBackUrl(base.origin),
        amountCents: PLAN.priceCents,
        currency: PLAN.currency,
        frequency: PLAN.frequency,
        frequencyType: PLAN.frequencyType,
      });
    } catch (err) {
      console.error("Falha ao criar assinatura no gateway:", err && err.message);
      // Timeout, 5xx e falha de transporte podem acontecer DEPOIS da criação remota.
      // Só uma rejeição explícita e definitiva permite encerrar a tentativa.
      const status = Number(err && (err.status || err.statusCode || err.response?.status));
      if ([400, 401, 403, 422].includes(status)) await failCreation(ctx, sub);
      throw new HttpsError("unavailable", "Não foi possível iniciar a assinatura agora. Tente de novo em instantes.");
    }
    if (!pre.initPoint || !CHECKOUT_URL.test(pre.initPoint)) {
      console.error("init_point inesperado devolvido pelo gateway:", pre.id);
      await compensateOrphan(ctx, { sub, pre, reason: "invalid_init_point" });
      throw new HttpsError("unavailable", "Não foi possível iniciar a assinatura agora. Tente de novo em instantes.");
    }
    try {
      await db.collection("subscriptions").doc(sub.id).update({ mpPreapprovalId: pre.id, initPoint: pre.initPoint, mpStatus: String(pre.status || "pending").toLowerCase(), creationState: "ready", updatedAt: FieldValue.serverTimestamp() });
    } catch (err) {
      // A assinatura remota existe mas não foi associada ao site: compensa para não cobrar algo que o sistema desconhece.
      console.error("Assinatura criada no gateway mas não gravada:", pre.id, err && err.message);
      await compensateOrphan(ctx, { sub, pre, reason: "persist_failed", error: err });
      throw new HttpsError("unavailable", "Não foi possível iniciar a assinatura agora. Tente de novo em instantes.");
    }
    return { subscriptionId: sub.id, initPoint: pre.initPoint, status: STATUS.PENDING };
  };
}

async function currentSubscriptionOf(db, uid, siteIdRaw) {
  const siteId = parseSiteId(siteIdRaw);
  const { data: site } = await loadOwnedSite(db, siteId, uid);
  if (!site.subscriptionId) throw new HttpsError("not-found", "Esse site não tem assinatura.");
  const snap = await db.collection("subscriptions").doc(site.subscriptionId).get();
  if (!snap.exists || snap.data().ownerUid !== uid || snap.data().siteId !== siteId) throw new HttpsError("not-found", "Assinatura não encontrada.");
  return { siteId, site, sub: { id: snap.id, ...snap.data() } };
}

function makeCancelSubscription({ db, FieldValue, getProvider, engine, now = () => Date.now() }) {
  return async (request) => {
    const auth = requireAuth(request);
    const { siteId, sub } = await currentSubscriptionOf(db, auth.uid, (request.data || {}).siteId);
    if (sub.creationState === "creating" && !sub.mpPreapprovalId) throw new HttpsError("unavailable", "A assinatura ainda está sendo confirmada. Aguarde a recuperação antes de cancelar.");
    if (sub.status !== STATUS.CANCELLED && !sub.requestedCancel) {
      let pre = null;
      if (sub.mpPreapprovalId) {
        try {
          pre = await getProvider().cancelPreapproval(sub.mpPreapprovalId);
        } catch (err) {
          console.error("Falha ao cancelar no gateway:", err && err.message);
          throw new HttpsError("unavailable", "Não foi possível cancelar agora. Tente de novo em instantes.");
        }
      }
      await db.collection("subscriptions").doc(sub.id).update({ requestedCancel: true, cancelReason: "user", cancelledAt: now(), updatedAt: FieldValue.serverTimestamp() });
      await engine.applyState(sub.id, pre ? { preapproval: pre } : null);
    }
    const [subSnap, siteSnap] = await Promise.all([db.collection("subscriptions").doc(sub.id).get(), db.collection("sites").doc(siteId).get()]);
    return publicView({ id: sub.id, ...subSnap.data() }, siteSnap.data());
  };
}

function makeSyncSubscription({ db, FieldValue, engine, now = () => Date.now() }) {
  return async (request) => {
    const auth = requireAuth(request);
    const { siteId, sub } = await currentSubscriptionOf(db, auth.uid, (request.data || {}).siteId);
    if (now() - (sub.lastManualSyncMs || 0) < MANUAL_SYNC_COOLDOWN_MS) {
      throw new HttpsError("resource-exhausted", "Aguarde alguns segundos antes de atualizar de novo.");
    }
    await db.collection("subscriptions").doc(sub.id).update({ lastManualSyncMs: now(), updatedAt: FieldValue.serverTimestamp() });
    try {
      await engine.syncFromGateway(sub.id);
    } catch (err) {
      console.error("Sincronização manual falhou:", err && err.message);
      throw new HttpsError("unavailable", "Não foi possível consultar o Mercado Pago agora.");
    }
    const [subSnap, siteSnap] = await Promise.all([db.collection("subscriptions").doc(sub.id).get(), db.collection("sites").doc(siteId).get()]);
    return publicView({ id: sub.id, ...subSnap.data() }, siteSnap.data());
  };
}

/** Publica as alterações pendentes de um site que já está no ar (e só se a assinatura ainda dá direito de acesso). */
function makePublishChanges({ db, engine }) {
  return async (request) => {
    const auth = requireAuth(request);
    const { siteId, site, sub } = await currentSubscriptionOf(db, auth.uid, (request.data || {}).siteId);
    if (!site.published) throw new HttpsError("failed-precondition", "Esse site não está no ar. Publique-o pela assinatura.");
    const outcome = await engine.applyState(sub.id, null, { forceRepublish: true });
    const [siteSnap] = await Promise.all([db.collection("sites").doc(siteId).get()]);
    const after = siteSnap.data();
    if (!after.published) throw new HttpsError("failed-precondition", "Sua assinatura não permite mais manter o site no ar.");
    if (outcome.anomalies && (outcome.anomalies.includes("site_invalid") || outcome.anomalies.includes("slug_conflict"))) {
      throw new HttpsError("failed-precondition", "Não foi possível publicar as alterações agora. Revise os dados do site.");
    }
    return { published: true, hasUnpublishedChanges: after.publishedHash !== after.contentHash };
  };
}

/** Rotina periódica: regras de tempo (carência, fim do período pago) + recuperação de eventos perdidos. */
function makeReconcile({ db, FieldValue, getProvider, engine, now = () => Date.now() }) {
  return async function reconcile({ limit = 200 } = {}) {
    const summary = { checked: 0, synced: 0, ticked: 0, abandoned: 0, errors: 0 };
    const seen = new Set(); // uma assinatura muda de "balde" durante a execução: processa cada uma só uma vez
    for (const status of [STATUS.PENDING, STATUS.ACTIVE, STATUS.PAST_DUE, STATUS.SUSPENDED, STATUS.CANCELLED]) {
      const snap = await db.collection("subscriptions").where("status", "==", status).get();
      for (const doc of snap.docs) {
        const s = { id: doc.id, ...doc.data() };
        if (s.settled || seen.has(s.id) || summary.checked >= limit) continue;
        seen.add(s.id);
        summary.checked++;
        try {
          if (s.creationState === "needs_cancel" && s.mpPreapprovalId) {
            await compensateOrphan({ db, FieldValue, getProvider, now }, { sub: s, pre: { id: s.mpPreapprovalId }, reason: "retry_orphan_cancel" });
            summary.ticked++;
            continue;
          }
          // Uma criação incerta não vira 'abandonada' só pela passagem do tempo.
          if (s.creationState === "creating" && !s.mpPreapprovalId) {
            summary.ticked++;
            continue;
          }
          const gatewayTerminal = s.mpStatus === "cancelled" || s.requestedCancel === true;
          if (s.status === STATUS.PENDING && now() - (s.createdAtMs || 0) > PENDING_ABANDON_DAYS * DAY_MS && !s.currentPeriodEnd) {
            if (s.mpPreapprovalId && !gatewayTerminal) {
              await getProvider().cancelPreapproval(s.mpPreapprovalId);
            }
            await db.collection("subscriptions").doc(s.id).update({ requestedCancel: true, cancelReason: "abandoned", cancelledAt: now(), updatedAt: FieldValue.serverTimestamp() });
            await engine.applyState(s.id, null);
            summary.abandoned++;
          } else if (!gatewayTerminal && s.mpPreapprovalId) {
            await engine.syncFromGateway(s.id);
            summary.synced++;
          } else {
            await engine.applyState(s.id, null);
            summary.ticked++;
          }
        } catch (err) {
          summary.errors++;
          console.error("Reconciliação falhou para", s.id, err && err.message);
        }
      }
    }
    // Libera reservas de endereço vencidas (checkout abandonado ou retenção terminada).
    summary.claimsReleased = 0;
    for (const state of ["reserved", "held"]) {
      const claims = await db.collection("slugClaims").where("state", "==", state).get();
      for (const c of claims.docs) {
        const exp = c.data().expiresAtMs;
        if (typeof exp === "number" && exp <= now()) {
          await db.collection("slugClaims").doc(c.id).delete();
          summary.claimsReleased++;
        }
      }
    }
    return summary;
  };
}

// Processamento de UM evento (compartilhado entre o webhook e o reprocessador agendado).
function makeProcessTopic({ db, FieldValue, getProvider, engine, now }) {
  async function processTopic(topic, dataId) {
    const provider = getProvider();

    async function applyFor(preapprovalId, invoices, preapprovalHint) {
      const pre = preapprovalHint || (await provider.getPreapproval(preapprovalId));
      const sub = await engine.findSubscription({ externalReference: pre.externalReference, preapprovalId: pre.id });
      if (!sub) return { result: "unknown_subscription" };
      if (sub.creationState === "needs_cancel") return compensateOrphan({ db, FieldValue, getProvider, now }, { sub, pre, reason: "retry_orphan_cancel" });
      if (!sub.mpPreapprovalId && pre.externalReference === sub.id) {
        if (sub.creationState === "failed" && String(pre.status).toLowerCase() !== "cancelled") {
          // Assinatura remota "órfã": nossa criação já foi dada como falha. Cancela no gateway e registra o incidente.
          return compensateOrphan({ db, FieldValue, getProvider, now }, { sub, pre, reason: "orphan_found_by_webhook" });
        }
        // O gateway pode notificar antes de createSubscription gravar o id: a referência externa é nossa.
        await db.collection("subscriptions").doc(sub.id).update({ mpPreapprovalId: pre.id, initPoint: pre.initPoint || null, ...(sub.creationState === "creating" ? { creationState: "ready" } : {}) });
      }
      let all = invoices;
      try {
        const searched = await provider.searchInvoices({ preapprovalId: pre.id });
        const known = new Set(invoices.map((i) => i.id));
        all = [...invoices, ...searched.filter((i) => !known.has(i.id))];
      } catch (err) {
        console.warn("Busca de cobranças falhou no webhook:", err && err.message);
      }
      const applied = await engine.applyState(sub.id, { preapproval: pre, invoices: all });
      return { result: applied.error ? applied.error : "applied", subId: sub.id, status: applied.status, anomalies: applied.anomalies };
    }

    if (topic === "subscription_preapproval") {
      const pre = await provider.getPreapproval(dataId);
      return applyFor(pre.id, [], pre);
    }
    if (topic === "subscription_authorized_payment") {
      const invoice = await provider.getInvoice(dataId);
      if (!invoice.preapprovalId) return { result: "invoice_without_subscription" };
      return applyFor(invoice.preapprovalId, [invoice]);
    }
    // payment: estornos, contestações e confirmações chegam aqui
    const payment = await provider.getPayment(dataId);
    const invoices = (await provider.searchInvoices({ paymentId: payment.id })).filter((i) => i.paymentId === payment.id).map((invoice) => {
      if (invoice.amountCents !== payment.amountCents || (payment.currency && invoice.currency && payment.currency !== invoice.currency)) throw new Error("Pagamento diverge da cobrança recorrente.");
      return { ...invoice, paymentStatus: payment.status, paymentStatusDetail: payment.statusDetail };
    });
    if (!invoices.length) {
      const legacy = await db.collection("payments").doc(String(payment.id)).get();
      if (legacy.exists) {
        console.error("Pagamento do fluxo antigo (Pix avulso) recebido após a migração — requer ação manual:", payment.id);
        return { result: "legacy_payment_manual_action" };
      }
      return { result: "unlinked_payment" }; // a cobrança recorrente correspondente chega por outro tópico ou pela reconciliação
    }
    return applyFor(invoices[0].preapprovalId, invoices);
  }
  return processTopic;
}

// Tempo máximo de processamento DENTRO da requisição do webhook. Estourou => 503: o Mercado Pago reenvia e o
// reprocessador agendado também recupera o evento (que já está gravado de forma durável antes de processar).
const WEBHOOK_BUDGET_MS = 18000;
function withBudget(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("webhook: orçamento de tempo excedido"), { code: "WEBHOOK_TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeWebhook({ db, FieldValue, getProvider, getSecret, engine, now = () => Date.now(), budgetMs = WEBHOOK_BUDGET_MS }) {
  const processTopic = makeProcessTopic({ db, FieldValue, getProvider, engine, now });

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("method not allowed");
      return;
    }
    const query = req.query || {};
    const body = req.body || {};
    const headers = req.headers || {};
    const dataIdQuery = query["data.id"];

    // 1) Autenticidade: assinatura HMAC com o segredo do webhook. Nada é gravado antes disso.
    let secret;
    try {
      secret = getSecret();
    } catch (err) {
      console.error("Segredo do webhook indisponível:", err && err.message);
    }
    const verification = verifySignature({ secret, signatureHeader: headers["x-signature"], requestId: headers["x-request-id"], dataId: dataIdQuery });
    if (!verification.ok) {
      console.warn("Webhook rejeitado:", verification.reason);
      res.status(verification.reason === "secret_not_configured" ? 500 : 401).send("assinatura inválida");
      return;
    }

    const topic = String(query.type || query.topic || body.type || body.topic || "").toLowerCase();
    if (!KNOWN_TOPICS.includes(topic)) {
      res.status(200).send("ignorado");
      return;
    }
    const dataId = String(dataIdQuery);

    // 2) Registro do evento (diagnóstico + deduplicação). Reprocessar é seguro, pois o estado vem do gateway.
    const eventId = crypto.createHash("sha256").update(`${topic}|${dataId}|${headers["x-request-id"] || ""}`).digest("hex").slice(0, 40);
    const eventRef = db.collection("webhookEvents").doc(eventId);
    let attempts = 1;
    try {
      await eventRef.create({ topic, dataId, requestId: headers["x-request-id"] || null, signatureTs: verification.ts, status: "received", attempts, receivedAtMs: now() });
    } catch (err) {
      const existing = await eventRef.get();
      if (!existing.exists) throw err;
      if (existing.data().status === "processed") {
        res.status(200).send("duplicado");
        return;
      }
      attempts = (existing.data().attempts || 1) + 1;
      await eventRef.update({ attempts, status: "received" });
    }

    // 3) Processamento: sempre consulta o recurso ATUAL no gateway.
    try {
      const outcome = await withBudget(processTopic(topic, dataId), budgetMs);
      await eventRef.update(clean({ status: "processed", result: outcome.result, subId: outcome.subId, subStatus: outcome.status, anomalies: outcome.anomalies && outcome.anomalies.length ? outcome.anomalies : undefined, processedAtMs: now() }));
      res.status(200).send("ok");
    } catch (err) {
      console.error("Erro processando webhook:", topic, dataId, err && err.message);
      try {
        await eventRef.update({ status: "failed", error: String((err && err.message) || err).slice(0, 300), failedAtMs: now() });
      } catch (logErr) {
        console.error("Não foi possível registrar a falha do evento:", logErr && logErr.message);
      }
      res.status(err && err.code === "WEBHOOK_TIMEOUT" ? 503 : 500).send("erro");
    }
  };
}

/** Reprocessa eventos já gravados (assinatura válida) que falharam ou ficaram "received" (instância encerrada no meio). */
function makeRetryWebhookEvents({ db, FieldValue, getProvider, engine, now = () => Date.now(), maxAttempts = 10, minAgeMs = 2 * 60 * 1000, budgetMs = 20000 }) {
  const processTopic = makeProcessTopic({ db, FieldValue, getProvider, engine, now });
  return async function retry({ limit = 50 } = {}) {
    const summary = { checked: 0, processed: 0, failed: 0, gaveUp: 0 };
    for (const status of ["failed", "received"]) {
      const snap = await db.collection("webhookEvents").where("status", "==", status).get();
      for (const doc of snap.docs) {
        const e = doc.data();
        if (summary.checked >= limit) break;
        if (now() - (e.failedAtMs || e.receivedAtMs || 0) < minAgeMs) continue;
        summary.checked++;
        const ref = db.collection("webhookEvents").doc(doc.id);
        if ((e.attempts || 1) >= maxAttempts) {
          await ref.update({ status: "dead", deadAtMs: now() });
          console.error("Evento de webhook desistido após várias tentativas (verificar manualmente):", doc.id, e.topic, e.dataId);
          summary.gaveUp++;
          continue;
        }
        try {
          const outcome = await withBudget(processTopic(e.topic, e.dataId), budgetMs);
          await ref.update(clean({ status: "processed", result: outcome.result, subId: outcome.subId, attempts: (e.attempts || 1) + 1, processedAtMs: now() }));
          summary.processed++;
        } catch (err) {
          await ref.update({ status: "failed", attempts: (e.attempts || 1) + 1, error: String((err && err.message) || err).slice(0, 300), failedAtMs: now() });
          summary.failed++;
        }
      }
    }
    return summary;
  };
}

module.exports = { makeRetryWebhookEvents, makeEngine, makeCreateSubscription, makeCancelSubscription, makeSyncSubscription, makePublishChanges, makeReconcile, makeWebhook, siteCheckOf };
