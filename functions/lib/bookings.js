const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { requireAuth, parseSiteId, loadOwnedSite } = require('./sites');
const { isValidSlug } = require('./slug');
const DAY = 86400000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new HttpsError(code, message); };
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const today = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('invalid-argument', 'Data inválida.');
  const stamp = Date.parse(value + 'T12:00:00Z');
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) fail('invalid-argument', 'Data inválida.');
  return value;
}
function bookingDate(value, now) {
  dateValue(value);
  const distance = (Date.parse(value) - Date.parse(today(now))) / DAY;
  if (distance < 0 || distance > 60) fail('invalid-argument', 'Escolha uma data entre hoje e os próximos 60 dias.');
  return value;
}
function validateSettings(input) {
  if (input?.contactPhone !== undefined && (typeof input.contactPhone !== 'string' || !/^[+\d ()-]{0,24}$/.test(input.contactPhone))) fail('invalid-argument', 'Informe um telefone público válido.');
  let contactPhone = (input?.contactPhone || '').replace(/\D/g, '');
  if (contactPhone.length === 10 || contactPhone.length === 11) contactPhone = '55' + contactPhone;
  if (contactPhone && !/^55\d{10,11}$/.test(contactPhone)) fail('invalid-argument', 'Informe o telefone do estabelecimento com DDD.');
  if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.days) || input.days.length > 7 || input.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) fail('invalid-argument', 'Informe os dias de atendimento.');
  if (!Array.isArray(input.services) || input.services.length < 1 || input.services.length > 12) fail('invalid-argument', 'Cadastre de 1 a 12 serviços.');
  const services = input.services.map((s, i) => {
    if (typeof s.name !== 'string' || s.name.trim().length < 2 || s.name.trim().length > 60 || /[\p{Cc}\p{Cf}]/u.test(s.name)) fail('invalid-argument', 'Nome de serviço inválido.');
    if (!Number.isInteger(s.duration) || s.duration < 15 || s.duration > 240 || s.duration % 15) fail('invalid-argument', 'Duração deve ser múltipla de 15 minutos, até 240 minutos.');
    if (!Number.isInteger(s.priceCents) || s.priceCents < 0 || s.priceCents > 1000000) fail('invalid-argument', 'Preço de serviço inválido.');
    return { id: `service${i + 1}`, name: s.name.trim(), duration: s.duration, priceCents: s.priceCents };
  });
  const days = [...new Set(input.days)];
  if (input.enabled && !days.length) fail('invalid-argument', 'Selecione ao menos um dia de atendimento.');
  const blockedDates = input.blockedDates || [];
  if (!Array.isArray(blockedDates) || blockedDates.length > 90) fail('invalid-argument', 'Máximo de 90 datas bloqueadas.');
  blockedDates.forEach(dateValue);
  return { enabled: input.enabled, contactPhone, days, services, blockedDates: [...new Set(blockedDates)], timeZone: 'America/Sao_Paulo' };
}
function slotsFor(site, settings, date, serviceId, occupied, now) {
  const service = settings.services?.find(s => s.id === serviceId);
  if (!service) fail('invalid-argument', 'Selecione um serviço disponível.');
  if (!settings.enabled || !settings.days.includes(new Date(date + 'T12:00:00Z').getUTCDay()) || settings.blockedDates.includes(date)) return [];
  const slots = [];
  for (let start = Math.ceil(minutes(site.start) / 15) * 15; start + service.duration <= minutes(site.end); start += 15) {
    const time = clock(start);
    if (Date.parse(`${date}T${time}:00-03:00`) < now + 60 * 60000) continue;
    let free = true;
    for (let m = start; m < start + service.duration; m += 15) if (occupied[String(m)]) free = false;
    if (free) slots.push(time);
  }
  return slots;
}
function makeBookings({ db, now = () => Date.now() }) {
  const settingsRef = id => db.collection('bookingSettings').doc(id);
  const dayRef = (id, date) => db.collection('bookingDays').doc(`${id}_${date}`);
  async function published(slug, tx) {
    if (typeof slug !== 'string' || !isValidSlug(slug)) fail('not-found', 'Site indisponível.');
    const ref = db.collection('publicSites').doc(slug);
    const snap = tx ? await tx.get(ref) : await ref.get();
    if (!snap.exists || !snap.data().siteId) fail('not-found', 'Site indisponível.');
    return snap.data();
  }
  async function availability(request) {
    const body = request.data || {};
    const site = await published(body.slug);
    const setting = await settingsRef(site.siteId).get();
    if (!setting.exists || !setting.data().enabled) return { enabled: false, services: [], contactPhone: setting.data()?.contactPhone || '' };
    const config = setting.data();
    const result = { enabled: true, contactPhone: config.contactPhone || '', services: config.services, timeZone: config.timeZone, today: today(now()), lastDate: today(now() + 60 * DAY) };
    if (body.date && body.serviceId) {
      const date = bookingDate(body.date, now());
      const day = await dayRef(site.siteId, date).get();
      result.slots = slotsFor(site, config, date, body.serviceId, day.data()?.occupied || {}, now());
    }
    return result;
  }
  async function create(request) {
    const b = request.data || {};
    const date = bookingDate(b.date, now());
    if (typeof b.requestKey !== 'string' || !/^[a-f0-9-]{32,64}$/i.test(b.requestKey)) fail('invalid-argument', 'Reabra o formulário para reservar.');
    if (typeof b.name !== 'string' || b.name.trim().length < 2 || b.name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(b.name)) fail('invalid-argument', 'Informe seu nome.');
    const phone = typeof b.phone === 'string' ? b.phone.replace(/\D/g, '') : '';
    if (!/^\d{10,13}$/.test(phone)) fail('invalid-argument', 'Informe seu telefone com DDD.');
    if (b.consent !== true) fail('invalid-argument', 'Confirme o uso dos dados para este agendamento.');
    const ip = request.rawRequest?.ip;
    if (!ip) fail('failed-precondition', 'Não foi possível validar a origem da reserva.');
    const fingerprint = hash(JSON.stringify([date, b.time, b.serviceId, b.name.trim(), phone]));
    return db.runTransaction(async tx => {
      const site = await published(b.slug, tx);
      const siteSnap = await tx.get(db.collection('sites').doc(site.siteId));
      if (!siteSnap.exists || !siteSnap.data().published) fail('not-found', 'Site indisponível.');
      const ownerUid = siteSnap.data().ownerUid;
      const bookingId = hash(`${site.siteId}:${b.requestKey}`);
      const ref = db.collection('bookings').doc(bookingId);
      const existing = await tx.get(ref);
      if (existing.exists) {
        if (existing.data().fingerprint !== fingerprint) fail('already-exists', 'Esta solicitação já foi usada para outra reserva.');
        return { bookingId, code: bookingId.slice(0, 10).toUpperCase(), status: existing.data().status, date, time: b.time };
      }
      const setting = await tx.get(settingsRef(site.siteId));
      if (!setting.exists || !setting.data().enabled) fail('failed-precondition', 'A agenda não está aberta.');
      const config = setting.data();
      const day = await tx.get(dayRef(site.siteId, date));
      if ((day.data()?.bookingIds || []).length >= 300) fail('resource-exhausted', 'Este dia atingiu o limite de reservas. Fale com o estabelecimento.');
      const occupied = { ...(day.data()?.occupied || {}) };
      if (!slotsFor(site, config, date, b.serviceId, occupied, now()).includes(b.time)) fail('already-exists', 'Esse horário não está mais disponível. Escolha outro.');
      const rateRefs = [db.collection('bookingLimits').doc(hash(`ip:${ip}:${Math.floor(now() / 3600000)}`)), db.collection('bookingLimits').doc(hash(`phone:${site.siteId}:${phone}:${today(now())}`))];
      const rates = await Promise.all(rateRefs.map(r => tx.get(r)));
      if ((rates[0].data()?.count || 0) >= 10 || (rates[1].data()?.count || 0) >= 3) fail('resource-exhausted', 'Limite de reservas atingido. Fale diretamente com o estabelecimento.');
      const service = config.services.find(s => s.id === b.serviceId);
      const cells = [];
      for (let m = minutes(b.time); m < minutes(b.time) + service.duration; m += 15) { occupied[String(m)] = bookingId; cells.push(String(m)); }
      tx.set(ref, { siteId: site.siteId, ownerUid, slug: b.slug, date, time: b.time, service: service.name, duration: service.duration, priceCents: service.priceCents, name: b.name.trim(), phone, status: 'confirmed', cells, fingerprint, createdAtMs: now(), consentAtMs: now() });
      tx.set(dayRef(site.siteId, date), { siteId: site.siteId, ownerUid, date, occupied, bookingIds: [...new Set([...(day.data()?.bookingIds || []), bookingId])] });
      rates.forEach((s, i) => tx.set(rateRefs[i], { count: (s.data()?.count || 0) + 1, expiresAt: new Date(now() + 2 * DAY) }));
      return { bookingId, code: bookingId.slice(0, 10).toUpperCase(), status: 'confirmed', date, time: b.time };
    });
  }
  async function manage(request) {
    const { uid } = requireAuth(request);
    const b = request.data || {};
    const siteId = parseSiteId(b.siteId);
    const { data: site } = await loadOwnedSite(db, siteId, uid);
    if (b.action === 'saveSettings') {
      const config = validateSettings(b.settings);
      if (config.enabled && !config.contactPhone) fail('invalid-argument', 'Cadastre um telefone público para os clientes poderem remarcar ou cancelar.');
      await settingsRef(siteId).set({ ...config, ownerUid: uid, updatedAtMs: now() });
      return { saved: true };
    }
    if (b.action === 'cancel') {
      if (typeof b.bookingId !== 'string' || !/^[a-f0-9]{64}$/.test(b.bookingId)) fail('invalid-argument', 'Reserva inválida.');
      return db.runTransaction(async tx => {
        const ref = db.collection('bookings').doc(b.bookingId);
        const booking = await tx.get(ref);
        if (!booking.exists || booking.data().siteId !== siteId || booking.data().ownerUid !== uid) fail('not-found', 'Reserva não encontrada.');
        const value = booking.data();
        const refDay = dayRef(siteId, value.date);
        const day = await tx.get(refDay);
        const occupied = { ...(day.data()?.occupied || {}) };
        for (const cell of value.cells) if (occupied[cell] === b.bookingId) delete occupied[cell];
        tx.update(ref, { status: 'cancelled', cancelledAtMs: now() });
        if (day.exists) tx.update(refDay, { occupied });
        return { cancelled: true };
      });
    }
    if (b.action !== 'list') fail('invalid-argument', 'Ação inválida.');
    const date = dateValue(b.date || today(now()));
    const [config, day] = await Promise.all([settingsRef(siteId).get(), dayRef(siteId, date).get()]);
    const ids = day.data()?.bookingIds || [];
    const bookings = await Promise.all(ids.map(id => db.collection('bookings').doc(id).get()));
    return { siteName: site.name, start: site.start, end: site.end, timeZone: 'America/Sao_Paulo', settings: config.exists ? config.data() : { enabled: false, days: [1, 2, 3, 4, 5, 6], blockedDates: [], services: [{ id: 'service1', name: 'Atendimento', duration: 30, priceCents: 0 }] }, bookings: bookings.filter(s => s.exists && s.data().ownerUid === uid && s.data().siteId === siteId).map(s => { const v = s.data(); return { id: s.id, name: v.name, phone: v.phone, date: v.date, time: v.time, service: v.service, duration: v.duration, priceCents: v.priceCents, status: v.status }; }).sort((a, b) => a.time.localeCompare(b.time)) };
  }
  return { availability, create, manage };
}
module.exports = { makeBookings, validateSettings, slotsFor, bookingDate, today };
