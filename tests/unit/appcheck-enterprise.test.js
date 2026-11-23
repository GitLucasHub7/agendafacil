const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage } = require('../helpers/browser');
test('Enterprise usa o provedor configurado, renova tokens e não habilita depuração no domínio público', async t => {
  const page = await loadPage('login.html', { scripts: [], url: 'https://agendafacil-online.web.app/login.html' });
  t.after(() => page.w.close());
  page.w.FIREBASE_CONFIG = { apiKey: 'fake-public-key-for-test', projectId: 'unit-test-project' };
  page.w.APPCHECK_SITE_KEY = 'public-enterprise-key';
  page.w.APPCHECK_PROVIDER = 'enterprise';
  class Enterprise { constructor(key) { this.key = key; } }
  page.w.firebase.appCheck.ReCaptchaEnterpriseProvider = Enterprise;
  page.w.eval(fs.readFileSync(path.join(__dirname, '../../public/auth-shared.js'), 'utf8'));
  assert.equal(page.w.AF.ready, true);
  assert.equal(page.w.AF.appCheck, true);
  assert.ok(page.calls.appCheck[0][0] instanceof Enterprise);
  assert.equal(page.calls.appCheck[0][0].key, 'public-enterprise-key');
  assert.equal(page.calls.appCheck[0][1], true);
  assert.equal(page.w.FIREBASE_APPCHECK_DEBUG_TOKEN, undefined);
});
