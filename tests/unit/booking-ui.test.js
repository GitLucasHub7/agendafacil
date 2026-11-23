const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('../helpers/browser');
const config = { apiKey: 'fake-key-for-ui-tests', projectId: 'demo-ui-only', appId: 'test' };

test('carregamento e mensagem de site inexistente desaparecem quando ocultados', async t => {
  const p = await loadPage('site.html', { scripts: [] });
  t.after(() => p.w.close());
  const loading = p.doc.querySelector('#site-loading');
  assert.equal(p.w.getComputedStyle(loading).display, 'grid');
  loading.hidden = true;
  assert.equal(p.w.getComputedStyle(loading).display, 'none');
  assert.equal(p.w.getComputedStyle(p.doc.querySelector('#site-not-found')).display, 'none');
});
test('visitante escolhe serviço e horário; confirmação não envia preço nem publica site', async () => {
  const p = await loadPage('site.html', { url: 'https://example.test/s/negocio', scripts: ['render-shared.js', 'booking.js'], state: { callables: {
    getBookingAvailability: async b => b.date ? { slots: ['10:00'] } : { enabled: true, today: '2026-11-20', lastDate: '2026-12-20', services: [{ id: 'service1', name: '<Corte>', duration: 30, priceCents: 4500 }] },
    createBooking: async b => ({ status: 'confirmed', code: 'ABC123', date: b.date, time: b.time })
  } } });
  await p.w.initBooking({ name: 'Negócio' });
  assert.equal(p.doc.querySelector('#booking-form').hidden, false);
  assert.equal(p.doc.querySelector('#preview-service-list b').textContent, '<Corte>');
  p.doc.querySelector('#booking-time').value = '10:00';
  p.doc.querySelector('#booking-name').value = 'Cliente';
  p.doc.querySelector('#booking-phone').value = '11999999999';
  p.doc.querySelector('#booking-consent').checked = true;
  p.doc.querySelector('#booking-form').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await p.tick();
  const call = p.calls.callable.find(([name]) => name === 'createBooking');
  assert.ok(call);
  assert.equal(call[1].priceCents, undefined);
  assert.equal(call[1].published, undefined);
  assert.match(p.doc.querySelector('#booking-message').textContent, /Reserva confirmada/);
  assert.equal(p.doc.querySelector('#booking-form').hidden, true);
  p.w.close();
});
test('agenda desativada remove catálogo fictício e não oferece reserva', async () => {
  const p = await loadPage('site.html', { url: 'https://example.test/s/negocio', scripts: ['render-shared.js', 'booking.js'], state: { callables: { getBookingAvailability: async () => ({ enabled: false }) } } });
  await p.w.initBooking({ name: 'Negócio' });
  assert.equal(p.doc.querySelector('#booking-form').hidden, true);
  assert.equal(p.doc.querySelector('#preview-service-list').children.length, 0);
  assert.match(p.doc.querySelector('#booking-message').textContent, /ainda não abriu/);
  p.w.close();
});
test('dono configura serviços e abre agenda pelo painel autenticado', async () => {
  const p = await loadPage('agenda.html', { url: 'http://localhost/agenda.html?site=site1234567890', config, scripts: ['firebase-config.js', 'auth-shared.js', 'agenda.js'], state: { user: { uid: 'alice', email: 'alice@example.test' }, callables: { manageBookings: async b => b.action === 'list' ? { siteName: 'Negócio', start: '09:00', end: '18:00', settings: { enabled: false, days: [1], blockedDates: [], services: [{ name: 'Corte', duration: 30, priceCents: 4000 }] }, bookings: [] } : { saved: true } } } });
  await p.tick(40);
  assert.equal(p.doc.querySelectorAll('.service-row').length, 1);
  p.doc.querySelector('#booking-enabled').checked = true;
  p.doc.querySelector('#settings-form').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await p.tick();
  const save = p.calls.callable.find(([, b]) => b.action === 'saveSettings');
  assert.equal(save[1].settings.enabled, true);
  assert.equal(save[1].settings.services[0].priceCents, 4000);
  assert.match(p.doc.querySelector('#agenda-message').textContent, /salvas/);
  p.w.close();
});
