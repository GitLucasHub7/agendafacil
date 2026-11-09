// Plano comercial e políticas da assinatura. O preço vive SOMENTE aqui (servidor); o cliente nunca o define.
const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN = Object.freeze({
  priceCents: 2190, // R$ 21,90 por site, por mês
  currency: "BRL",
  frequency: 1,
  frequencyType: "months",
  reason: "AgendaFácil — assinatura mensal do site",
});

// Carência de inadimplência: após terminar o período pago, o site continua no ar por 7 dias
// enquanto o Mercado Pago tenta cobrar de novo. Depois disso o site é suspenso (dados preservados).
const GRACE_DAYS = 7;
// Assinatura que ficou "pending" (checkout não concluído) por mais que isso é encerrada.
const PENDING_ABANDON_DAYS = 7;
// Criação de assinatura "em andamento": enquanto a trava for recente, outras chamadas NÃO criam outro preapproval.
const CREATION_LOCK_MS = 2 * 60 * 1000;
// Sem resposta por mais que isso, a criação é tratada como órfã (registra incidente e libera nova tentativa).
const CREATION_HARD_TTL_MS = 30 * 60 * 1000;
// Reserva de endereço (slug): enquanto o checkout está pendente (mesmo prazo do abandono) e, depois de
// suspensão/cancelamento, retenção do endereço para o dono poder voltar. Decisões de produto ajustáveis.
const SLUG_RESERVATION_MS = PENDING_ABANDON_DAYS * DAY_MS;
const SLUG_RETENTION_DAYS = 90;
const SLUG_RETENTION_MS = SLUG_RETENTION_DAYS * DAY_MS;
// Intervalo mínimo entre sincronizações manuais pedidas pelo usuário.
const MANUAL_SYNC_COOLDOWN_MS = 30 * 1000;

const STATUS = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  SUSPENDED: "suspended",
  CANCELLED: "cancelled",
});

const toCents = (value) => (value === undefined || value === null || Number.isNaN(Number(value)) ? null : Math.round(Number(value) * 100));

// Soma meses em UTC preservando o dia quando possível (31/01 + 1 mês = 28/02 ou 29/02).
function addMonths(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
}

module.exports = { PLAN, GRACE_DAYS, PENDING_ABANDON_DAYS, CREATION_LOCK_MS, CREATION_HARD_TTL_MS, SLUG_RESERVATION_MS, SLUG_RETENTION_DAYS, SLUG_RETENTION_MS, MANUAL_SYNC_COOLDOWN_MS, STATUS, DAY_MS, toCents, addMonths };
