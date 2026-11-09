// Carrega uma página de public/ no jsdom com um Firebase SIMULADO (compat) e executa os scripts locais reais.
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const pub = path.join(__dirname, "..", "..", "public");

function makeFirebase(state) {
  const calls = { callable: [], signIn: [], signUp: [], reset: [], verify: 0, signOut: 0, init: 0, appCheck: [], writes: [], reads: [], userDeleted: 0 };
  const user = state.user || null;
  const listeners = [];
  const auth = {
    currentUser: user,
    onAuthStateChanged(cb) { setTimeout(() => cb(state.user || null), 0); return () => {}; },
    setPersistence: async () => {},
    useEmulator: (url) => { calls.authEmulator = url; if (state.emulatorError) throw new Error('Emulador indisponível'); },
    signInWithEmailAndPassword: async (e, p) => { calls.signIn.push([e, p]); if (state.signInError) throw { code: state.signInError }; return { user: { email: e } }; },
    createUserWithEmailAndPassword: async (e, p) => { calls.signUp.push([e, p]); if (state.signUpError) throw { code: state.signUpError }; return { user: { email: e, sendEmailVerification: async () => { calls.verify++; } } }; },
    sendPasswordResetEmail: async (e) => { calls.reset.push(e); if (state.resetError) throw { code: state.resetError }; },
    signOut: async () => { calls.signOut++; },
  };
  const docs = state.docs || {}; // "sites/ID" -> data
  const snap = (key) => ({ exists: key in docs, id: key.split("/")[1], data: () => docs[key] });
  const db = {
    collection: (name) => ({
      doc: (id) => {
        const key = `${name}/${id}`;
        const write = (op, data) => {
          if (state.writeError) { const e = state.writeError(op, key, data); if (e) throw e; }
          calls.writes.push([op, key, data]);
        };
        return {
          get: async () => { calls.reads.push(key); return snap(key); },
          onSnapshot: (cb) => { cb(snap(key)); return () => {}; },
          set: async (data) => { write("set", data); docs[key] = data; },
          update: async (data) => { write("update", data); docs[key] = { ...docs[key], ...data }; },
          delete: async () => { write("delete"); delete docs[key]; },
        };
      },
      where: (field, op, value) => ({
        get: async () => ({ docs: Object.entries(docs).filter(([k, v]) => k.startsWith(name + "/") && v[field] === value).map(([k, v]) => ({ id: k.split("/")[1], data: () => v })) }),
        onSnapshot: (cb) => {
          calls.query = [name, field, op, value];
          const rows = Object.entries(docs).filter(([k, v]) => k.startsWith(name + "/") && v[field] === value);
          cb({ docs: rows.map(([k, v]) => ({ id: k.split("/")[1], data: () => v })) });
          return () => {};
        },
      }),
    }),
    useEmulator(host, port) { calls.firestoreEmulator = [host, port]; },
  };
  const functions = {
    useEmulator() {},
    httpsCallable: (name) => async (data) => {
      calls.callable.push([name, data]);
      const handler = state.callables && state.callables[name];
      if (!handler) throw new Error("callable não simulado: " + name);
      return { data: await handler(data) };
    },
  };
  const fsFn = () => db;
  fsFn.FieldValue = { serverTimestamp: () => ({ __serverTimestamp: true }) };
  const firebase = { initializeApp(config) { calls.init++; calls.config = config; }, appCheck: state.noAppCheckSdk ? undefined : () => ({ activate: (key, auto) => calls.appCheck.push([key, auto]) }), auth: Object.assign(() => auth, { Auth: { Persistence: { LOCAL: "local" } } }), firestore: fsFn, functions: () => functions };
  user && Object.assign(user, { reload: async () => {}, getIdToken: async () => "t", sendEmailVerification: async () => { calls.verify++; }, delete: async () => { if (state.userDeleteError) throw { code: state.userDeleteError }; calls.userDeleted++; } });
  return { firebase, calls, auth };
}

async function loadPage(file, { scripts, state = {}, url, config, appCheckKey, appMode = "blaze" } = {}) {
  url = url || `http://localhost/${file}`;
  const html = fs.readFileSync(path.join(pub, file), "utf8");
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  if (appMode) w.APP_MODE = appMode;
  const fb = makeFirebase(state);
  w.firebase = fb.firebase;
  const proto = w.HTMLDialogElement ? w.HTMLDialogElement.prototype : w.HTMLElement.prototype;
  proto.showModal = function () { this.setAttribute("open", ""); };
  proto.close = function () { this.removeAttribute("open"); };
  w.scrollTo = () => {};
  const clipboard = [];
  w.navigator.clipboard = { writeText: async (t) => { clipboard.push(t); } };
  const prompts = { answer: null, asked: [] };
  w.prompt = (m) => { prompts.asked.push(m); return prompts.answer; };
  const redirects = [];
  const navigations = [];
  const confirms = { answer: true, asked: [] };
  w.confirm = (m) => { confirms.asked.push(m); return confirms.answer; };
  const run = (name) => w.eval(fs.readFileSync(path.join(pub, name), "utf8") + `\n//# sourceURL=${name}`);
  for (const name of scripts) {
    if (name === "firebase-config.js" && config !== undefined) { w.FIREBASE_CONFIG = config; if (appCheckKey) w.APPCHECK_SITE_KEY = appCheckKey; continue; }
    run(name);
    if (name === "auth-shared.js") { w.AF.go = (u) => redirects.push(u); w.AF.navigate = (u) => navigations.push(u); }
  }
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  return { w, doc: w.document, calls: fb.calls, redirects, navigations, confirms, clipboard, prompts, tick };
}

module.exports = { loadPage };
