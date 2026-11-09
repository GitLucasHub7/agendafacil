// Regras de negócio do rascunho do site (salvar). A cobrança e a publicação vivem em subscriptions.js.
// Todas as dependências (db, FieldValue, provider) são injetadas, então a lógica é testável sem emulador.
const { HttpsError } = require("firebase-functions/v2/https");
const { validateSiteInput, pickSiteFields, contentHash, ValidationError } = require("./validate");
const { blocks } = require("./slug-claims");

const MAX_SITES_PER_USER = 10; // decisão de produto: ajuste conforme o plano comercial
const SITE_ID_RE = /^[A-Za-z0-9]{10,40}$/;

function requireAuth(request) {
  if (!request || !request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Entre na sua conta para continuar.");
  }
  return request.auth;
}

function parseSiteId(value) {
  if (typeof value !== "string" || !SITE_ID_RE.test(value)) {
    throw new HttpsError("invalid-argument", "Identificador de site inválido.");
  }
  return value;
}

// Nunca devolve "não é seu" — site inexistente e site de outro usuário são indistinguíveis.
async function loadOwnedSite(db, siteId, uid) {
  const ref = db.collection("sites").doc(siteId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerUid !== uid) {
    throw new HttpsError("not-found", "Site não encontrado.");
  }
  return { ref, data: snap.data() };
}

function toHttpsError(err) {
  if (err instanceof ValidationError) return new HttpsError("invalid-argument", err.message, { field: err.field || null });
  return err;
}

// Disponível = nenhum OUTRO site publicado nem com reserva vigente nesse endereço.
async function isSlugFree(db, slug, siteId, now = Date.now()) {
  const [pub, claim] = await Promise.all([db.collection("publicSites").doc(slug).get(), db.collection("slugClaims").doc(slug).get()]);
  if (pub.exists && pub.data().siteId !== siteId) return false;
  return !(claim.exists && blocks(claim.data(), siteId, now));
}

function makeSaveSite({ db, FieldValue, afterSave, now = () => Date.now() }) {
  return async (request) => {
    const { uid } = requireAuth(request);
    const body = request.data || {};

    let validated;
    try {
      validated = validateSiteInput(body.site);
    } catch (err) {
      throw toHttpsError(err);
    }
    const { clean, slug } = validated;

    if (body.siteId === undefined || body.siteId === null) {
      const owned = await db.collection("sites").where("ownerUid", "==", uid).get();
      if (owned.size >= MAX_SITES_PER_USER) {
        throw new HttpsError("resource-exhausted", `Limite de ${MAX_SITES_PER_USER} sites por conta atingido.`);
      }
      const ref = db.collection("sites").doc();
      await ref.set({
        ...clean,
        slug,
        ownerUid: uid,
        published: false,
        paymentStatus: "unpaid",
        contentHash: contentHash(clean),
        publishedHash: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { siteId: ref.id, slug, slugAvailable: await isSlugFree(db, slug, ref.id, now()), published: false, hasUnpublishedChanges: false };
    }

    const siteId = parseSiteId(body.siteId);
    const { ref, data } = await loadOwnedSite(db, siteId, uid);
    // Site no ar: o conteúdo pode ser editado, mas o ENDEREÇO (slug) fica travado e as alterações só vão
    // ao ar quando o dono pedir (publishChanges). Site fora do ar (rascunho/suspenso): o slug acompanha o nome.
    const finalSlug = data.published && data.slug ? data.slug : slug;
    const hash = contentHash(clean);
    await ref.update({ ...clean, slug: finalSlug, contentHash: hash, updatedAt: FieldValue.serverTimestamp() });
    // Site com assinatura vigente mas fora do ar (ex.: slug em conflito) pode voltar ao ar após a correção.
    if (data.subscriptionId && afterSave) {
      try {
        await afterSave(data.subscriptionId);
      } catch (err) {
        console.error("afterSave falhou:", err);
      }
    }
    return {
      siteId,
      slug: finalSlug,
      slugAvailable: await isSlugFree(db, finalSlug, siteId, now()),
      published: Boolean(data.published),
      hasUnpublishedChanges: Boolean(data.published) && data.publishedHash !== hash,
    };
  };
}

module.exports = { makeSaveSite, requireAuth, parseSiteId, loadOwnedSite, toHttpsError, isSlugFree, MAX_SITES_PER_USER };
