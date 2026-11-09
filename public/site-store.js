/*
 * site-store.js — persistência do RASCUNHO do site direto no Firestore (plano Spark, sem Cloud Functions).
 *
 * Segurança: quem decide é o Firestore (firestore.rules): só o dono, só campos de conteúdo, só rascunho (published=false),
 * no máximo 10 sites (ID do documento = <uid>s1..<uid>s10). Nada que seja ESTADO (publicação, assinatura, pagamento,
 * endereço reservado) passa por aqui: o navegador nunca escreve esses campos. A validação abaixo espelha a do servidor
 * (functions/lib/validate.js) só para dar mensagens claras ANTES de gravar; ela não substitui as regras.
 */
(function (global) {
  const CONTENT_FIELDS = ["segment", "name", "primary", "background", "logo", "logoImage", "schedule", "work", "start", "end", "interval"];
  const SEGMENTS = ["barbershop", "nails", "salon", "aesthetics", "tattoo", "other"];
  const ICON_LOGOS = ["initial", "scissors", "star"];
  const SCHEDULES = ["semanal", "mensal"];
  const WORKS = ["solo", "team"];
  const INTERVALS = ["30", "45", "60"];
  const RESERVED = ["s", "api", "admin", "painel", "editor", "login", "entrar", "app", "www"];
  const MAX_SITES = 10;
  const MAX_LOGO_CHARS = 700000;
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const LOGO_DATA = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])$/;
  const UID = /^[A-Za-z0-9]{20,36}$/;

  class DraftError extends Error {
    constructor(message, code, field) {
      super(message);
      this.name = "DraftError";
      this.code = code || "draft/invalid";
      this.field = field || null;
    }
  }
  const bad = (message, field) => new DraftError(message, "draft/invalid", field);

  function validateDraft(site) {
    if (!site || typeof site !== "object" || Array.isArray(site)) throw bad("Dados do site inválidos.");
    for (const key of Object.keys(site)) if (!CONTENT_FIELDS.includes(key)) throw bad(`Campo não permitido: ${key}.`, key);
    if (!SEGMENTS.includes(site.segment)) throw bad("Escolha o tipo do negócio.", "segment");

    if (typeof site.name !== "string") throw bad("Informe o nome do negócio.", "name");
    const name = site.name.replace(/\s+/g, " ").trim();
    if (name.length < 1 || name.length > 45) throw bad("O nome deve ter de 1 a 45 caracteres.", "name");
    if (/[\p{Cc}\p{Cf}]/u.test(name)) throw bad("O nome contém caracteres inválidos.", "name");
    const slug = global.AgendaFacilRender.slugify(name);
    if (!SLUG.test(slug) || RESERVED.includes(slug)) throw bad("Use um nome com ao menos 3 letras ou números e que não seja reservado.", "name");

    if (!HEX.test(String(site.primary))) throw bad("Cor principal inválida.", "primary");
    if (!HEX.test(String(site.background))) throw bad("Cor de fundo inválida.", "background");

    let logoImage = typeof site.logoImage === "string" ? site.logoImage : "";
    if (site.logo === "upload") {
      if (!logoImage || logoImage.length > MAX_LOGO_CHARS || !LOGO_DATA.test(logoImage)) throw bad("Imagem do logo inválida ou grande demais (máx. ~500 KB; PNG, JPG ou WebP).", "logoImage");
    } else if (ICON_LOGOS.includes(site.logo)) {
      logoImage = "";
    } else {
      throw bad("Logo inválido.", "logo");
    }

    if (!SCHEDULES.includes(site.schedule)) throw bad("Estilo de agenda inválido.", "schedule");
    if (!WORKS.includes(site.work)) throw bad("Tipo de atendimento inválido.", "work");
    if (!TIME.test(String(site.start))) throw bad("Horário inicial inválido.", "start");
    if (!TIME.test(String(site.end))) throw bad("Horário final inválido.", "end");
    if (site.start >= site.end) throw bad("O horário final deve ser depois do inicial.", "end");
    const interval = String(site.interval);
    if (!INTERVALS.includes(interval)) throw bad("Intervalo inválido.", "interval");

    return { segment: site.segment, name, primary: site.primary.toLowerCase(), background: site.background.toLowerCase(), logo: site.logo, logoImage, schedule: site.schedule, work: site.work, start: site.start, end: site.end, interval };
  }

  async function slugIsFree(db, slug, siteId) {
    try {
      const pub = await db.collection("publicSites").doc(slug).get();
      return !(pub.exists && pub.data().siteId !== siteId);
    } catch {
      return true; // melhor esforço: a verificação definitiva acontece no checkout (servidor)
    }
  }

  async function createDraft({ db, FieldValue, uid, clean }) {
    if (!UID.test(String(uid))) throw new DraftError("A identificação da sua conta é incompatível com este recurso.", "draft/uid");
    for (let attempt = 0; attempt < 2; attempt++) {
      const owned = await db.collection("sites").where("ownerUid", "==", uid).get();
      const taken = new Set(owned.docs.map((d) => d.id));
      let slot = null;
      for (let n = 1; n <= MAX_SITES; n++) if (!taken.has(`${uid}s${n}`)) { slot = n; break; }
      if (slot === null) throw new DraftError(`Limite de ${MAX_SITES} sites por conta atingido.`, "draft/limit");
      const id = `${uid}s${slot}`;
      const ts = FieldValue.serverTimestamp();
      try {
        await db.collection("sites").doc(id).set({ ...clean, ownerUid: uid, published: false, paymentStatus: "unpaid", createdAt: ts, updatedAt: ts });
        return id;
      } catch (err) {
        // Outra aba pode ter ocupado o mesmo número ao mesmo tempo: relê a lista e tenta mais uma vez.
        if (attempt === 0 && err && err.code === "permission-denied") continue;
        throw err;
      }
    }
    return null;
  }

  /** Cria (sem siteId) ou atualiza o rascunho do usuário. Mesmo formato de retorno da função saveSite. */
  async function saveDraftDirect({ db, FieldValue, uid, siteId, site, published }) {
    if (published) throw new DraftError("Este site está publicado e só pode ser editado com as Cloud Functions (plano Blaze).", "draft/published");
    const clean = validateDraft(site);
    const slug = global.AgendaFacilRender.slugify(clean.name);
    let id = siteId;
    if (id) await db.collection("sites").doc(id).update({ ...clean, updatedAt: FieldValue.serverTimestamp() });
    else id = await createDraft({ db, FieldValue, uid, clean });
    return { siteId: id, slug, slugAvailable: await slugIsFree(db, slug, id), published: false, hasUnpublishedChanges: false };
  }

  /** Exclui um rascunho (as regras só permitem se não publicado e sem assinatura). */
  async function deleteDraft({ db, siteId }) {
    await db.collection("sites").doc(siteId).delete();
  }

  // Traduz o erro técnico em uma frase que aponta a causa real (e nunca esconde o código no console).
  function describeSaveError(err, mode) {
    const code = String((err && err.code) || "");
    const message = String((err && err.message) || "");
    if (err instanceof DraftError || code.startsWith("draft/")) return err.message;
    if (code === "permission-denied") {
      return mode === "spark"
        ? "O Firestore recusou a gravação (permission-denied). Publique as regras atuais neste projeto (firebase deploy --only firestore:rules) e confira se firebase-config.js é do projeto de desenvolvimento."
        : "O Firestore recusou a gravação (permission-denied). Confira as regras publicadas neste projeto.";
    }
    if (code === "unauthenticated" || code === "functions/unauthenticated") return "Sua sessão expirou. Entre novamente para continuar.";
    if (code === "functions/not-found" || code === "functions/internal") {
      return 'As Cloud Functions não responderam neste projeto (o plano Spark não as suporta). No Spark use window.APP_MODE = "spark" em public/app-mode.js; com o Blaze, implante as Functions.';
    }
    if (code === "functions/resource-exhausted" || code === "functions/invalid-argument" || code === "functions/failed-precondition") return message || "A operação foi recusada pelo servidor.";
    if (code === "resource-exhausted") return "A cota diária gratuita do Firestore (plano Spark) foi atingida. Ela renova no dia seguinte.";
    if (code === "unavailable" || code === "functions/unavailable" || code === "deadline-exceeded" || /tempo esgotado/i.test(message)) return "Sem conexão estável com o Firebase agora. Verifique a internet; vamos tentar de novo na próxima alteração.";
    if (code === "not-found") return "Rascunho não encontrado. Recarregue a página.";
    return `Não consegui salvar agora (${code || "erro desconhecido"}). Detalhes no console do navegador.`;
  }

  global.AgendaFacilStore = { CONTENT_FIELDS, SEGMENTS, ICON_LOGOS, SCHEDULES, WORKS, INTERVALS, RESERVED, MAX_SITES, MAX_LOGO_CHARS, DraftError, validateDraft, saveDraftDirect, deleteDraft, describeSaveError };
})(window);
