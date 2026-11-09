const path = require('node:path');
const {spawn} = require('node:child_process');
const {prepareLocal} = require('./prepare-local');
const root = path.resolve(__dirname,'..');
const testing = process.argv.includes('--test');
const config = prepareLocal(root);
const args = [require.resolve('firebase-tools/lib/bin/firebase.js'), testing ? 'emulators:exec' : 'emulators:start',
  '--config',config,'--project','demo-agendafacil','--only','auth,firestore,hosting'];
if(testing) args.push('node --test --test-concurrency=1 tests/local/*.test.js');
const env = {...process.env, GCLOUD_PROJECT:'demo-agendafacil', FIREBASE_CLI_DISABLE_UPDATE_CHECK:'true',
  XDG_CONFIG_HOME:path.join(root,'.firebase','validation-config')};
delete env.GOOGLE_APPLICATION_CREDENTIALS;
delete env.FIREBASE_TOKEN;
console.log(testing ? 'Testando cadastro e rascunhos apenas nos emuladores.' : 'Abra http://127.0.0.1:5000/login.html — dados locais descartáveis, sem cobrança. Ctrl+C para encerrar.');
const child = spawn(process.execPath,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
child.on('error',()=>{console.error('Não foi possível iniciar os emuladores. Confira Node 22 e Java 21.');process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code ?? 1;});
