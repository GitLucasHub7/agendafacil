// Verifica arquivos candidatos ao Git; nunca imprime o conteúdo de possíveis segredos.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const files=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))];
const errors=[];
const forbiddenFile=/(^|\/)(node_modules|\.firebase|\.git|coverage)(\/|$)|(^|\/)\.env(?!\.example$)(\.|$)|\.(pem|key|p12|pfx|log|zip)$/i;
const patterns=[
  ['chave privada',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['token GitHub',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['token Mercado Pago',/\b(?:APP_USR|TEST)-\d{8,}-[A-Za-z0-9-]{15,}\b/],
  ['chave Google não fictícia',/\bAIza(?!FAKE)[A-Za-z0-9_-]{35}\b/],
  ['credencial em URL',/https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['pasta pessoal',/[A-Z]:[\\/]Users[\\/][A-Za-z0-9_ -]+[\\/]/],
];
for(const file of files) {
  if(forbiddenFile.test(file)||/serviceAccount|firebase-adminsdk/i.test(file)){errors.push(file+': arquivo proibido');continue;}
  const content=fs.readFileSync(path.join(root,file),'utf8');
  for(const [label,re] of patterns) {
    // Os testes de validação de URL contêm credenciais fictícias como entrada maliciosa.
    if(label==='credencial em URL' && file.startsWith('tests/')) continue;
    if(re.test(content)) errors.push(file+': '+label);
  }
}
try {
  const sandbox={window:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'public/firebase-config.js'),'utf8'),sandbox,{timeout:500});
  if(sandbox.window.FIREBASE_CONFIG?.projectId!=='demo-agendafacil'||sandbox.window.FIREBASE_CONFIG?.apiKey!=='demo-agendafacil-local-key'||sandbox.window.APPCHECK_SITE_KEY) errors.push('public/firebase-config.js: use somente a configuração demo no repositório');
  const rc=JSON.parse(fs.readFileSync(path.join(root,'.firebaserc'),'utf8'));
  if(Object.values(rc.projects||{}).some(id=>!id.startsWith('demo-'))) errors.push('.firebaserc: um projeto real foi incluído');
} catch {errors.push('configuração demo inválida');}
if(errors.length){errors.forEach(e=>console.error(e));process.exitCode=1;}
else console.log(`Publicação: ${files.length} arquivos verificados; configuração demo e nenhum padrão proibido encontrado.`);
