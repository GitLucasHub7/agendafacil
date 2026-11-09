const { onCall, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineString, defineBoolean } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

// Limites iniciais de homologação por função; não constituem um teto de faturamento.
setGlobalOptions({ minInstances: 0, maxInstances: 3, concurrency: 20, memory: "256MiB", timeoutSeconds: 60 });
initializeApp();
const db = getFirestore();

const { getSubscriptionProvider, getWebhookSecret, secrets } = require("./payments/subscriptions");
const { makeSaveSite } = require("./lib/sites");
const { makeDeleteAccount } = require("./lib/account");
const { makeEngine, makeCreateSubscription, makeCancelSubscription, makeSyncSubscription, makePublishChanges, makeReconcile, makeRetryWebhookEvents, makeWebhook } = require("./lib/subscriptions");
const { withAppCheck } = require("./lib/guards");

// URL pública do app (https), usada como back_url do checkout. Defina em functions/.env.<projeto>:
//   APP_BASE_URL=https://SEU-PROJETO.web.app
const appBaseUrl = defineString("APP_BASE_URL", { default: "" });

// App Check: deixe false até configurar a chave no cliente e testar em staging; em PRODUÇÃO deve ser true.
//   ENFORCE_APP_CHECK=true  em functions/.env.<alias>
const enforceAppCheck = defineBoolean("ENFORCE_APP_CHECK", { default: false });
const guard = (handler) => withAppCheck(handler, () => enforceAppCheck.value());

const deps = { db, FieldValue, getProvider: getSubscriptionProvider };
const engine = makeEngine(deps);

/** Cria ou atualiza um rascunho do usuário autenticado (validação e posse no servidor). */
exports.saveSite = onCall(guard(makeSaveSite({ db, FieldValue, afterSave: (subId) => engine.applyState(subId, null) })));

/** Inicia a assinatura mensal (R$ 21,90) de UM site do usuário; devolve o link do checkout do Mercado Pago. */
exports.createSubscription = onCall({ secrets }, guard(makeCreateSubscription({ ...deps, getAppBaseUrl: () => appBaseUrl.value() })));

/** Cancela a assinatura do site: o acesso continua até o fim do período já pago. */
exports.cancelSubscription = onCall({ secrets }, guard(makeCancelSubscription({ ...deps, engine })));

/** Atualização manual do estado (ex.: ao voltar do checkout), com intervalo mínimo entre chamadas. */
exports.syncSubscription = onCall({ secrets }, guard(makeSyncSubscription({ ...deps, engine })));

/** Publica as alterações pendentes de um site já no ar (somente com assinatura que dá direito de acesso). */
exports.publishChanges = onCall(guard(makePublishChanges({ db, engine })));

/** Exclui a conta do usuário (login recente, sem acesso pago vigente; registros financeiros ficam anonimizados). */
exports.deleteAccount = onCall({ secrets }, guard(makeDeleteAccount({ ...deps, deleteAuthUser: (uid) => getAuth().deleteUser(uid) })));

/**
 * Webhook do Mercado Pago (mesma URL/nome de antes). Valida a assinatura x-signature, registra o evento e
 * sempre consulta o recurso ATUAL no gateway antes de alterar qualquer estado.
 */
// timeoutSeconds > orçamento interno (18 s); maxInstances limita custo/abuso do endpoint público.
exports.paymentWebhook = onRequest({ secrets, timeoutSeconds: 60, maxInstances: 3 }, makeWebhook({ ...deps, engine, getSecret: getWebhookSecret }));

/** Reconciliação: regras de tempo (carência, fim do período) e recuperação de notificações perdidas. */
exports.reconcileSubscriptions = onSchedule({ schedule: "every 6 hours", timeZone: "America/Sao_Paulo", secrets, timeoutSeconds: 300, maxInstances: 1, concurrency: 1 }, async () => {
  const summary = await makeReconcile({ ...deps, engine })();
  console.log("reconcileSubscriptions:", JSON.stringify(summary));
});

/** Reprocessa eventos de webhook gravados que falharam ou ficaram pela metade (mecanismo durável de retry). */
exports.retryWebhookEvents = onSchedule({ schedule: "every 15 minutes", timeZone: "America/Sao_Paulo", secrets, timeoutSeconds: 300, maxInstances: 1, concurrency: 1 }, async () => {
  const summary = await makeRetryWebhookEvents({ ...deps, engine })();
  console.log("retryWebhookEvents:", JSON.stringify(summary));
});
