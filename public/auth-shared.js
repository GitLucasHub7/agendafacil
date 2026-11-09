/*
 * auth-shared.js — inicialização única do Firebase + utilitários de sessão.
 * Exposto como window.AF. Páginas privadas chamam AF.requireUser(); a página de login chama
 * AF.redirectIfSignedIn(). Nenhum segredo vive aqui: só a configuração pública do app web.
 */
(function (global) {
  const PLACEHOLDER = /COLOQUE_AQUI/i;

  // A3: o original comparava a chave com ELA MESMA (sempre falso). Aqui só o placeholder invalida.
  function configIsValid(cfg) {
    return Boolean(
      cfg &&
        typeof cfg.apiKey === "string" && cfg.apiKey.length > 10 && !PLACEHOLDER.test(cfg.apiKey) &&
        typeof cfg.projectId === "string" && cfg.projectId.length > 0 && !PLACEHOLDER.test(cfg.projectId)
    );
  }

  const AUTH_ERRORS = {
    "auth/invalid-email": "Esse e-mail não parece válido.",
    "auth/missing-email": "Digite o seu e-mail.",
    "auth/missing-password": "Digite a sua senha.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/user-disabled": "Essa conta foi desativada. Fale com o suporte.",
    "auth/email-already-in-use": "Já existe uma conta com esse e-mail. Tente entrar ou recuperar a senha.",
    "auth/weak-password": "Escolha uma senha mais forte (mínimo de 8 caracteres).",
    "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
    "auth/network-request-failed": "Sem conexão com o servidor. Verifique sua internet e tente de novo.",
    "auth/requires-recent-login": "Por segurança, entre novamente para continuar.",
    "auth/operation-not-allowed": "Login por e-mail e senha ainda não está ativado neste projeto.",
  };
  function mapAuthError(error) {
    const code = error && error.code;
    return AUTH_ERRORS[code] || "Não foi possível concluir agora. Tente de novo em instantes.";
  }

  // "next" só pode apontar para páginas internas conhecidas (evita open redirect).
  function safeNext(value, fallback) {
    return typeof value === "string" && /^(painel|editor)\.html(\?[A-Za-z0-9=&_-]*)?$/.test(value) ? value : fallback;
  }

  // AF.go centraliza a navegação (e permite testar redirecionamentos).
  // Projeto ANTIGO (pré-Fase 1): este código nunca deve ler nem gravar nele. Se a configuração apontar para ele, o app
  // recusa iniciar e explica o motivo (evita gravar em um projeto com regras e Functions de outra versão).
  const LEGACY_PROJECTS = ["agenda-legacy-example"];

  const AF = { mode: ["spark", "blaze"].includes(global.APP_MODE) ? global.APP_MODE : null, projectId: null, initError: null, FieldValue: null, appCheck: false, configIsValid, mapAuthError, safeNext, ready: false, auth: null, db: null, functions: null, go: (url) => global.location.replace(url), navigate: (url) => global.location.assign(url) };
  let config = global.FIREBASE_CONFIG;

  try {
    if (!AF.mode) throw new Error("Modo do aplicativo ausente ou inválido. Confira app-mode.js antes de continuar.");
    const host = global.location && global.location.hostname;
    const local = host === "localhost" || host === "127.0.0.1";
    let emulate = local && (new URLSearchParams(global.location.search).get("emulators") === "1" || String(config && config.projectId).startsWith("demo-"));
    try {
      emulate = emulate || (local && global.sessionStorage.getItem("af-emulators") === "1");
      if (emulate) global.sessionStorage.setItem("af-emulators", "1");
    } catch (_) { /* O pedido explícito continua válido mesmo sem sessionStorage. */ }
    if (emulate) config = { apiKey: "demo-agendafacil-local-key", projectId: "demo-agendafacil", authDomain: "demo-agendafacil.firebaseapp.com", appId: "1:123:web:local" };
    if (!local && String(config && config.projectId).startsWith("demo-")) throw new Error("Configuração local não pode ser usada no site publicado.");
    if (!configIsValid(config)) throw new Error("FIREBASE_CONFIG ausente ou com placeholder.");
    AF.projectId = config.projectId;
    if (LEGACY_PROJECTS.includes(config.projectId)) {
      throw new Error(`firebase-config.js aponta para o projeto antigo (${config.projectId}). Use a configuração web do projeto deste ambiente.`);
    }
    const fb = global.firebase;
    fb.initializeApp(config);
    AF.auth = fb.auth();
    AF.db = fb.firestore();
    AF.functions = fb.functions();
    AF.FieldValue = fb.firestore.FieldValue;

    // A configuração é demo antes de inicializar; falha de conexão nunca cai na nuvem.
    if (emulate) {
      AF.auth.useEmulator("http://127.0.0.1:9099");
      AF.db.useEmulator("127.0.0.1", 8080);
      AF.functions.useEmulator("127.0.0.1", 5001);
    }

    // App Check (opcional até o staging): só ativa se a chave estiver configurada e o SDK carregado.
    // Em localhost usa token de depuração (registre-o no console do Firebase antes de testar).
    try {
      const appCheckKey = global.APPCHECK_SITE_KEY;
      if (!emulate && appCheckKey && typeof fb.appCheck === "function") {
        if (local) global.self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        fb.appCheck().activate(appCheckKey, true);
        AF.appCheck = true;
      } else if (!emulate && appCheckKey) {
        console.warn("APPCHECK_SITE_KEY definida, mas o SDK do App Check não foi carregado nesta página.");
      }
    } catch (err) {
      console.warn("App Check não ativou:", err);
    }

    // Sessão persistente entre abas e reinícios do navegador.
    AF.auth.setPersistence(fb.auth.Auth.Persistence.LOCAL).catch((err) => console.warn("Persistência de sessão:", err));
    AF.ready = true;
  } catch (err) {
    AF.initError = err && err.message ? err.message : String(err);
    console.error("Firebase não inicializou:", err);
  }

  // Resolve com o usuário logado; sem sessão, redireciona para o login e nunca resolve.
  AF.requireUser = function requireUser() {
    return new Promise((resolve) => {
      if (!AF.ready) {
        AF.go("login.html");
        return;
      }
      const stop = AF.auth.onAuthStateChanged((user) => {
        stop();
        if (user) {
          resolve(user);
        } else {
          const here = global.location.pathname.split("/").pop() + global.location.search;
          AF.go("login.html?next=" + encodeURIComponent(here));
        }
      });
    });
  };

  AF.redirectIfSignedIn = function redirectIfSignedIn(target) {
    if (!AF.ready) return;
    const stop = AF.auth.onAuthStateChanged((user) => {
      stop();
      if (user) AF.go(target);
    });
  };

  AF.signOut = async function signOut() {
    if (AF.ready) await AF.auth.signOut();
    AF.go("login.html");
  };

  global.AF = AF;
})(window);
