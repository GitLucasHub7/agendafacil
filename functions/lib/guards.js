const { HttpsError } = require("firebase-functions/v2/https");

/**
 * Exige App Check nas callables quando `isEnforced()` for verdadeiro (parâmetro ENFORCE_APP_CHECK).
 * `enforceAppCheck` da plataforma só aceita booleano estático; este guarda permite ligar/desligar por ambiente
 * sem alterar o código. `request.app` só existe quando o token de App Check enviado é válido.
 */
function withAppCheck(handler, isEnforced) {
  return async (request) => {
    if (isEnforced() && !(request && request.app && request.app.appId)) {
      throw new HttpsError("unauthenticated", "Verificação do aplicativo (App Check) necessária. Recarregue a página e tente de novo.");
    }
    return handler(request);
  };
}

module.exports = { withAppCheck };
