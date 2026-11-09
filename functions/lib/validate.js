// Validação server-side dos dados de um site: lista explícita de campos, tipos e limites.
const crypto = require("node:crypto");
const { slugify, isValidSlug } = require("./slug");

const SEGMENTS = ["barbershop", "nails", "salon", "aesthetics", "tattoo", "other"];
const LOGOS = ["initial", "scissors", "star", "upload"];
const SCHEDULES = ["semanal", "mensal"];
const WORKS = ["solo", "team"];
const INTERVALS = ["30", "45", "60"];
const ALLOWED_FIELDS = ["segment", "name", "primary", "background", "logo", "logoImage", "schedule", "work", "start", "end", "interval"];
const MAX_LOGO_CHARS = 700000; // ~525 KB de imagem; cabe com folga no limite de 1 MiB do documento
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

function pick(input, key, fallback) {
  return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined ? input[key] : fallback;
}

function oneOf(value, list, field) {
  const v = typeof value === "number" ? String(value) : value;
  if (typeof v !== "string" || !list.includes(v)) throw new ValidationError(`Valor inválido para ${field}.`, field);
  return v;
}

function validateSiteInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Dados do site inválidos.");
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.includes(key)) throw new ValidationError(`Campo não permitido: ${key}.`, key);
  }

  const segment = oneOf(pick(input, "segment", undefined), SEGMENTS, "segment");

  const rawName = pick(input, "name", undefined);
  if (typeof rawName !== "string") throw new ValidationError("Informe o nome do negócio.", "name");
  const name = rawName.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > 45) throw new ValidationError("O nome deve ter de 1 a 45 caracteres.", "name");
  if (/[\p{Cc}\p{Cf}]/u.test(name)) throw new ValidationError("O nome contém caracteres inválidos.", "name");
  const slug = slugify(name);
  if (!isValidSlug(slug)) throw new ValidationError("Use um nome com ao menos 3 letras ou números e que não seja reservado.", "name");

  const primary = pick(input, "primary", "#c89b3c");
  const background = pick(input, "background", "#161514");
  if (typeof primary !== "string" || !HEX_RE.test(primary)) throw new ValidationError("Cor principal inválida.", "primary");
  if (typeof background !== "string" || !HEX_RE.test(background)) throw new ValidationError("Cor de fundo inválida.", "background");

  const logo = oneOf(pick(input, "logo", "initial"), LOGOS, "logo");
  let logoImage = pick(input, "logoImage", "");
  if (typeof logoImage !== "string") throw new ValidationError("Imagem do logo inválida.", "logoImage");
  if (logo === "upload") {
    if (logoImage.length === 0 || logoImage.length > MAX_LOGO_CHARS || !LOGO_RE.test(logoImage)) {
      throw new ValidationError("Imagem do logo inválida ou grande demais (máx. ~500 KB; PNG, JPG ou WebP).", "logoImage");
    }
  } else {
    logoImage = "";
  }

  const schedule = oneOf(pick(input, "schedule", "semanal"), SCHEDULES, "schedule");
  const work = oneOf(pick(input, "work", "solo"), WORKS, "work");
  const start = pick(input, "start", "09:00");
  const end = pick(input, "end", "20:00");
  if (typeof start !== "string" || !TIME_RE.test(start)) throw new ValidationError("Horário inicial inválido.", "start");
  if (typeof end !== "string" || !TIME_RE.test(end)) throw new ValidationError("Horário final inválido.", "end");
  if (start >= end) throw new ValidationError("O horário final deve ser depois do inicial.", "end");
  const interval = oneOf(pick(input, "interval", "30"), INTERVALS, "interval");

  return { clean: { segment, name, primary: primary.toLowerCase(), background: background.toLowerCase(), logo, logoImage, schedule, work, start, end, interval }, slug };
}

// Extrai só os campos permitidos de um documento já gravado (para revalidar antes de publicar).
function pickSiteFields(doc) {
  const out = {};
  for (const key of ALLOWED_FIELDS) if (doc && Object.prototype.hasOwnProperty.call(doc, key)) out[key] = doc[key];
  return out;
}

// Hash estável do conteúdo validado (detecta "alterações não publicadas" sem comparar campo a campo).
function contentHash(clean) {
  const ordered = Object.fromEntries(Object.keys(clean).sort().map((k) => [k, clean[k]]));
  return crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 24);
}

module.exports = { contentHash, validateSiteInput, pickSiteFields, ValidationError, ALLOWED_FIELDS, SEGMENTS, MAX_LOGO_CHARS };
