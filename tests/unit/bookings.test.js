const test = require('node:test');
const assert = require('node:assert/strict');
const { makeBookings, validateSettings, bookingDate } = require('../../functions/lib/bookings');
const { createFakeDb } = require('../helpers/fakeFirestore');
const siteId = 'site1234567890';
const now = () => Date.parse('2026-11-19T08:00:00-03:00');
function setup() {
  const db = createFakeDb();
  db.seed('sites/' + siteId, { ownerUid: 'alice', name: 'Negócio', published: true, start: '09:00', end: '12:00' });
  db.seed('publicSites/negocio', { siteId, start: '09:00', end: '12:00' });
  db.seed('bookingSettings/' + siteId, validateSettings({ enabled: true, days: [4, 5], blockedDates: [], services: [{ name: 'Corte', duration: 45, priceCents: 4000 }] }));
  return { db, ...makeBookings({ db, now }) };
}
const request = (extra = {}) => ({ rawRequest: { ip: '192.0.2.1' }, data: { slug: 'negocio', date: '2026-11-19', time: '09:00', serviceId: 'service1', name: 'Cliente Teste', phone: '11999999999', consent: true, requestKey: 'a'.repeat(32), ...extra } });
test('reservas concorrentes e sobrepostas: somente uma vence; disponibilidade nunca expõe dados pessoais', async () => {
  const w = setup();
  const results = await Promise.allSettled([w.create(request()), w.create(request({ time: '09:15', requestKey: 'b'.repeat(32) }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'already-exists');
  const availability = await w.availability({ data: { slug: 'negocio', date: '2026-11-19', serviceId: 'service1' } });
  assert.equal(availability.slots.includes('09:30'), false);
  assert.equal(availability.slots.includes('09:45'), true);
  assert.doesNotMatch(JSON.stringify(availability), /Cliente|11999999999|ownerUid|bookingId/);
});
test('repetição de solicitação é idempotente; reutilização com outros dados é rejeitada', async () => {
  const w = setup(); const a = await w.create(request());
  assert.deepEqual(await w.create(request()), a);
  assert.equal([...w.db._store.keys()].filter(k => k.startsWith('bookings/')).length, 1);
  await assert.rejects(w.create(request({ name: 'Outro Cliente' })), e => e.code === 'already-exists');
});
test('somente o dono lista e cancela; cancelamento libera todos os blocos sem reativar reserva antiga', async () => {
  const w = setup(); const r = await w.create(request());
  await assert.rejects(w.manage({ auth: { uid: 'bob' }, data: { siteId, action: 'list' } }), e => e.code === 'not-found');
  await assert.rejects(w.manage({ data: { siteId, action: 'cancel', bookingId: r.bookingId } }), e => e.code === 'unauthenticated');
  await w.manage({ auth: { uid: 'alice' }, data: { siteId, action: 'cancel', bookingId: r.bookingId } });
  assert.equal((await w.create(request())).status, 'cancelled');
  const second = await w.create(request({ requestKey: 'c'.repeat(32) }));
  await w.manage({ auth: { uid: 'alice' }, data: { siteId, action: 'cancel', bookingId: r.bookingId } });
  assert.equal(w.db._store.get(`bookingDays/${siteId}_2026-11-19`).occupied['540'], second.bookingId);
});
test('agenda fechada, datas bloqueadas, passado e site não publicado não recebem reservas', async () => {
  const w = setup();
  await assert.rejects(w.create(request({ date: '2026-11-18' })), e => e.code === 'invalid-argument');
  assert.throws(() => bookingDate('2026-02-30', now()));
  await w.manage({ auth: { uid: 'alice' }, data: { siteId, action: 'saveSettings', settings: { enabled: true, days: [4], blockedDates: ['2026-11-19'], services: [{ name: 'Corte', duration: 30, priceCents: 3000 }] } } });
  await assert.rejects(w.create(request()), e => e.code === 'already-exists');
  await w.db.collection('publicSites').doc('negocio').delete();
  await assert.rejects(w.availability({ data: { slug: 'negocio' } }), e => e.code === 'not-found');
});
test('limite por contato impede spam e não é consumido por repetição idempotente', async () => {
  const w = setup();
  for (const [i, time] of ['09:00', '09:45', '10:30'].entries()) await w.create(request({ time, requestKey: String(i).repeat(32) }));
  await assert.rejects(w.create(request({ time: '11:15', requestKey: 'd'.repeat(32) })), e => e.code === 'resource-exhausted');
});
test('validação rejeita durações inválidas, preços adulterados e nomes com controle', () => {
  const b = { enabled: true, days: [4], services: [{ name: 'Corte', duration: 30, priceCents: 3000 }] };
  assert.throws(() => validateSettings({ ...b, services: [{ ...b.services[0], duration: 0 }] }));
  assert.throws(() => validateSettings({ ...b, services: [{ ...b.services[0], priceCents: -1 }] }));
  assert.throws(() => validateSettings({ ...b, days: [8] }));
});
