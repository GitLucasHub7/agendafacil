// Firebase, Auth e configuração pública vêm de firebase-config.js + auth-shared.js (window.AF).
// A3: a verificação antiga comparava a chave com ela mesma (sempre falsa) e bloqueava o checkout.
const db = AF.db;
const functionsClient = AF.functions;
const firebaseReady = AF.ready;
let currentUser = null;
let currentSiteId = null;
let currentSlug = null;
let hasUnpublishedChanges = false;
let savePromise = Promise.resolve();
let saveTimer = null;
const defaultConfig = {
  segment: "barbershop",
  name: "Maicon do Corte",
  primary: "#C89B3C",
  background: "#161514",
  logo: "initial",
  logoImage: "",
  schedule: "semanal",
  work: "solo",
  start: "09:00",
  end: "20:00",
  interval: "30",
  published: false,
};

// Site novo começa SEM nome (o exemplo "Maicon do Corte" faria todos disputarem o mesmo endereço).
let config = { ...defaultConfig, name: "" };
let currentStep = 1;
let toastTimer;

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const { getSegment: sharedGetSegment, getLogoMarkup: sharedGetLogoMarkup, renderSiteInto } = window.AgendaFacilRender;

function getSegment() {
  return sharedGetSegment(config);
}

function slugify(value) {
  return window.AgendaFacilRender.slugify(value) || "meu-negocio";
}

function setText(selector, text) {
  const element = $(selector);
  if (element) element.textContent = text;
}

function siteAddress(slug) {
  // Funciona com ou sem domínio próprio: hoje em *.web.app, amanhã no seu domínio.
  return `${window.location.origin}/s/${slug}`;
}

function renderPreview() {
  const site = $("#site-preview");
  renderSiteInto(site, config);
  document.title = `${config.name || "Meu negócio"} — Criador de sites | AgendaFácil`;
  const slug = slugify(config.name);
  setText("#published-address", slug);
}

function updateBuilderControls() {
  $$(".segment-card").forEach(button => button.classList.toggle("selected", button.dataset.segment === config.segment));
  $$(".logo-choice").forEach(button => button.classList.toggle("selected", button.dataset.logo === config.logo));
  $$(".color-dot").forEach(button => button.classList.toggle("selected", button.dataset.color.toLowerCase() === config.primary.toLowerCase()));
  $$(".background-choice").forEach(button => button.classList.toggle("selected", button.dataset.background.toLowerCase() === config.background.toLowerCase()));
  $$("[data-schedule]").forEach(button => button.classList.toggle("selected", button.dataset.schedule === config.schedule));
  $$("[data-work]").forEach(button => button.classList.toggle("selected", button.dataset.work === config.work));
  $("#business-name").value = config.name;
  $("#name-field-icon").textContent = getSegment().icon;
  $("#primary-color").value = config.primary;
  $("#work-start").value = config.start;
  $("#work-end").value = config.end;
  $("#work-interval").value = config.interval;
}

function showStep(step) {
  currentStep = Math.max(1, Math.min(4, step));
  $$(".builder-step").forEach(section => {
    const selected = Number(section.dataset.step) === currentStep;
    section.hidden = !selected;
    section.classList.toggle("active", selected);
  });
  $$(".step-link").forEach(link => {
    const value = Number(link.dataset.stepLink);
    link.classList.toggle("active", value === currentStep);
    link.classList.toggle("done", value < currentStep);
  });
  const percent = `${currentStep * 25}%`;
  $("#progress-bar").style.width = percent;
  $("#mobile-progress").style.width = percent;
  setText("#progress-label", `PASSO ${currentStep} DE 4`);
  setText("#mobile-step-number", `${currentStep}/4`);
  $("#back-button").hidden = currentStep === 1;
  $("#next-button").hidden = currentStep === 4;
  renderPreview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateConfig(partial) {
  config = { ...config, ...partial };
  scheduleSave();
  updateBuilderControls();
  renderPreview();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

function updatePublicationState() {
  const button = $("#publish-button");
  const banner = $("#published-banner");
  if (!config.published) {
    if (banner) banner.hidden = true;
    return;
  }
  // Site no ar: o botão publica as ALTERAÇÕES (a URL e a assinatura continuam as mesmas).
  button.innerHTML = hasUnpublishedChanges ? "Publicar alterações <span>→</span>" : "Tudo publicado <span>✓</span>";
  button.disabled = !hasUnpublishedChanges;
  button.style.opacity = hasUnpublishedChanges ? "1" : ".75";
  if (banner) {
    banner.hidden = false;
    banner.textContent = hasUnpublishedChanges
      ? "Seu site está no ar. Suas alterações só aparecem para os visitantes depois de clicar em “Publicar alterações”."
      : "Seu site está no ar e atualizado.";
  }
}

async function publishChanges() {
  const button = $("#publish-button");
  button.disabled = true;
  try {
    clearTimeout(saveTimer);
    await saveDraft();
    const result = await window.AgendaFacilRender.withTimeout(functionsClient.httpsCallable("publishChanges")({ siteId: currentSiteId }), 20000, "tempo esgotado publicando");
    hasUnpublishedChanges = Boolean(result.data.hasUnpublishedChanges);
    showToast("Alterações publicadas!");
  } catch (err) {
    console.error(err);
    showToast(err && err.code === "functions/failed-precondition" && err.message ? err.message : "Não consegui publicar as alterações agora. Tente de novo.");
  } finally {
    updatePublicationState();
  }
}

const SITE_FIELDS = ["segment", "name", "primary", "background", "logo", "logoImage", "schedule", "work", "start", "end", "interval"];

function siteFieldsOf(source) {
  const out = {};
  for (const key of SITE_FIELDS) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function setSaveStatus(text) {
  const el = $("#save-status");
  if (el) el.textContent = text;
}

// Como o rascunho é gravado depende do plano (public/app-mode.js):
//  - "blaze": pela Cloud Function saveSite (valida no servidor e usa o uid da sessão como dono);
//  - "spark": direto no Firestore pelo dono, com as regras (firestore.rules) validando posse e campos.
// Em ambos, só CONTEÚDO é gravado; publicação, assinatura e pagamento são sempre estado do servidor.
// As gravações são enfileiradas para nunca criar dois sites por causa de duas chamadas simultâneas.
async function persistDraft() {
  if (AF.mode === "spark") {
    return window.AgendaFacilStore.saveDraftDirect({ db, FieldValue: AF.FieldValue, uid: currentUser.uid, siteId: currentSiteId || undefined, site: siteFieldsOf(config), published: config.published });
  }
  const saveSite = functionsClient.httpsCallable("saveSite");
  const result = await window.AgendaFacilRender.withTimeout(saveSite({ siteId: currentSiteId || undefined, site: siteFieldsOf(config) }), 15000, "tempo esgotado salvando o site");
  return result.data;
}

let lastSaveError = { message: "", at: 0 };
// Mostra a CAUSA real e evita repetir o mesmo aviso a cada edição (o autosave tenta de novo na próxima alteração).
function reportSaveError(err) {
  console.error("Falha ao salvar o rascunho:", err && err.code, err);
  const message = window.AgendaFacilStore.describeSaveError(err, AF.mode);
  setSaveStatus("Não salvo");
  const status = $("#save-status");
  if (status) status.title = message;
  const now = Date.now();
  if (message !== lastSaveError.message || now - lastSaveError.at > 20000) {
    showToast(message);
    lastSaveError = { message, at: now };
  }
  return message;
}

function saveDraft() {
  savePromise = savePromise.catch(() => {}).then(async () => {
    setSaveStatus("Salvando…");
    const data = await persistDraft();
    currentSiteId = data.siteId;
    currentSlug = data.slug;
    if (config.published) {
      hasUnpublishedChanges = Boolean(data.hasUnpublishedChanges);
      updatePublicationState();
    }
    if (!new URLSearchParams(location.search).get("site")) {
      history.replaceState(null, "", `editor.html?site=${encodeURIComponent(currentSiteId)}`);
    }
    const status = $("#save-status");
    if (status) status.title = "";
    setSaveStatus("Salvo ✓");
    return data;
  });
  savePromise.catch(reportSaveError);
  return savePromise;
}

function hasValidName() {
  return typeof config.name === "string" && config.name.trim().length >= 3;
}

function scheduleSave() {
  if (!firebaseReady || !currentUser) return;
  clearTimeout(saveTimer);
  if (config.published) {
    hasUnpublishedChanges = true; // o botão já oferece "Publicar alterações" enquanto o salvamento não termina
    updatePublicationState();
  }
  if (!hasValidName()) { setSaveStatus("Dê um nome ao negócio para salvar"); return; }
  setSaveStatus("Alterações não salvas");
  saveTimer = setTimeout(() => { saveDraft().catch(() => {}); }, 2000);
}

function updateVerifyNotice() {
  const needs = Boolean(currentUser) && !currentUser.emailVerified;
  $("#verify-notice").hidden = !needs;
  $("#start-subscription").disabled = needs;
}

// Só navega para o checkout hospedado do Mercado Pago (https, domínio mercadopago.*).
const CHECKOUT_URL = /^https:\/\/([a-z0-9-]+\.)*mercadopago\.com(\.[a-z]{2})?\//i;

const SPARK_PUBLISH_MESSAGE = "Seu rascunho está salvo. Publicar o site e assinar pelo Mercado Pago exigem Cloud Functions (plano Blaze), indisponíveis no plano Spark.";

async function openCheckout() {
  if (AF.mode === "spark") {
    showToast(SPARK_PUBLISH_MESSAGE);
    return;
  }
  if (config.published) return publishChanges();
  if (!firebaseReady || !currentUser) {
    showToast("Não foi possível conectar à sua conta. Recarregue a página e entre novamente.");
    return;
  }
  if (!hasValidName()) {
    showStep(1);
    showToast("Dê um nome ao seu negócio (mínimo de 3 caracteres) antes de publicar.");
    return;
  }
  const publishButton = $("#publish-button");
  publishButton.disabled = true;
  try {
    clearTimeout(saveTimer);
    const saved = await saveDraft();
    if (!saved.slugAvailable) {
      showToast("Esse nome já está em uso por outro site publicado. Tente um nome diferente.");
      return;
    }
    $("#payer-email").value = currentUser.email || "";
    updateVerifyNotice();
    $("#checkout-modal").showModal();
  } catch (err) {
    // saveDraft já mostrou a causa (reportSaveError); aqui só garantimos o registro no console.
    console.error(err);
  } finally {
    publishButton.disabled = false;
  }
}

async function startSubscription() {
  if (!currentSiteId || !currentUser) {
    showToast("Salve o site antes de assinar.");
    return;
  }
  const button = $("#start-subscription");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Abrindo o Mercado Pago…";
  try {
    // Confirma o e-mail antes: o servidor exige e-mail verificado (claim atualizado no token).
    if (!currentUser.emailVerified) {
      await currentUser.reload();
      await currentUser.getIdToken(true);
      updateVerifyNotice();
      if (!currentUser.emailVerified) {
        showToast("Confirme seu e-mail para assinar.");
        return;
      }
    }
    const createSubscription = functionsClient.httpsCallable("createSubscription");
    // Só o siteId vai ao servidor; preço, periodicidade, e-mail e posse são definidos lá.
    const result = await window.AgendaFacilRender.withTimeout(createSubscription({ siteId: currentSiteId }), 20000, "tempo esgotado iniciando a assinatura");
    if (result.data && result.data.processing) {
      showToast("Estamos confirmando sua assinatura. Aguarde um pouco antes de tentar novamente.");
      return;
    }
    const initPoint = result.data && result.data.initPoint;
    if (typeof initPoint !== "string" || !CHECKOUT_URL.test(initPoint)) throw new Error("link de checkout inesperado");
    AF.navigate(initPoint);
  } catch (err) {
    console.error(err);
    const code = err && err.code;
    if (code === "functions/already-exists") showToast("Esse endereço já está em uso. Escolha outro nome para o negócio.");
    else if (code === "functions/failed-precondition") showToast(err.message || "Confirme seu e-mail para assinar.");
    else showToast("Não consegui iniciar a assinatura agora. Tente de novo em instantes.");
  } finally {
    button.textContent = "Assinar e continuar no Mercado Pago →";
    updateVerifyNotice();
  }
}

function setLogo(type) {
  updateConfig({ logo: type, logoImage: type === "upload" ? config.logoImage : "" });
}

function bindEvents() {
  $$(".segment-card").forEach(button => button.addEventListener("click", () => updateConfig({ segment: button.dataset.segment })));
  $("#business-name").addEventListener("input", event => updateConfig({ name: event.target.value }));
  $$(".logo-choice").forEach(button => button.addEventListener("click", () => setLogo(button.dataset.logo)));
  $("#logo-upload").addEventListener("change", event => {
    const [file] = event.target.files;
    if (!file) return;
    if (file.size > 500_000) { showToast("Use uma logo com até 500 KB (PNG, JPG ou WebP)."); return; }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { showToast("Formato não aceito. Use PNG, JPG ou WebP."); return; }
    const reader = new FileReader();
    reader.addEventListener("load", () => updateConfig({ logo: "upload", logoImage: reader.result }));
    reader.readAsDataURL(file);
  });
  $$(".color-dot").forEach(button => button.addEventListener("click", () => updateConfig({ primary: button.dataset.color })));
  $("#primary-color").addEventListener("input", event => updateConfig({ primary: event.target.value }));
  $$(".background-choice").forEach(button => button.addEventListener("click", () => updateConfig({ background: button.dataset.background })));
  $$("[data-schedule]").forEach(button => button.addEventListener("click", () => updateConfig({ schedule: button.dataset.schedule })));
  $$("[data-work]").forEach(button => button.addEventListener("click", () => updateConfig({ work: button.dataset.work })));
  $("#work-start").addEventListener("change", event => updateConfig({ start: event.target.value }));
  $("#work-end").addEventListener("change", event => updateConfig({ end: event.target.value }));
  $("#work-interval").addEventListener("change", event => updateConfig({ interval: event.target.value }));

  $("#next-button").addEventListener("click", () => showStep(currentStep + 1));
  $("#back-button").addEventListener("click", () => showStep(currentStep - 1));
  $$(".step-link").forEach(button => button.addEventListener("click", () => {
    const step = Number(button.dataset.stepLink);
    if (step <= currentStep) showStep(step);
  }));

  $("#copy-link").addEventListener("click", async () => {
    const link = siteAddress(currentSlug || slugify(config.name));
    try { await navigator.clipboard.writeText(link); } catch { /* O botão mantém o retorno visual em prévias locais. */ }
    showToast(config.published ? "Endereço copiado. Você já pode compartilhar!" : "Endereço copiado. Ele fica ativo assim que você publicar.");
  });
  $("#publish-button").addEventListener("click", openCheckout);
  $("#start-subscription").addEventListener("click", startSubscription);
  $("#close-checkout").addEventListener("click", () => $("#checkout-modal").close());
  $("#help-button").addEventListener("click", () => showToast("Dica: escolha as opções e veja a prévia mudar ao vivo."));
  $("#preview-booking-button").addEventListener("click", () => showToast("Na versão publicada, os clientes escolherão o horário aqui."));
  $("#expand-preview").addEventListener("click", () => {
    $("#modal-preview-copy").innerHTML = $("#site-preview").outerHTML;
    $("#preview-modal").showModal();
  });
  $("#close-preview").addEventListener("click", () => $("#preview-modal").close());
}

const SAFE_ID = /^[A-Za-z0-9]{10,40}$/;

async function loadSiteFromUrl() {
  const id = new URLSearchParams(location.search).get("site");
  if (!id) return;
  if (!SAFE_ID.test(id)) { AF.go("painel.html"); return new Promise(() => {}); }
  const snap = await db.collection("sites").doc(id).get(); // as regras só deixam o dono ler
  if (!snap.exists) { AF.go("painel.html"); return new Promise(() => {}); }
  const data = snap.data();
  config = { ...defaultConfig, ...siteFieldsOf(data), published: Boolean(data.published) };
  hasUnpublishedChanges = Boolean(data.published) && data.publishedHash !== data.contentHash;
  currentSiteId = id;
  currentSlug = data.slug || null;
}

async function init() {
  updateBuilderControls();
  renderPreview();
  bindEvents();
  if (!firebaseReady) {
    const message = AF.initError || "Firebase não configurado neste ambiente.";
    showToast(message);
    const notice = $("#mode-notice");
    notice.hidden = false;
    notice.textContent = message;
    for (const id of ["#save-button", "#publish-button", "#start-subscription"]) {
      const button = $(id);
      if (button) button.disabled = true;
    }
    return;
  }
  currentUser = await AF.requireUser(); // sem sessão: vai para o login e volta aqui
  try {
    await loadSiteFromUrl();
  } catch (err) {
    console.error(err);
    showToast("Não consegui abrir esse site agora.");
  }
  $("#logout-button").addEventListener("click", () => AF.signOut());
  $("#resend-verification").addEventListener("click", async () => {
    try { await currentUser.sendEmailVerification(); showToast("E-mail de confirmação reenviado."); }
    catch (err) { showToast(AF.mapAuthError(err)); }
  });
  updateBuilderControls();
  renderPreview();
  updatePublicationState();
  applyModeNotice();
}

// Deixa claro, na própria tela, em que ambiente/plano o app está rodando (evita gravar no projeto errado sem perceber).
function applyModeNotice() {
  const env = $("#env-info");
  if (env) env.textContent = `Projeto: ${AF.projectId || "?"} · modo ${AF.mode === "spark" ? "Spark" : "Blaze"}`;
  if (AF.mode !== "spark") return;
  const notice = $("#mode-notice");
  if (notice) {
    notice.hidden = false;
    notice.textContent = "Plano Spark: seu rascunho é salvo na sua conta. Publicar o site e assinar exigem Cloud Functions (plano Blaze) e ainda não estão disponíveis. Nada será cobrado.";
  }
  const button = $("#publish-button");
  button.innerHTML = "Publicar (requer plano Blaze) <span>→</span>";
  button.style.opacity = ".75";
}

init();
