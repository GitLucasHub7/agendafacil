// Slug do endereço público (/s/{slug}). Mesma lógica do front (render-shared.js).
const RESERVED = new Set(["s", "api", "admin", "painel", "editor", "login", "entrar", "app", "www"]);

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 45);
}

function isValidSlug(slug) {
  return typeof slug === "string" && /^[a-z0-9](?:[a-z0-9-]{1,43}[a-z0-9])$/.test(slug) && !RESERVED.has(slug);
}

module.exports = { slugify, isValidSlug, RESERVED };
