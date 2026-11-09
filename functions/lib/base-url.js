// Validação de APP_BASE_URL (origem do app usada no back_url do checkout). Falha fechada.
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function parseBaseUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { ok: false, error: "vazia" };
  if (/[?#]/.test(raw)) return { ok: false, error: "não pode ter query nem fragmento" };
  if (/\s/.test(raw)) return { ok: false, error: "não pode ter espaços" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "URL inválida" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "precisa ser https" };
  if (url.username || url.password) return { ok: false, error: "não pode ter credenciais" };
  if (url.port) return { ok: false, error: "não pode ter porta" };
  if (url.pathname !== "/") return { ok: false, error: "não pode ter caminho (use só a origem)" };
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return { ok: false, error: "não pode ser endereço IP" };
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) return { ok: false, error: "domínio inválido" };
  if (host === "localhost" || /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host)) return { ok: false, error: "domínio local/reservado não é permitido" };
  return { ok: true, origin: `https://${host}`, host };
}

const buildBackUrl = (origin) => `${origin}/painel.html?assinatura=retorno`;

module.exports = { parseBaseUrl, buildBackUrl };
