// Firebase Auth + Firestore + Hosting reais EMULADOS, sem contas ou dados na nuvem.
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
require('firebase/compat/firestore');
const {baseSite} = require('../helpers/world');
const apps = [];
const win = {};
for(const name of ['render-shared.js','site-store.js']) new Function('window',fs.readFileSync(path.join(__dirname,'../../public',name),'utf8'))(win);
const store = win.AgendaFacilStore;
const projectId = 'demo-agendafacil';
before(()=>{
  assert.equal(process.env.GCLOUD_PROJECT,projectId);
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099');
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080');
});
after(async()=>{for(const app of apps) {await app.firestore().terminate();await app.delete();}});
async function client(name) {
  const app = firebase.initializeApp({apiKey:'demo-agendafacil-local-key',projectId},name);
  apps.push(app);
  const auth = app.auth();
  auth.useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
  await auth.setPersistence(firebase.auth.Auth.Persistence.NONE);
  const db = app.firestore();
  db.useEmulator('127.0.0.1',8080);
  return {auth,db};
}
test('cadastro, rascunho, edição, logout, login, recuperação e exclusão funcionam juntos', {timeout:60000}, async()=>{
  const {auth,db} = await client('owner');
  const email = 'owner-'+Date.now()+'@example.test';
  const password = 'SomenteTeste123!';
  const {user} = await auth.createUserWithEmailAndPassword(email,password);
  await user.sendEmailVerification();
  const deps = {db,uid:user.uid,FieldValue:firebase.firestore.FieldValue};
  const site = {...baseSite,name:'Negocio Local'};
  const saved = await store.saveDraftDirect({...deps,site});
  assert.equal(saved.siteId,user.uid+'s1');
  const ref = db.collection('sites').doc(saved.siteId);
  assert.equal((await ref.get({source:'server'})).data().published,false);
  await store.saveDraftDirect({...deps,siteId:saved.siteId,site:{...site,name:'Nome Atualizado'}});
  assert.equal((await ref.get({source:'server'})).data().name,'Nome Atualizado');
  await assert.rejects(ref.update({published:true}),e=>e.code==='permission-denied');
  const stranger = await client('stranger');
  await stranger.auth.createUserWithEmailAndPassword('other-'+Date.now()+'@example.test',password);
  await assert.rejects(stranger.db.doc('sites/'+saved.siteId).get({source:'server'}),e=>e.code==='permission-denied');
  await auth.signOut();
  await assert.rejects(ref.get({source:'server'}),e=>e.code==='permission-denied');
  await auth.signInWithEmailAndPassword(email,password);
  await auth.sendPasswordResetEmail(email);
  const codes = await (await fetch('http://127.0.0.1:9099/emulator/v1/projects/'+projectId+'/oobCodes')).json();
  const reset = codes.oobCodes.find(x=>x.email===email && x.requestType==='PASSWORD_RESET');
  assert.ok(reset,'link de recuperação emitido no emulador');
  assert.ok(codes.oobCodes.some(x=>x.email===email && x.requestType==='VERIFY_EMAIL'));
  await auth.confirmPasswordReset(reset.oobCode,'SenhaNovaLocal123!');
  await auth.signOut();
  await auth.signInWithEmailAndPassword(email,'SenhaNovaLocal123!');
  await store.deleteDraft({db,siteId:saved.siteId});
  const remaining = await db.collection('sites').where('ownerUid','==',user.uid).get({source:'server'});
  assert.equal(remaining.size,0);
  await auth.currentUser.delete();
  await stranger.auth.currentUser.delete();
});
test('prévia servida contém só projeto demo, CSP local e todos os recursos principais',async()=>{
  for(const file of ['index.html','login.html','editor.html','painel.html','firebase-config.js','app-mode.js','site-store.js','s/loja-teste']) {
    const res = await fetch('http://127.0.0.1:5000/'+file);
    assert.equal(res.status,200,file);
    assert.match(res.headers.get('content-security-policy') || '',/http:\/\/127\.0\.0\.1:9099/,file+': '+JSON.stringify(Object.fromEntries(res.headers)));
    const body = await res.text();
    if(file==='firebase-config.js') {assert.match(body,/demo-agendafacil/);assert.doesNotMatch(body,/agenda-project-example/);}
    if(file==='app-mode.js') assert.match(body,/spark/);
    if(['firebase-config.js','app-mode.js'].includes(file)) assert.match(res.headers.get('cache-control'),/no-store/);
  }
});
