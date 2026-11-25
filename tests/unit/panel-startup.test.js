const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage } = require('../helpers/browser');
const config = { apiKey: 'fake-key-for-panel-tests', projectId: 'demo-panel' };
const scripts = ['render-shared.js', 'firebase-config.js', 'auth-shared.js'];
const panel = fs.readFileSync(path.join(__dirname, '../../public/painel.js'), 'utf8');
test('falha na inicialização encerra carregamento e apresenta orientação', async t => {
  const p = await loadPage('painel.html', { config, scripts });
  t.after(() => p.w.close());
  p.w.AF.requireUser = async () => { throw new Error('Falha simulada'); };
  p.w.eval(panel);
  await p.tick();
  assert.equal(p.doc.querySelector('#loading-state').hidden, true);
  assert.equal(p.doc.querySelector('#panel-message').hidden, false);
  assert.match(p.doc.querySelector('#panel-message').textContent, /Recarregue/);
});
test('configuração inválida não deixa o painel em carregamento permanente', async t => {
  const p = await loadPage('painel.html', { config: { apiKey: '', projectId: '' }, scripts });
  t.after(() => p.w.close());
  p.w.eval(panel);
  await p.tick();
  assert.equal(p.doc.querySelector('#loading-state').hidden, true);
  assert.equal(p.doc.querySelector('#panel-message').hidden, false);
});
