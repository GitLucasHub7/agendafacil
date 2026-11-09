// Exclusão de conta. Política (decisão de produto/jurídica a validar antes de produção):
//  - exige login RECENTE (auth_time) e confirmação digitada;
//  - bloqueia enquanto houver acesso pago vigente (assinatura ativa, em carência ou cancelada dentro do período pago);
//  - antes de apagar, cancela no gateway toda assinatura ainda viva (para não cobrar uma conta inexistente);
//  - apaga sites (rascunhos), suas cópias públicas e as reservas de endereço (slugClaims);
//  - ANONIMIZA (não apaga) assinaturas, cobranças e pagamentos legados, preservando o registro financeiro;
//  - por último, apaga o usuário do Firebase Auth. Idempotente: pode ser repetida se algo falhar no meio.
const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const { requireAuth } = require("./sites");
const { entitled } = require("./subscription-logic");

const RECENT_LOGIN_MS = 5 * 60 * 1000;

function makeDeleteAccount({ db, FieldValue, getProvider, deleteAuthUser, now = () => Date.now() }) {
  return async (request) => {
    const auth = requireAuth(request);
    if ((request.data || {}).confirm !== "EXCLUIR") throw new HttpsError("invalid-argument", "Digite EXCLUIR para confirmar a exclusão da conta.");

    const ts = now();
    const authTimeMs = Number(auth.token && auth.token.auth_time) * 1000;
    if (!Number.isFinite(authTimeMs) || ts - authTimeMs > RECENT_LOGIN_MS) {
      throw new HttpsError("failed-precondition", "Por segurança, entre novamente na sua conta antes de excluí-la.", { reason: "recent-login-required" });
    }

    const uid = auth.uid;
    const subs = (await db.collection("subscriptions").where("ownerUid", "==", uid).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    if (subs.some((s) => s.creationState === "creating" && !s.mpPreapprovalId)) {
      throw new HttpsError("failed-precondition", "Uma assinatura ainda está sendo confirmada. Aguarde a recuperação antes de excluir a conta.", { reason: "subscription-unresolved" });
    }

    const withAccess = subs.find((s) => entitled(s.status, s.currentPeriodEnd, s.graceUntil, ts));
    if (withAccess) {
      throw new HttpsError("failed-precondition", "Você ainda tem uma assinatura com acesso vigente. Cancele-a e aguarde o fim do período pago para excluir a conta.", { reason: "active-subscription" });
    }

    // Para de cobrar no gateway. Se falhar, NADA é apagado (evita cobrar uma conta que já não existe).
    for (const s of subs) {
      if (s.mpPreapprovalId && (s.creationState === "needs_cancel" || (s.mpStatus !== "cancelled" && s.requestedCancel !== true))) {
        try {
          await getProvider().cancelPreapproval(s.mpPreapprovalId);
        } catch (err) {
          console.error("deleteAccount: falha ao cancelar assinatura no gateway:", s.id, err && err.message);
          throw new HttpsError("unavailable", "Não foi possível encerrar a cobrança agora. Tente de novo em instantes.");
        }
      }
    }

    const anon = `deleted_${crypto.createHash("sha256").update(uid).digest("hex").slice(0, 16)}`;

    const sites = (await db.collection("sites").where("ownerUid", "==", uid).get()).docs;
    let deletedSites = 0;
    for (const doc of sites) {
      const site = doc.data();
      for (const slug of new Set([site.publishedSlug, site.slug].filter(Boolean))) {
        const pub = await db.collection("publicSites").doc(slug).get();
        if (pub.exists && pub.data().siteId === doc.id) await db.collection("publicSites").doc(slug).delete();
      }
      await db.collection("sites").doc(doc.id).delete();
      deletedSites++;
    }

    // Reservas de endereço (reservadas, publicadas ou retidas) deste usuário: liberadas junto com os sites.
    const claims = (await db.collection("slugClaims").where("ownerUid", "==", uid).get()).docs;
    for (const claim of claims) await db.collection("slugClaims").doc(claim.id).delete();

    for (const s of subs) {
      await db.collection("subscriptions").doc(s.id).update({ ownerUid: anon, accountDeleted: true, status: "cancelled", statusReason: "account_deleted", requestedCancel: true, settled: true, initPoint: null, accessUntil: null, updatedAt: FieldValue.serverTimestamp() });
    }
    for (const col of ["subscriptionInvoices", "payments", "incidents"]) {
      const snap = await db.collection(col).where("ownerUid", "==", uid).get();
      for (const d of snap.docs) {
        await db.collection(col).doc(d.id).update(col === "payments" ? { ownerUid: anon, payerEmail: null, qrCode: null, qrCodeBase64: null, accountDeleted: true } : { ownerUid: anon, accountDeleted: true });
      }
    }

    await deleteAuthUser(uid);
    return { deleted: true, deletedSites };
  };
}

module.exports = { makeDeleteAccount, RECENT_LOGIN_MS };
