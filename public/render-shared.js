/*
 * render-shared.js
 *
 * Única fonte de verdade pra "como um config vira um site na tela".
 * Usado por:
 *   - app.js (prévia ao vivo dentro do construtor)
 *   - site.js (o site publicado de verdade, em /s/{slug})
 *
 * Se um dia mudar como um site é desenhado, muda só aqui.
 */
(function (global) {
  const segments = {
    barbershop: {
      label: "BARBEARIA",
      icon: "✂",
      headline: "O seu estilo,<br><em>no seu tempo.</em>",
      subtitle: "Agende seu horário online, sem complicação.",
      services: [["✂", "Corte", "R$ 40"], ["◒", "Corte + Barba", "R$ 65"], ["◇", "Barba", "R$ 30"]]
    },
    nails: {
      label: "NAIL DESIGNER",
      icon: "✦",
      headline: "Unhas lindas,<br><em>tempo para você.</em>",
      subtitle: "Escolha um horário e venha se cuidar.",
      services: [["✦", "Manicure", "R$ 35"], ["◌", "Pé + Mão", "R$ 65"], ["◇", "Alongamento", "R$ 120"]]
    },
    salon: {
      label: "SALÃO DE BELEZA",
      icon: "◒",
      headline: "Sua beleza,<br><em>em boas mãos.</em>",
      subtitle: "Seu horário de autocuidado começa aqui.",
      services: [["◒", "Corte", "R$ 80"], ["✦", "Escova", "R$ 60"], ["◇", "Coloração", "R$ 150"]]
    },
    aesthetics: {
      label: "ESTÉTICA E BEM-ESTAR",
      icon: "◌",
      headline: "Seu momento de<br><em>se sentir bem.</em>",
      subtitle: "Atendimentos feitos para o seu bem-estar.",
      services: [["◌", "Limpeza de pele", "R$ 120"], ["✦", "Massagem", "R$ 100"], ["◇", "Drenagem", "R$ 90"]]
    },
    tattoo: {
      label: "ESTÚDIO DE TATUAGEM",
      icon: "✧",
      headline: "Arte que fica<br><em>com você.</em>",
      subtitle: "Converse com a gente e reserve seu horário.",
      services: [["✧", "Consulta", "Grátis"], ["◈", "Tatuagem", "Sob consulta"], ["◇", "Piercing", "R$ 70"]]
    },
    other: {
      label: "ATENDIMENTO COM HORA MARCADA",
      icon: "＋",
      headline: "Seu tempo.<br><em>Seu momento.</em>",
      subtitle: "Escolha o melhor horário para você.",
      services: [["✦", "Atendimento", "R$ 50"], ["◌", "Serviço especial", "R$ 80"], ["◇", "Consultoria", "R$ 100"]]
    }
  };

  function getSegment(config) {
    // hasOwnProperty evita chaves como "__proto__" ou "constructor" virarem "segmento".
    const key = config && typeof config.segment === "string" ? config.segment : "";
    return Object.prototype.hasOwnProperty.call(segments, key) ? segments[key] : segments.other;
  }

  // Mesma regra do servidor (functions/lib/slug.js).
  function slugify(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 45);
  }

  // Rota pública: exatamente /s/{slug}. Slug inválido ou % malformado => null (página "não encontrado",
  // sem consultar o Firestore). Evolução futura (subdomínio): este é o único ponto de resolução de slug.
  const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])$/;
  function parseSlugFromPath(pathname) {
    const match = String(pathname || "").match(/^\/s\/([^/]+)\/?$/);
    if (!match) return null;
    let raw;
    try {
      raw = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    const slug = raw.toLowerCase();
    return SLUG.test(slug) ? slug : null;
  }

  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
  function safeColor(value, fallback) {
    return typeof value === "string" && HEX_COLOR.test(value) ? value : fallback;
  }

  // Só aceita imagem embutida (data URL png/jpeg/webp). Sem aspas, sem URL externa, sem SVG.
  const LOGO_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  function isSafeLogoImage(value) {
    return typeof value === "string" && value.length <= 700000 && LOGO_IMAGE.test(value);
  }

  function escapeHTML(text) {
    return String(text || "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;"
    }[char]));
  }

  function isLight(hex) {
    const clean = safeColor(hex, "#161514").replace("#", "");
    const red = parseInt(clean.slice(0, 2), 16);
    const green = parseInt(clean.slice(2, 4), 16);
    const blue = parseInt(clean.slice(4, 6), 16);
    return (red * 299 + green * 587 + blue * 114) / 1000 > 155;
  }

  function getLogoMarkup(config) {
    if (config.logo === "upload" && isSafeLogoImage(config.logoImage)) {
      return `<img src="${escapeHTML(config.logoImage)}" alt="Logo de ${escapeHTML(config.name)}">`;
    }
    if (config.logo === "scissors") return "✂";
    if (config.logo === "star") return "✦";
    return escapeHTML((config.name || "A").trim().charAt(0).toUpperCase() || "A");
  }

  function buildDates(config) {
    const today = new Date();
    const weekly = config.schedule === "semanal";
    const dates = Array.from({ length: 4 }, (_, index) => {
      const day = new Date(today);
      day.setDate(today.getDate() + index + 1);
      return day;
    });
    return { weekly, dates };
  }

  // root: elemento raiz que contém a mesma estrutura de IDs usada no bloco .site-preview
  // (preview-logo-content, preview-name-nav, preview-segment-label, preview-title,
  //  preview-subtitle, preview-service-list, preview-dates, preview-booking-title,
  //  preview-footer-logo, preview-footer-name). Ver public/index.html ou public/site.html.
  function renderSiteInto(root, config) {
    const $ = (selector) => root.querySelector(selector);
    const segment = getSegment(config);
    const background = safeColor(config.background, "#161514");
    const textColor = isLight(background) ? "#24221e" : "#fffdf8";

    root.style.setProperty("--primary", safeColor(config.primary, "#c89b3c"));
    root.style.setProperty("--site-bg", background);
    root.style.setProperty("--site-text", textColor);

    const nameOrDefault = typeof config.name === "string" && config.name ? config.name : "Meu negócio";
    if ($("#preview-name-nav")) $("#preview-name-nav").textContent = nameOrDefault;
    if ($("#preview-footer-name")) $("#preview-footer-name").textContent = nameOrDefault;
    if ($("#preview-segment-label")) $("#preview-segment-label").textContent = segment.label;
    if ($("#preview-title")) $("#preview-title").innerHTML = segment.headline;
    if ($("#preview-subtitle")) $("#preview-subtitle").textContent = segment.subtitle;

    const logoContent = $("#preview-logo-content");
    if (logoContent) logoContent.outerHTML = `<span id="preview-logo-content">${getLogoMarkup(config)}</span>`;
    const footerLogo = $("#preview-footer-logo");
    if (footerLogo) footerLogo.innerHTML = getLogoMarkup(config);

    const serviceList = $("#preview-service-list");
    if (serviceList) {
      serviceList.innerHTML = segment.services
        .map((service) => `<div class="preview-service-row"><span>${service[0]}</span><b>${service[1]}</b><small>${service[2]}</small></div>`)
        .join("");
    }

    const { weekly, dates } = buildDates(config);
    if ($("#preview-booking-title")) $("#preview-booking-title").textContent = weekly ? "Escolha um dia" : "Calendário de horários";
    const datesContainer = $("#preview-dates");
    if (datesContainer) {
      datesContainer.innerHTML = dates.map((date, index) => {
        const label = weekly
          ? ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"][date.getDay()]
          : date.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "").toUpperCase();
        return `<span class="preview-date ${index === 1 ? "active" : ""}"><small>${label}</small><b>${String(date.getDate()).padStart(2, "0")}</b></span>`;
      }).join("");
    }
  }

  function withTimeout(promise, ms, timeoutMessage) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage || "tempo esgotado")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  global.AgendaFacilRender = { segments, getSegment, slugify, parseSlugFromPath, safeColor, isSafeLogoImage, escapeHTML, isLight, getLogoMarkup, renderSiteInto, withTimeout };
})(window);
