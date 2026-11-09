// Validação da assinatura de notificações do Mercado Pago (cabeçalho x-signature).
// Manifesto oficial: "id:[data.id];request-id:[x-request-id];ts:[ts];" com HMAC-SHA256 (hex) e o segredo do webhook.
const crypto = require("node:crypto");

function parseSignature(header) {
  const out = {};
  for (const part of String(header || "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function verifySignature({ secret, signatureHeader, requestId, dataId }) {
  if (!secret) return { ok: false, reason: "secret_not_configured" };
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  const { ts, v1 } = parseSignature(signatureHeader);
  if (!ts || !v1 || !/^\d+$/.test(ts) || !/^[0-9a-f]{64}$/i.test(v1)) return { ok: false, reason: "malformed_signature" };
  if (dataId === undefined || dataId === null || dataId === "") return { ok: false, reason: "missing_data_id" };

  // Documentação: se o id for alfanumérico, usar minúsculas no manifesto.
  const id = /^[A-Za-z0-9]+$/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  const manifest = `id:${id};request-id:${requestId || ""};ts:${ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest();
  const given = Buffer.from(v1, "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true, ts: Number(ts) };
}

// Utilitário para os testes e para simular notificações no sandbox.
function signForTest({ secret, dataId, requestId, ts }) {
  const id = /^[A-Za-z0-9]+$/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  const v1 = crypto.createHmac("sha256", secret).update(`id:${id};request-id:${requestId || ""};ts:${ts};`).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

module.exports = { verifySignature, signForTest, parseSignature };
