const test = require('node:test');
const assert = require('node:assert/strict');
const {loadPage} = require('../helpers/browser');
const config = {apiKey:'chave-ficticia-para-teste',projectId:'agenda-dev-123'};
const scripts = ['firebase-config.js','auth-shared.js'];
test('prévia local troca o projeto real por demo antes de inicializar e dispensa App Check',async()=>{
  const page = await loadPage('login.html',{scripts,config,appCheckKey:'fake',url:'http://127.0.0.1/login.html?emulators=1'});
  try {
    assert.equal(page.w.AF.ready,true);
    assert.equal(page.calls.config.projectId,'demo-agendafacil');
    assert.equal(page.calls.authEmulator,'http://127.0.0.1:9099');
    assert.equal(page.calls.firestoreEmulator[1],8080);
    assert.equal(page.calls.appCheck.length,0);
  } finally {page.w.close();}
});
test('site remoto ignora pedido de emulador; configuração demo remota bloqueia inicialização',async()=>{
  const page = await loadPage('login.html',{scripts,config,url:'https://agenda-dev-123.web.app/login.html?emulators=1'});
  const invalid = await loadPage('login.html',{scripts,config:{...config,projectId:'demo-agendafacil'},url:'https://agenda-dev-123.web.app/login.html'});
  try {
    assert.equal(page.calls.config.projectId,'agenda-dev-123');
    assert.equal(page.calls.authEmulator,undefined);
    assert.equal(invalid.w.AF.ready,false);
    assert.equal(invalid.calls.init,0);
  } finally {page.w.close();invalid.w.close();}
});
test('falha na ligação do emulador impede liberar a aplicação',async()=>{
  const page = await loadPage('login.html',{scripts,config,state:{emulatorError:true},url:'http://127.0.0.1/login.html?emulators=1'});
  try {assert.equal(page.w.AF.ready,false);assert.equal(page.calls.config.projectId,'demo-agendafacil');}
  finally {page.w.close();}
});
