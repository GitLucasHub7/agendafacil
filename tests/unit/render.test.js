const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const serverSlug = require("../../functions/lib/slug");

const root = path.join(__dirname, "..", "..");
function loadRender(source) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "public/site.html"), "utf8"), { runScripts: "outside-only" });
  dom.window.eval(source);
  return { window: dom.window, R: dom.window.AgendaFacilRender, page: dom.window.document.querySelector("#site-preview") || dom.window.document.body };
}
const current = () => fs.readFileSync(path.join(root, "public/render-shared.js"), "utf8");

const base = { segment: "barbershop", name: "Maicon", primary: "#c89b3c", background: "#161514", logo: "upload", logoImage: "", schedule: "semanal" };
const payloads = [
  'x" onerror="window.__xss=1"',
  'data:image/png;base64,AAAA" onerror="window.__xss=1',
  '"><script>window.__xss=1</script>',
  "https://evil.example/pixel.png",
  "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
];
function renderWith(source, patch) {
  const { window, R } = loadRender(source);
  const doc = window.document;
  const rootEl = doc.body;
  R.renderSiteInto(rootEl, { ...base, ...patch });
  return { window, doc };
}
const dangerous = (doc) => [...doc.querySelectorAll("*")].some((el) => [...el.attributes].some((a) => /^on/i.test(a.name))) || doc.querySelector("script:not([src])") !== null;

test("CONTROLE sintético: o detector reconhece um atributo HTML injetado", () => {
  const dom = new JSDOM(`<img src="${payloads[0]}">`, { runScripts: "outside-only" });
  assert.equal(dangerous(dom.window.document), true, "o detector precisa reconhecer onerror");
  dom.window.close();
});

test("versão corrigida: nenhum payload gera handler on*, script inline nem imagem externa", () => {
  for (const p of payloads) {
    const { doc, window } = renderWith(current(), { logoImage: p });
    assert.equal(dangerous(doc), false, `payload: ${p}`);
    assert.equal(window.__xss, undefined);
    for (const img of doc.querySelectorAll("img")) assert.match(img.getAttribute("src"), /^data:image\/(png|jpeg|webp);base64,/);
  }
});

test("imagem legítima continua aparecendo; nome com HTML é exibido como texto", () => {
  const good = "data:image/png;base64,iVBORw0KGgo=";
  const { doc } = renderWith(current(), { logoImage: good, name: '<img src=x onerror="window.__xss=1">Barbearia' });
  assert.equal(doc.querySelector("#preview-logo-content img").getAttribute("src"), good);
  assert.equal(doc.querySelector("#preview-name-nav").textContent, '<img src=x onerror="window.__xss=1">Barbearia');
  assert.equal(dangerous(doc), false);
});

test("segment hostil (__proto__, constructor) não derruba a renderização; cores inválidas caem no padrão", () => {
  for (const segment of ["__proto__", "constructor", "toString", 5, null]) {
    assert.doesNotThrow(() => renderWith(current(), { segment, logo: "initial" }), String(segment));
  }
  const { doc } = renderWith(current(), { logo: "initial", primary: "red;background:url(//evil)", background: "javascript:1" });
  assert.equal(doc.body.style.getPropertyValue("--primary"), "#c89b3c");
  assert.equal(doc.body.style.getPropertyValue("--site-bg"), "#161514");
});

test("slugify do navegador é idêntico ao do servidor", () => {
  const { R } = loadRender(current());
  for (const name of ["Maicon do Corte", "Ateliê da Ânia & Cia!", "  Studio   Ana  ", "ÇÃO--x", "a".repeat(80), "Bárbara's Nails 2024"]) {
    assert.equal(R.slugify(name), serverSlug.slugify(name), name);
  }
});

test("parseSlugFromPath: aceita /s/slug; rejeita inválidos, % malformado, caminhos extras e raiz", () => {
  const { R } = loadRender(current());
  const ok = { "/s/meu-site": "meu-site", "/s/meu-site/": "meu-site", "/s/Meu-Site": "meu-site", "/s/a1b": "a1b" };
  for (const [path, slug] of Object.entries(ok)) assert.equal(R.parseSlugFromPath(path), slug, path);
  for (const bad of ["/s/", "/s", "/", "/s/a", "/s/-ab", "/s/ab-", "/s/a_b", "/s/a b", "/s/%E0%A4%A", "/s/%2e%2e", "/s/meu-site/extra", "/x/meu-site", "/s/" + "a".repeat(46), "/s/__proto__", "/s/a.b", null, undefined]) {
    assert.equal(R.parseSlugFromPath(bad), null, String(bad));
  }
});
