#!/usr/bin/env node
/*
 * Cria as reservas de endereço (slugClaims) dos sites JÁ publicados. Rode ANTES do lançamento.
 *
 *   node scripts/migrate-slug-claims.js                  -> ENSAIO (padrão): só lê e imprime o plano
 *   node scripts/migrate-slug-claims.js --apply          -> grava (lote marcado com migrationBatch)
 *   node scripts/migrate-slug-claims.js --rollback LOTE  -> desfaz um lote
 *
 * Requer credenciais do Admin SDK (GOOGLE_APPLICATION_CREDENTIALS) do projeto-alvo. NUNCA roda sozinho.
 * Regras:
 *  - nunca sobrescreve uma reserva existente de outro site (vira "conflito" no relatório, para decisão manual);
 *  - publicSites sem site correspondente/dono viram "órfãos" no relatório e NÃO são reservados;
 *  - rollback remove só as reservas do lote e limpa o ponteiro do site; NUNCA toca em publicSites nem no conteúdo.
 * Mesmo sem esta migração o motor "repara" a reserva de um site publicado ao reavaliá-lo, mas só a migração
 * protege o endereço contra um OUTRO site que tente assinar antes disso.
 */
const { publishedClaim } = require("../functions/lib/slug-claims");

async function planClaims(db) {
  const plan = { toClaim: [], alreadyClaimed: [], conflicts: [], orphans: [] };
  const pubs = await db.collection("publicSites").get();
  for (const doc of pubs.docs) {
    const slug = doc.id;
    const siteId = doc.data().siteId;
    if (!siteId) {
      plan.orphans.push({ slug, reason: "publicSites sem siteId" });
      continue;
    }
    const site = await db.collection("sites").doc(siteId).get();
    if (!site.exists || !site.data().ownerUid) {
      plan.orphans.push({ slug, siteId, reason: site.exists ? "site sem ownerUid" : "site inexistente" });
      continue;
    }
    const claim = await db.collection("slugClaims").doc(slug).get();
    if (claim.exists) {
      (claim.data().siteId === siteId ? plan.alreadyClaimed : plan.conflicts).push({ slug, siteId, claimSiteId: claim.data().siteId });
      continue;
    }
    plan.toClaim.push({ slug, siteId, ownerUid: site.data().ownerUid, subscriptionId: site.data().subscriptionId || null });
  }
  return plan;
}

async function applyClaims(db, plan, { batchId, now = Date.now() } = {}) {
  if (!batchId) throw new Error("batchId obrigatório");
  const done = [];
  const skipped = [];
  for (const item of plan.toClaim) {
    try {
      await db.collection("slugClaims").doc(item.slug).create({ ...publishedClaim({ ...item, now }), source: "migration", migrationBatch: batchId });
    } catch (err) {
      skipped.push({ slug: item.slug, reason: "reserva criada por outro processo durante a migração" }); // create() não sobrescreve
      continue;
    }
    await db.collection("sites").doc(item.siteId).update({ slugClaim: item.slug, slugClaimBatch: batchId });
    done.push(item.slug);
  }
  return { done, skipped };
}

async function rollbackClaims(db, batchId) {
  if (!batchId) throw new Error("batchId obrigatório");
  const undone = { claims: 0, sites: 0 };
  const claims = await db.collection("slugClaims").where("migrationBatch", "==", batchId).get();
  for (const d of claims.docs) {
    await db.collection("slugClaims").doc(d.id).delete();
    undone.claims++;
  }
  const sites = await db.collection("sites").where("slugClaimBatch", "==", batchId).get();
  for (const d of sites.docs) {
    await db.collection("sites").doc(d.id).update({ slugClaim: null, slugClaimBatch: null });
    undone.sites++;
  }
  return undone;
}

async function main() {
  const args = process.argv.slice(2);
  const fnRequire = require("node:module").createRequire(require("node:path").join(__dirname, "../functions/package.json"));
  const { initializeApp } = fnRequire("firebase-admin/app");
  const { getFirestore } = fnRequire("firebase-admin/firestore");
  initializeApp();
  const db = getFirestore();
  if (args[0] === "--rollback") {
    console.log("Desfeito:", await rollbackClaims(db, args[1]));
    return;
  }
  const plan = await planClaims(db);
  console.log(JSON.stringify(plan, null, 2));
  console.log(`\nResumo: ${plan.toClaim.length} a reservar · ${plan.alreadyClaimed.length} já reservados · ${plan.conflicts.length} conflitos · ${plan.orphans.length} órfãos`);
  if (!args.includes("--apply")) {
    console.log("ENSAIO: nada foi gravado. Resolva conflitos/órfãos manualmente e use --apply para executar.");
    return;
  }
  const batchId = `claims_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const result = await applyClaims(db, plan, { batchId });
  console.log(`\nAplicado lote ${batchId}:`, result.done.length, "reservas. Para desfazer: node scripts/migrate-slug-claims.js --rollback", batchId);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { planClaims, applyClaims, rollbackClaims };
