const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('../helpers/browser');
test('página inicial apresenta o produto sem redirecionar ou exigir Firebase', async t => {
  const p = await loadPage('index.html', { scripts: ['home.js'], state: { user: { uid: 'alice' } } });
  t.after(() => p.w.close());
  assert.match(p.doc.querySelector('h1').textContent, /faz de melhor/);
  assert.equal(p.calls.init, 0);
  assert.equal(p.doc.querySelectorAll('script').length, 0);
  assert.ok(p.doc.querySelector('a[href="painel.html"]'));
  assert.ok(p.doc.querySelector('a[href="editor.html"]'));
  assert.equal(p.w.location.pathname, '/index.html');
});
