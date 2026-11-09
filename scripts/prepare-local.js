// Gera uma prévia descartável. Só copia recursos públicos; nunca lê .env ou credenciais.
const fs = require('node:fs');
const path = require('node:path');
function prepareLocal(root = path.resolve(__dirname, '..')) {
  const target = path.join(root, '.firebase', 'local-preview');
  const publicDir = path.join(target, 'public');
  fs.mkdirSync(publicDir, {recursive:true});
  for (const entry of fs.readdirSync(path.join(root, 'public'), {withFileTypes:true})) {
    if (entry.isFile() && /\.(html|css|js|svg|png|jpg|webp|ico)$/.test(entry.name) && entry.name !== 'firebase-config.js' && entry.name !== 'app-mode.js') {
      fs.copyFileSync(path.join(root,'public',entry.name), path.join(publicDir,entry.name));
    }
  }
  fs.writeFileSync(path.join(publicDir,'firebase-config.js'), 'window.FIREBASE_CONFIG = '+JSON.stringify({apiKey:'demo-agendafacil-local-key',projectId:'demo-agendafacil',authDomain:'demo-agendafacil.firebaseapp.com',appId:'1:123:web:local'})+';\nwindow.APPCHECK_SITE_KEY = "";\n');
  fs.writeFileSync(path.join(publicDir,'app-mode.js'), 'window.APP_MODE = "spark";\n');
  fs.copyFileSync(path.join(root,'firestore.rules'),path.join(target,'firestore.rules'));
  const base = JSON.parse(fs.readFileSync(path.join(root,'firebase.json'),'utf8'));
  const hosting = {...base.hosting, public:'public', predeploy:['node -e "process.exit(1)"']};
  // O servidor local normaliza globs com barras do Windows. Regex mantém headers e /s/ funcionais.
  const localPatterns = {'**':'.*','**/*.html':'.*\\.html$','/@(firebase-config|app-mode).js':'.*(firebase-config|app-mode)\\.js$','/s/**':'^[/\\\\]s[/\\\\].*'};
  for(const item of [...(hosting.headers || []),...(hosting.rewrites || [])]) {
    if(localPatterns[item.source]) {item.regex=localPatterns[item.source];delete item.source;}
  }
  for(const group of hosting.headers || []) for(const header of group.headers || []) {
    if(header.key === 'Content-Security-Policy') header.value = header.value.replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:9099 http://127.0.0.1:8080 http://127.0.0.1:5001");
  }
  const config = {firestore:{rules:'firestore.rules'},hosting,emulators:{
    auth:{host:'127.0.0.1',port:9099},firestore:{host:'127.0.0.1',port:8080},hosting:{host:'127.0.0.1',port:5000},
    hub:{host:'127.0.0.1',port:4400},logging:{host:'127.0.0.1',port:4500},ui:{enabled:false},singleProjectMode:true,
  }};
  fs.writeFileSync(path.join(target,'firebase.json'),JSON.stringify(config,null,2)+'\n');
  return path.join(target,'firebase.json');
}
if(require.main === module) console.log(prepareLocal());
module.exports = {prepareLocal};
