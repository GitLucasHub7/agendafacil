#!/usr/bin/env node
/*
 * Migração REVERSÍVEL do modelo antigo (Pix avulso de R$ 49) para o modelo de assinatura.
 *
 *   node scripts/migrate-legacy.js                  -> DRY-RUN (padrão): só lê e imprime o plano
 *   node scripts/migrate-legacy.js --apply          -> grava (lote marcado com migrationBatch)
 *   node scripts/migrate-legacy.js --rollback LOTE  -> desfaz um lote
 *
 * Requer credenciais do Admin SDK (GOOGLE_APPLICATION_CREDENTIALS). NÃO é executado automaticamente
 * por nenhum deploy. Rode primeiro em um projeto de STAGING.
 *
 * Regra de migração: site publicado e pago (paymentStatus "paid") sem assinatura recebe uma assinatura
 * "legada" ATIVA, sem preapproval no Mercado Pago, com 1 mês contado da publicação (mínimo de GRACE_DAYS a partir
 * de hoje, para não derrubar quem pagou há pouco). Ao fim do período ele cai na carência normal e depois é
 * suspenso, com o botão "Assinar de novo". Sites sem dono (formato original, chave = slug) NUNCA são migrados:
 * entram no relatório para decisão manual.
 */
const { PLAN, STATUS, GRACE_DAYS, DAY_MS, addMonths } = require("../functions/lib/plan");

const tsToMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : null);

async function planMigration(db, { now = Date.now() } = {}) {
  const published = await db.collection("sites").where("published", "==", true).get();
  const plan = { toMigrate: [], skipped: [], orphans: [] };
  for (const doc of published.docs) {
    const site = doc.data();
    if (!site.ownerUid) {
      plan.orphans.push({ siteId: doc.id, reason: "sem ownerUid (formato original, chave = slug): requer decisão manual" });
      continue;
    }
    if (site.subscriptionId) {
      plan.skipped.push({ siteId: doc.id, reason: "já tem assinatura" });
      continue;
    }
    const payments = await db.collection("payments").where("siteId", "==", doc.id).get();
    const approved = payments.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.status === "approved");
    if (!approved.length) {
      plan.skipped.push({ siteId: doc.id, reason: "publicado sem pagamento aprovado registrado: revisar manualmente" });
      continue;
    }
    const startMs = tsToMs(site.publishedAt) || approved[0].createdAtMs || now;
    const periodEnd = Math.max(addMonths(startMs, 1), now + GRACE_DAYS * DAY_MS);
    plan.toMigrate.push({ siteId: doc.id, ownerUid: site.ownerUid, slug: site.publishedSlug || site.slug || null, legacyPaymentId: approved[0].id, periodStart: startMs, periodEnd });
  }
  return plan;
}

async function applyMigration(db, plan, { batchId, now = Date.now() } = {}) {
  if (!batchId) throw new Error("batchId obrigatório");
  const done = [];
  for (const item of plan.toMigrate) {
    const subRef = db.collection("subscriptions").doc();
    await subRef.set({
      ownerUid: item.ownerUid, siteId: item.siteId, status: STATUS.ACTIVE, statusReason: null, mpStatus: "legacy", mpPreapprovalId: null, initPoint: null,
      priceCents: PLAN.priceCents, currency: PLAN.currency, currentPeriodEnd: item.periodEnd, accessUntil: item.periodEnd, graceUntil: null,
      requestedCancel: false, anomalies: [], settled: false, source: "legacy_one_time", migrationBatch: batchId, createdAtMs: now,
    });
    await db.collection("subscriptionInvoices").doc(`inv_legacy_${item.legacyPaymentId}`).set({
      id: `inv_legacy_${item.legacyPaymentId}`, subId: subRef.id, siteId: item.siteId, ownerUid: item.ownerUid, mpInvoiceId: null, mpPaymentId: item.legacyPaymentId,
      status: "approved", credited: true, periodStart: item.periodStart, periodEnd: item.periodEnd, amountCents: 4900, createdAtMs: now, source: "legacy_one_time", migrationBatch: batchId,
    });
    await db.collection("sites").doc(item.siteId).update({ subscriptionId: subRef.id, subscriptionStatus: STATUS.ACTIVE, accessUntil: item.periodEnd, migrationBatch: batchId });
    done.push({ siteId: item.siteId, subscriptionId: subRef.id });
  }
  return done;
}

async function rollbackMigration(db, batchId) {
  if (!batchId) throw new Error("batchId obrigatório");
  const undone = { subscriptions: 0, invoices: 0, sites: 0 };
  for (const [col, key] of [["subscriptions", "subscriptions"], ["subscriptionInvoices", "invoices"]]) {
    const snap = await db.collection(col).where("migrationBatch", "==", batchId).get();
    for (const d of snap.docs) {
      await db.collection(col).doc(d.id).delete();
      undone[key]++;
    }
  }
  const sites = await db.collection("sites").where("migrationBatch", "==", batchId).get();
  for (const d of sites.docs) {
    await db.collection("sites").doc(d.id).update({ subscriptionId: null, subscriptionStatus: null, accessUntil: null, publishState: null, migrationBatch: null });
    undone.sites++;
  }
  return undone; // publicSites/ e o conteúdo dos sites NUNCA são tocados
}

async function main() {
  const args = process.argv.slice(2);
  const fnRequire = require("node:module").createRequire(require("node:path").join(__dirname, "../functions/package.json"));
  const { initializeApp } = fnRequire("firebase-admin/app");
  const { getFirestore } = fnRequire("firebase-admin/firestore");
  initializeApp();
  const db = getFirestore();
  if (args[0] === "--rollback") {
    console.log("Desfeito:", await rollbackMigration(db, args[1]));
    return;
  }
  const plan = await planMigration(db);
  console.log(JSON.stringify(plan, null, 2));
  if (!args.includes("--apply")) {
    console.log("\nDRY-RUN: nada foi gravado. Use --apply para executar.");
    return;
  }
  const batchId = `mig_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const done = await applyMigration(db, plan, { batchId });
  console.log(`\nAplicado lote ${batchId}:`, done.length, "sites. Para desfazer: node scripts/migrate-legacy.js --rollback", batchId);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { planMigration, applyMigration, rollbackMigration };
