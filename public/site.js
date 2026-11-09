// Configuração do Firebase: firebase-config.js (única para todo o projeto).
// Esta página é pública e só lê publicSites/{slug}; não usa login.
let firebaseConfig = window.FIREBASE_CONFIG;
let db = null;
try {
  const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  let emulate = local && (new URLSearchParams(window.location.search).get("emulators") === "1" || String(firebaseConfig && firebaseConfig.projectId).startsWith("demo-"));
  try { emulate = emulate || (local && window.sessionStorage.getItem("af-emulators") === "1"); } catch (_) {}
  if (emulate) firebaseConfig = { apiKey: "demo-agendafacil-local-key", projectId: "demo-agendafacil", appId: "1:123:web:local" };
  if (!local && String(firebaseConfig && firebaseConfig.projectId).startsWith("demo-")) throw new Error("Configuração local não pode ser usada no site publicado.");
  if (!firebaseConfig || /COLOQUE_AQUI/i.test(firebaseConfig.apiKey || "")) throw new Error("FIREBASE_CONFIG ausente ou com placeholder");
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  if (emulate) db.useEmulator("127.0.0.1", 8080);
} catch (err) {
  db = null;
  console.error("Firebase não inicializou:", err);
}

function getSlugFromPath() {
  return window.AgendaFacilRender.parseSlugFromPath(window.location.pathname);
}

function showNotFound(message) {
  document.getElementById("site-loading").hidden = true;
  const notFound = document.getElementById("site-not-found");
  notFound.hidden = false;
  if (message) notFound.querySelector("p").textContent = message;
}

async function init() {
  const slug = getSlugFromPath();
  if (!slug) {
    showNotFound(
      "Esse link não tem o formato .../s/nome-do-site. Se você abriu o " +
      "arquivo direto (file://) ou de dentro do .zip, é esperado não " +
      "funcionar: essa página só resolve o endereço certo rodando pelo " +
      "Firebase Hosting — emulador (firebase emulators:start) ou depois do deploy."
    );
    return;
  }
  if (!db) {
    showNotFound("Não consegui conectar ao Firebase. Confira o firebase-config.js.");
    return;
  }
  try {
    const snap = await window.AgendaFacilRender.withTimeout(
      db.collection("publicSites").doc(slug).get(),
      8000,
      "tempo esgotado falando com o Firebase"
    );
    if (!snap.exists) {
      showNotFound();
      return;
    }

    const config = snap.data();
    const site = document.getElementById("site-preview");
    window.AgendaFacilRender.renderSiteInto(site, config);
    document.title = `${config.name || "Site"} — Feito com AgendaFácil`;

    // O agendamento em si (cliente escolhendo um horário de verdade) ainda
    // não existe — é a próxima etapa depois de endereço real + pagamento real.
    const comingSoon = () => alert("Agendamento chegando em breve! Por enquanto, fale direto com o negócio.");
    document.getElementById("hero-cta").addEventListener("click", comingSoon);
    document.getElementById("preview-booking-button").addEventListener("click", comingSoon);

    document.getElementById("site-loading").hidden = true;
    site.hidden = false;
  } catch (err) {
    console.error(err);
    showNotFound("Não consegui carregar esse site agora (Firebase não respondeu). Confira a configuração.");
  }
}

init();
