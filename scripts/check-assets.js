// Verifica o pacote completo antes de publicar. Não carrega páginas nem acessa a rede.
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function checkAssets(root) {
  const pub = path.join(root, "public");
  const errors = [];
  const pages = fs.readdirSync(pub).filter((f) => f.endsWith(".html"));
  for (const required of ["index.html", "login.html", "editor.html", "painel.html", "site.html"]) {
    if (!pages.includes(required)) errors.push(`Página obrigatória ausente: ${required}`);
  }
  for (const page of pages) {
    const dom = new JSDOM(fs.readFileSync(path.join(pub, page), "utf8"));
    const doc = dom.window.document;
    const scripts = [...doc.querySelectorAll("script[src]")].map((el) => el.getAttribute("src"));
    const assets = [...scripts, ...[...doc.querySelectorAll('link[rel="stylesheet"][href]')].map((el) => el.getAttribute("href"))];
    for (const asset of assets) {
      if (/^(?:https?:)?\/\//.test(asset)) continue;
      const file = path.resolve(pub, asset.split(/[?#]/)[0].replace(/^\//, ""));
      if (!file.startsWith(pub + path.sep) || !fs.existsSync(file)) errors.push(`${page}: recurso ausente/inválido: ${asset}`);
    }
    const before = (dependency, consumer) => {
      if (scripts.includes(consumer) && (!scripts.includes(dependency) || scripts.indexOf(dependency) >= scripts.indexOf(consumer))) errors.push(`${page}: ${dependency} precisa carregar antes de ${consumer}`);
    };
    before("app-mode.js", "auth-shared.js");
    before("firebase-config.js", "auth-shared.js");
    before("render-shared.js", "app.js");
    before("site-store.js", "app.js");
    before("auth-shared.js", "app.js");
    dom.window.close();
  }
  return errors;
}
if (require.main === module) {
  const errors = checkAssets(path.resolve(__dirname, ".."));
  if (errors.length) { errors.forEach((e) => console.error(e)); process.exitCode = 1; }
  else console.log("Páginas, scripts, estilos e ordem de carregamento: OK.");
}
module.exports = { checkAssets };
