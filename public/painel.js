// Painel do cliente: sites do usuário + estado REAL da assinatura de cada um (vindo do servidor).
// O navegador só apresenta o estado e chama as Functions; nunca confirma pagamento nem publica nada.
(async function () {
  const $ = (s) => document.querySelector(s);
  const R = window.AgendaFacilRender;
  const list = $("#site-list");
  const CHECKOUT_URL = /^https:\/\/([a-z0-9-]+\.)*mercadopago\.com(\.[a-z]{2})?\//i;
  let sites = [];
  let subs = new Map();
  const loaded = { sites: false, subs: false };
  const spark = AF.mode === "spark";

  function say(text) {
    const el = $("#panel-message");
    el.textContent = text;
    el.hidden = !text;
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
    for (const child of children || []) node.append(child);
    return node;
  }

  const dateOf = (ms) => (typeof ms === "number" ? new Date(ms).toLocaleDateString("pt-BR") : "—");
  const REASONS = {
    grace_expired: "falta de pagamento (a carência de 7 dias terminou)",
    payment_failed: "falta de pagamento (o Mercado Pago encerrou as tentativas)",
    refund: "estorno do pagamento",
    chargeback: "contestação do pagamento",
  };

  // Estado exibido = o que o servidor gravou (site + assinatura). Nada é inferido no navegador.
  function describe(site, sub) {
    const now = Date.now();
    const status = sub ? sub.status : "none";
    if (!sub || status === "none") return { label: "Rascunho", css: "", note: spark ? "Rascunho salvo na sua conta. Publicar exige Cloud Functions (plano Blaze)." : "Ainda sem assinatura.", kind: "draft" };
    if (status === "pending") return { label: "Aguardando pagamento", css: "pending", note: "Conclua a assinatura no Mercado Pago. O site é publicado quando o primeiro pagamento for confirmado.", kind: "pending" };
    if (status === "active") return { label: "Assinatura ativa", css: "published", note: `Paga até ${dateOf(sub.currentPeriodEnd)}. Próxima cobrança: ${dateOf(sub.nextPaymentDate || sub.currentPeriodEnd)}. Renovação automática pelo Mercado Pago.`, kind: "active" };
    if (status === "past_due") return { label: "Pagamento em atraso", css: "pending", note: `O Mercado Pago está tentando cobrar de novo. Seu site continua no ar até ${dateOf(sub.accessUntil)}; depois disso é suspenso.`, kind: "past_due" };
    if (status === "suspended") return { label: "Suspenso", css: "", note: `Motivo: ${REASONS[sub.statusReason] || "pagamento"}. Seus dados estão guardados; o site volta ao ar quando o pagamento for confirmado.`, kind: "suspended" };
    if (status === "cancelled") {
      const still = typeof sub.accessUntil === "number" && sub.accessUntil > now && site.published;
      return { label: still ? "Cancelada (no ar até o fim do período)" : "Cancelada", css: "", note: still ? `Seu site continua no ar até ${dateOf(sub.accessUntil)}.` : "Seus dados estão guardados. Você pode assinar de novo quando quiser.", kind: still ? "cancelled_active" : "cancelled" };
    }
    return { label: status, css: "", note: "", kind: "other" };
  }

  async function call(name, data, okMessage) {
    try {
      const result = await AF.functions.httpsCallable(name)(data);
      if (okMessage) say(okMessage);
      return result.data;
    } catch (err) {
      console.error(err);
      say(err && err.message && err.code !== "functions/internal" ? err.message : "Não foi possível concluir agora. Tente de novo em instantes.");
      return null;
    }
  }

  async function subscribe(siteId) {
    const data = await call("createSubscription", { siteId });
    if (data && typeof data.initPoint === "string" && CHECKOUT_URL.test(data.initPoint)) AF.navigate(data.initPoint);
  }

  function button(text, handler, secondary) {
    const b = el("button", { class: "btn" + (secondary ? " secondary" : ""), type: "button", text });
    b.addEventListener("click", handler);
    return b;
  }

  function card(id, site) {
    const sub = site.subscriptionId ? subs.get(site.subscriptionId) : null;
    const info = describe(site, sub);
    const actions = el("div", { class: "site-actions" });
    const edit = () => el("a", { class: "btn secondary", href: `editor.html?site=${encodeURIComponent(id)}`, text: "Continuar editando" });

    let publicUrl = null;
    if (site.published && typeof site.publishedSlug === "string") {
      const path = `/s/${encodeURIComponent(site.publishedSlug)}`;
      publicUrl = `${location.origin}${path}`;
      actions.append(el("a", { class: "btn", href: path, target: "_blank", rel: "noopener", text: "Abrir site" }));
      actions.append(button("Copiar link", async () => {
        try { await navigator.clipboard.writeText(publicUrl); say("Link copiado."); } catch { say(publicUrl); }
      }, true));
      actions.append(el("a", { class: "btn secondary", href: `editor.html?site=${encodeURIComponent(id)}`, text: site.publishedHash && site.publishedHash !== site.contentHash ? "Editar (há alterações não publicadas)" : "Editar site" }));
    }
    if (info.kind === "draft") {
      actions.append(edit());
      actions.append(button("Excluir rascunho", () => removeDraft(id, site), true));
    } else if (spark) {
      // Sem Cloud Functions não há como assinar, sincronizar ou cancelar: só mostramos o que funciona.
      if (!site.published) actions.append(edit());
    } else {
    if (info.kind === "pending") {
      if (sub.initPoint && CHECKOUT_URL.test(sub.initPoint)) actions.append(button("Concluir assinatura", () => AF.navigate(sub.initPoint)));
      actions.append(button("Já paguei — atualizar", async () => { await call("syncSubscription", { siteId: id }, "Status atualizado."); }, true), edit());
    }
    if (info.kind === "active" || info.kind === "past_due") {
      actions.append(button("Cancelar assinatura", async () => {
        if (!window.confirm(`Cancelar a assinatura de "${site.name}"? O site continua no ar até o fim do período já pago.`)) return;
        await call("cancelSubscription", { siteId: id }, "Assinatura cancelada. O site continua no ar até o fim do período pago.");
      }, true));
    }
    if (info.kind === "suspended") {
      actions.append(button("Atualizar status", async () => { await call("syncSubscription", { siteId: id }, "Status atualizado."); }), button("Assinar de novo", () => subscribe(id), true), edit());
    }
    if (info.kind === "cancelled" || info.kind === "cancelled_active") {
      actions.append(button("Assinar de novo", () => subscribe(id)));
      if (!site.published) actions.append(edit());
    }
    }

    return el("article", { class: "site-card" }, [
      el("span", { class: `badge ${info.css}`, text: info.label }),
      el("h2", { text: typeof site.name === "string" && site.name ? site.name : "Sem nome" }),
      el("small", { text: `${R.getSegment(site).label} · endereço /s/${site.published ? site.publishedSlug || site.slug || "" : R.slugify(site.name)}` }),
      publicUrl ? el("a", { class: "site-url", href: publicUrl, target: "_blank", rel: "noopener", text: publicUrl }) : el("small", { text: "Ainda não publicado." }),
      el("small", { text: info.note }),
      el("small", { text: `Atualizado: ${site.updatedAt && site.updatedAt.toDate ? site.updatedAt.toDate().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"}` }),
      actions,
    ]);
  }

  async function removeDraft(id, site) {
    if (!window.confirm(`Excluir o rascunho "${site.name}"? Essa ação não pode ser desfeita.`)) return;
    try {
      await window.AgendaFacilStore.deleteDraft({ db: AF.db, siteId: id });
      say("Rascunho excluído.");
    } catch (err) {
      console.error(err);
      say(err && err.code === "permission-denied" ? "Este site não pode ser excluído aqui (está publicado ou tem assinatura)." : "Não foi possível excluir o rascunho agora.");
    }
  }

  // Plano Spark: sem Functions, a exclusão da conta é feita aqui, pelo próprio usuário (apaga os rascunhos e a conta).
  async function deleteAccountDirect(typed, user) {
    if (typed !== "EXCLUIR") return say("Digite EXCLUIR para confirmar a exclusão da conta.");
    if (sites.some((s) => s.data.published || s.data.subscriptionId)) return say("Há site publicado ou com assinatura. Encerre-os antes (exige o plano Blaze).");
    try {
      for (const s of sites) await window.AgendaFacilStore.deleteDraft({ db: AF.db, siteId: s.id });
      await user.delete();
      AF.go("login.html");
    } catch (err) {
      console.error(err);
      say(err && err.code === "auth/requires-recent-login" ? "Por segurança, saia, entre novamente e tente excluir a conta de novo." : "Não foi possível excluir a conta agora. Seus rascunhos podem já ter sido apagados; tente de novo.");
    }
  }

  function render() {
    if (!(loaded.sites && loaded.subs)) return;
    $("#loading-state").hidden = true;
    list.replaceChildren();
    const sorted = [...sites].sort((a, b) => (b.data.updatedAt ? b.data.updatedAt.toMillis() : 0) - (a.data.updatedAt ? a.data.updatedAt.toMillis() : 0));
    for (const s of sorted) list.append(card(s.id, s.data));
    $("#empty-state").hidden = sorted.length > 0;
  }

  if (!AF.ready) {
    say("O Firebase não iniciou: " + (AF.initError || "confira public/firebase-config.js") + ".");
    return;
  }

  const user = await AF.requireUser(); // sem sessão, redireciona para o login
  $("#user-email").textContent = user.email || "";
  $("#env-info").textContent = `Projeto: ${AF.projectId || "?"} · modo ${spark ? "Spark" : "Blaze"}`;
  $("#logout-button").addEventListener("click", () => AF.signOut());

  function updateVerifyBanner() {
    $("#verify-banner").hidden = user.emailVerified;
    $("#verify-email").textContent = user.email || "";
  }
  updateVerifyBanner();
  $("#resend-verification").addEventListener("click", async () => {
    try {
      await user.sendEmailVerification();
      say("E-mail de confirmação reenviado. Confira a caixa de entrada e o spam.");
    } catch (err) {
      say(AF.mapAuthError(err));
    }
  });
  $("#check-verification").addEventListener("click", async () => {
    try {
      await user.reload();
      await user.getIdToken(true); // atualiza o claim email_verified usado pelas Cloud Functions
      updateVerifyBanner();
      say(user.emailVerified ? "E-mail confirmado!" : "Ainda não confirmado. Clique no link do e-mail e tente de novo.");
    } catch (err) {
      say(AF.mapAuthError(err));
    }
  });

  const onError = (err) => {
    console.error(err);
    $("#loading-state").hidden = true;
    say("Não foi possível carregar seus sites agora. Tente recarregar a página.");
  };
  // Consultas restritas ao dono (as regras do Firestore exigem ownerUid == uid).
  AF.db.collection("sites").where("ownerUid", "==", user.uid).onSnapshot((snap) => { sites = snap.docs.map((d) => ({ id: d.id, data: d.data() })); loaded.sites = true; render(); }, onError);
  AF.db.collection("subscriptions").where("ownerUid", "==", user.uid).onSnapshot((snap) => { subs = new Map(snap.docs.map((d) => [d.id, d.data()])); loaded.subs = true; render(); }, onError);

  // Exclusão de conta: confirmação digitada + login recente (validados também no servidor).
  $("#delete-account").addEventListener("click", async () => {
    const typed = window.prompt("Para excluir sua conta e todos os seus sites, digite EXCLUIR:");
    if (typed === null) return;
    if (spark) return deleteAccountDirect(typed, user);
    const data = await call("deleteAccount", { confirm: typed });
    if (data && data.deleted) {
      await AF.auth.signOut().catch(() => {});
      AF.go("login.html");
    }
  });

  // Volta do checkout do Mercado Pago: consulta o estado atual (o webhook pode demorar alguns instantes).
  const params = new URLSearchParams(location.search);
  if (!spark && params.get("assinatura") === "retorno") {
    history.replaceState(null, "", "painel.html");
    say("Atualizando o status da sua assinatura…");
    try {
      const snap = await AF.db.collection("sites").where("ownerUid", "==", user.uid).get();
      const pending = snap.docs.filter((d) => d.data().subscriptionStatus === "pending");
      for (const d of pending) await AF.functions.httpsCallable("syncSubscription")({ siteId: d.id }).catch((e) => console.warn(e));
      say("Pronto. Se o pagamento ainda não aparece, aguarde alguns instantes e use “Já paguei — atualizar”.");
    } catch (err) {
      onError(err);
    }
  }
})();
