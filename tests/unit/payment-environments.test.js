const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoutedProvider } = require('../../functions/payments/routedProvider');
const { createFakeDb } = require('../helpers/fakeFirestore');
const { world, authFor } = require('../helpers/world');
const { makeCreateSubscription, makeWebhook } = require('../../functions/lib/subscriptions');
test('assinaturas antigas usam vendedor de teste; novas referências explícitas usam vendedor real', async () => {
  const db = createFakeDb();
  db.seed('subscriptions/old', { mpPreapprovalId: 'test-pre' });
  db.seed('subscriptions/new', { paymentEnvironment: 'live', mpPreapprovalId: 'live-pre' });
  const calls = [];
  const providerFor = env => new Proxy({}, { get: (_, name) => name === 'then' ? undefined : async args => { calls.push([env, name, args]); return env; } });
  const provider = createRoutedProvider({ db, providerFor, fallbackEnvironment: 'live' });
  assert.equal(await provider.getPreapproval('test-pre'), 'test');
  assert.equal(await provider.cancelPreapproval('live-pre'), 'live');
  assert.equal(await provider.createPreapproval({ externalReference: 'new' }), 'live');
  assert.equal(await provider.findPreapprovalByExternalReference({ externalReference: 'old' }), 'test');
  assert.equal(await provider.searchInvoices({ preapprovalId: 'test-pre' }), 'test');
  assert.equal(await provider.searchInvoices({ paymentId: '123' }), 'live');
  await assert.rejects(provider.createPreapproval({ externalReference: 'missing' }), /não encontrada/);
});
test('nova assinatura registra ambiente real no servidor e navegador não escolhe o ambiente', async () => {
  const w = world(); const siteId = await w.newSite('alice', 'Ambiente Real');
  const create = makeCreateSubscription({ db: w.db, FieldValue: require('../helpers/fakeFirestore').FieldValue, getProvider: () => w.gw.provider, getAppBaseUrl: () => 'https://example.web.app', getPaymentEnvironment: () => 'live', now: w.clock.now });
  const result = await create({ auth: authFor('alice'), data: { siteId, paymentEnvironment: 'test' } });
  assert.equal(w.sub(result.subscriptionId).paymentEnvironment, 'live');
});
test('webhook de teste não aplica evento a assinatura real', async () => {
  const w = world(); const siteId = await w.newSite('alice', 'Isolamento Pago');
  const sub = await w.subscribe('alice', siteId);
  await w.db.collection('subscriptions').doc(sub.subscriptionId).update({ paymentEnvironment: 'live' });
  const event = await w.pay(sub.preId);
  assert.equal(event.res.code, 500);
  assert.equal(w.siteDoc(siteId).published, false);
});

test('checkout pendente de teste não é reaproveitado depois da ativação real', async () => {
  const w = world(); const siteId = await w.newSite('alice', 'Transicao de ambiente');
  const old = await w.subscribe('alice', siteId);
  const create = makeCreateSubscription({ db: w.db, FieldValue: require('../helpers/fakeFirestore').FieldValue, getProvider: () => w.gw.provider, getAppBaseUrl: () => 'https://example.web.app', getPaymentEnvironment: () => 'live', now: w.clock.now });
  const result = await create({ auth: authFor('alice'), data: { siteId } });
  assert.notEqual(result.subscriptionId, old.subscriptionId);
  assert.equal(w.sub(result.subscriptionId).paymentEnvironment, 'live');
  assert.equal(w.sub(old.subscriptionId).mpStatus, 'cancelled');
});
