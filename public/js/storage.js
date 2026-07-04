// Persistencia de sesiones en IndexedDB (incluye el video como Blob).

const DB_NAME = 'dialog-db';
const STORE = 'sessions';
const WORDS = 'words';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(WORDS)) db.createObjectStore(WORDS, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(session);
    tx.oncomplete = () => resolve(session.id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      all.sort((a, b) => b.id - a.id);
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getSession(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- palabras difíciles (entrenador de pronunciación) ----

function wordKey(lang, norm) {
  return `${lang}:${norm}`;
}

async function getWordTx(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(WORDS).objectStore(WORDS).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function putWord(db, word) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORDS, 'readwrite');
    tx.objectStore(WORDS).put(word);
    tx.oncomplete = () => resolve(word);
    tx.onerror = () => reject(tx.error);
  });
}

// Registra que una palabra se trabó durante una lectura.
export async function upsertWordMiss(lang, raw, norm) {
  const db = await openDb();
  const key = wordKey(lang, norm);
  const w = (await getWordTx(db, key)) || {
    key, raw, lang, addedAt: new Date().toISOString(),
    fails: 0, attempts: 0, streak: 0, mastered: false
  };
  w.fails++;
  if (w.mastered) { w.mastered = false; w.streak = 0; } // recayó
  return putWord(db, w);
}

// Registra un intento de pronunciación (prueba con micrófono).
export async function recordWordAttempt(lang, raw, norm, ok) {
  const db = await openDb();
  const key = wordKey(lang, norm);
  const w = (await getWordTx(db, key)) || {
    key, raw, lang, addedAt: new Date().toISOString(),
    fails: 0, attempts: 0, streak: 0, mastered: false
  };
  w.attempts++;
  w.lastTriedAt = new Date().toISOString();
  if (ok) {
    w.streak++;
    if (w.streak >= 3) w.mastered = true;
  } else {
    w.streak = 0;
    w.mastered = false;
  }
  return putWord(db, w);
}

// Guarda datos de pronunciación (IPA, audio) en una palabra existente.
export async function saveWordInfo(key, info) {
  const db = await openDb();
  const w = await getWordTx(db, key);
  if (!w) return null;
  Object.assign(w, info);
  return putWord(db, w);
}

export async function listWords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(WORDS).objectStore(WORDS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteWord(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORDS, 'readwrite');
    tx.objectStore(WORDS).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
