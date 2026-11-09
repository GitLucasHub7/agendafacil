#!/usr/bin/env node
/*
 * Copia config/env/<alias>.firebase-config.js para public/firebase-config.js (configuração web do projeto do ambiente).
 * NÃO inventa valores: o arquivo de origem precisa existir (copie do Console do Firebase) e é validado contra o .firebaserc.
 *   node scripts/use-env.js staging
 */
const fs = require("node:fs");
const path = require("node:path");
const { checkEnvironment } = require("./check-env");

function useEnv({ root, alias }) {
  const src = path.join(root, "config", "env", `${alias}.firebase-config.js`);
  if (!/^[a-z]+$/.test(alias || "")) return { ok: false, error: "alias inválido (use dev, staging ou prod)" };
  if (!fs.existsSync(src)) return { ok: false, error: `config/env/${alias}.firebase-config.js não existe. Crie-o com a configuração web do projeto (Console do Firebase > Configurações do projeto > Seus apps).` };
  const dest = path.join(root, "public", "firebase-config.js");
  const backup = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  fs.copyFileSync(src, dest);
  const result = checkEnvironment({ root, alias });
  const mismatch = result.errors.filter((e) => /firebase-config|apiKey|authDomain/.test(e));
  if (mismatch.length) {
    if (backup) fs.writeFileSync(dest, backup); // não deixa uma configuração errada instalada
    return { ok: false, error: `O arquivo de ${alias} não corresponde ao projeto: ${mismatch.join(" | ")}` };
  }
  return { ok: true, projectId: result.projectId };
}

if (require.main === module) {
  const r = useEnv({ root: path.resolve(__dirname, ".."), alias: process.argv[2] });
  if (!r.ok) { console.error("✖ " + r.error); process.exit(1); }
  console.log(`public/firebase-config.js agora é o do projeto ${r.projectId}.`);
}

module.exports = { useEnv };
