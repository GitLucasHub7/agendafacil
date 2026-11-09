// Reserva atômica de endereço público: slugClaims/{slug} -> { siteId, ownerUid, state, subscriptionId, expiresAtMs }.
//   reserved : checkout em andamento (expira em SLUG_RESERVATION_MS)
//   published: site no ar (sem expiração)
//   held     : site suspenso/cancelado; endereço retido por SLUG_RETENTION_DAYS para o dono poder voltar
// Só o site detentor da reserva pode publicar naquele slug. Escrita somente no servidor (regras fecham o cliente).
const { SLUG_RESERVATION_MS, SLUG_RETENTION_MS } = require("./plan");

const isLive = (claim, now) => Boolean(claim) && (claim.expiresAtMs === null || claim.expiresAtMs === undefined || claim.expiresAtMs > now);
const blocks = (claim, siteId, now) => isLive(claim, now) && claim.siteId !== siteId;

const base = ({ slug, siteId, ownerUid, subscriptionId, now, prev }) => ({ slug, siteId, ownerUid, subscriptionId: subscriptionId || null, createdAtMs: (prev && prev.createdAtMs) || now, updatedAtMs: now });
const reservedClaim = (p) => ({ ...base(p), state: "reserved", expiresAtMs: p.now + SLUG_RESERVATION_MS });
const publishedClaim = (p) => ({ ...base(p), state: "published", expiresAtMs: null });
const heldClaim = (p) => ({ ...base(p), state: "held", expiresAtMs: p.now + SLUG_RETENTION_MS });

module.exports = { isLive, blocks, reservedClaim, publishedClaim, heldClaim };
