// Modo explícito deste ambiente. Habilite Blaze somente após validar Functions, parâmetros e webhook em staging.
//   "spark": plano Spark do Firebase (sem Cloud Functions). Rascunhos são gravados direto no Firestore, protegidos
//            pelas regras (firestore.rules). Publicar sites e assinar pelo Mercado Pago NÃO estão disponíveis.
//   "blaze": Cloud Functions implantadas (plano Blaze). Habilita salvar via servidor, publicar, assinatura e webhook.
// Staging e produção exigem "blaze" (o scripts/check-env.js bloqueia o deploy se estiver "spark").
window.APP_MODE = "spark";
