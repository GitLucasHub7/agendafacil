const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSiteInput, pickSiteFields, ValidationError } = require("../../functions/lib/validate");
const { slugify, isValidSlug } = require("../../functions/lib/slug");

const ok = { segment: "barbershop", name: "Maicon do Corte", primary: "#C89B3C", background: "#161514", logo: "initial", logoImage: "", schedule: "semanal", work: "solo", start: "09:00", end: "20:00", interval: "30" };
const bad = (patch, field) => assert.throws(() => validateSiteInput({ ...ok, ...patch }), (e) => e instanceof ValidationError && (!field || e.field === field));

test("aceita o site padrão do construtor e gera slug", () => {
  const { clean, slug } = validateSiteInput(ok);
  assert.equal(slug, "maicon-do-corte");
  assert.equal(clean.primary, "#c89b3c");
  assert.deepEqual(Object.keys(clean).sort(), Object.keys(ok).sort());
});

test("rejeita campos fora da lista permitida (ownerUid, published, paymentStatus, __proto__)", () => {
  for (const extra of ["ownerUid", "published", "paymentStatus", "slug", "createdAt"]) bad({ [extra]: "x" }, extra);
  assert.throws(() => validateSiteInput(JSON.parse('{"segment":"other","name":"Abc","__proto__":{"x":1}}')), ValidationError);
});

test("rejeita segmento, cores, logo, agenda e horários inválidos", () => {
  bad({ segment: "__proto__" }, "segment");
  bad({ segment: "constructor" }, "segment");
  bad({ primary: "red" }, "primary");
  bad({ background: "#12345" }, "background");
  bad({ logo: "gif" }, "logo");
  bad({ schedule: "weekly" }, "schedule");
  bad({ interval: "5" }, "interval");
  bad({ start: "25:00" }, "start");
  bad({ start: "20:00", end: "09:00" }, "end");
});

test("nome: limites, tipos e reservados", () => {
  bad({ name: "" }, "name");
  bad({ name: "a".repeat(46) }, "name");
  bad({ name: 123 }, "name");
  bad({ name: "!!!" }, "name");
  bad({ name: "Admin" }, "name");
  bad({ name: "ab\u0000c" }, "name");
  assert.equal(validateSiteInput({ ...ok, name: "  Studio   Ana  " }).clean.name, "Studio Ana");
});

test("logoImage: só data URL png/jpeg/webp; payload XSS e URL externa são rejeitados", () => {
  const good = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(validateSiteInput({ ...ok, logo: "upload", logoImage: good }).clean.logoImage, good);
  bad({ logo: "upload", logoImage: 'x" onerror="alert(1)' }, "logoImage");
  bad({ logo: "upload", logoImage: "https://evil.example/t.png" }, "logoImage");
  bad({ logo: "upload", logoImage: "data:image/svg+xml;base64,PHN2Zz4=" }, "logoImage");
  bad({ logo: "upload", logoImage: "" }, "logoImage");
  bad({ logo: "upload", logoImage: "data:image/png;base64," + "A".repeat(700001) }, "logoImage");
  bad({ logo: "upload", logoImage: 42 }, "logoImage");
  // sem logo "upload", a imagem é descartada
  assert.equal(validateSiteInput({ ...ok, logo: "star", logoImage: good }).clean.logoImage, "");
});

test("pickSiteFields devolve só campos permitidos", () => {
  assert.deepEqual(Object.keys(pickSiteFields({ ...ok, ownerUid: "u", published: true })).sort(), Object.keys(ok).sort());
});

test("slugify", () => {
  assert.equal(slugify("Ateliê da Ânia & Cia!"), "atelie-da-ania-cia");
  assert.equal(isValidSlug("ab"), false);
  assert.equal(isValidSlug("s"), false);
  assert.equal(isValidSlug("meu-site"), true);
});
