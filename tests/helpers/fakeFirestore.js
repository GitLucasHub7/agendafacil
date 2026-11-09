// Firestore simulado em memória: só o necessário para testar lib/sites.js (sem emulador).
const SERVER_TS = { __serverTimestamp: true };
const FieldValue = { serverTimestamp: () => SERVER_TS };

function createFakeDb() {
  const store = new Map(); // "col/id" -> data
  const versions = new Map(); // "col/id" -> n (controle otimista, como no Firestore real)
  const colVersions = new Map(); // coleção -> n (consultas)
  const bump = (key) => {
    versions.set(key, (versions.get(key) || 0) + 1);
    const col = key.split("/")[0];
    colVersions.set(col, (colVersions.get(col) || 0) + 1);
  };
  let autoId = 0;
  const resolve = (v) => (v && v.__serverTimestamp ? "TS" : v);
  const clean = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => {
    if (v === undefined) throw new Error(`Firestore não aceita undefined (campo ${k})`);
    return [k, resolve(v)];
  }));

  function docRef(col, id) {
    const key = `${col}/${id}`;
    return {
      id,
      path: key,
      _key: key,
      async get() {
        const exists = store.has(key);
        return { exists, id, data: () => (exists ? structuredClone(store.get(key)) : undefined) };
      },
      async set(data, opts) {
        const prev = opts && opts.merge && store.has(key) ? store.get(key) : {};
        store.set(key, { ...prev, ...clean(data) });
        bump(key);
      },
      async update(data) {
        if (db.failUpdateFor && key.startsWith(db.failUpdateFor.prefix) && db.failUpdateFor.when(data)) {
          db.failUpdateFor = null; // falha única, para simular indisponibilidade do Firestore
          throw new Error("UNAVAILABLE: firestore indisponível");
        }
        if (!store.has(key)) throw new Error("NOT_FOUND " + key);
        store.set(key, { ...store.get(key), ...clean(data) });
        bump(key);
      },
      async create(data) {
        if (store.has(key)) throw Object.assign(new Error("ALREADY_EXISTS " + key), { code: 6 });
        store.set(key, clean(data));
        bump(key);
      },
      async delete() {
        store.delete(key);
        bump(key);
      },
    };
  }

  function query(col, filters) {
    return {
      _col: col,
      where(field, op, value) {
        if (op !== "==") throw new Error("só == suportado");
        return query(col, [...filters, [field, value]]);
      },
      async get() {
        const docs = [];
        for (const [key, data] of store) {
          const [c, id] = key.split("/");
          if (c === col && filters.every(([f, v]) => data[f] === v)) docs.push({ id, data: () => structuredClone(data) });
        }
        return { size: docs.length, docs };
      },
    };
  }

  const db = {
    _store: store,
    failUpdateFor: null,
    collection(col) {
      return {
        doc(id) {
          return docRef(col, id === undefined ? `auto${String(++autoId).padStart(10, "0")}` : id);
        },
        where: (f, o, v) => query(col, []).where(f, o, v),
        get: () => query(col, []).get(),
      };
    },
    async runTransaction(fn) {
      // Modela o Firestore: leituras registram versões; no commit, se algo lido mudou, a transação é REEXECUTADA.
      for (let attempt = 0; attempt < 6; attempt++) {
        const reads = [];
        const writes = [];
        const tx = {
          async get(ref) {
            if (ref._key) reads.push(["doc", ref._key, versions.get(ref._key) || 0]);
            else reads.push(["col", ref._col, colVersions.get(ref._col) || 0]);
            return ref.get();
          },
          set: (ref, data) => writes.push(() => ref.set(data)),
          update: (ref, data) => writes.push(() => ref.update(data)),
          delete: (ref) => writes.push(() => ref.delete()),
        };
        const result = await fn(tx);
        const stale = reads.some(([kind, k, v]) => (kind === "doc" ? versions.get(k) || 0 : colVersions.get(k) || 0) !== v);
        if (stale) continue; // outra escrita concorrente venceu: tenta de novo
        // commit atômico (síncrono: nada intercala entre a validação e as escritas)
        for (const w of writes) {
          const r = w();
          if (r && typeof r.then === "function") r.catch(() => {});
        }
        return result;
      }
      throw Object.assign(new Error("ABORTED: too much contention"), { code: 10 });
    },
    seed(path, data) {
      store.set(path, data);
    },
  };
  return db;
}

module.exports = { createFakeDb, FieldValue };
