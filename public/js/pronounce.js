// Guía de pronunciación.
// - Español: silabeo + sílaba tónica según las reglas de acentuación de la
//   RAE (palabras agudas/llanas según terminación, o tilde explícita).
// - Inglés: transcripción IPA y audio real de diccionario (dictionaryapi.dev).

const VOWELS = 'aeiouáéíóúü';
const WEAK = 'iuü';
const VALID_ONSETS = new Set([
  'pr', 'br', 'tr', 'dr', 'cr', 'gr', 'fr', 'pl', 'bl', 'cl', 'gl', 'fl',
  'ch', 'll', 'rr'
]);

const isV = (c) => VOWELS.includes(c);
const isWeak = (c) => WEAK.includes(c);

// Divide una palabra española en sílabas (aproximación por reglas).
export function syllabifyEs(word) {
  const w = word.toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  if (w.length < 2) return w ? [w] : [];

  // 1) unidades: consonantes sueltas y núcleos vocálicos (con diptongos)
  const units = [];
  let i = 0;
  while (i < w.length) {
    if (!isV(w[i])) {
      // dígrafos inseparables como una sola consonante
      const two = w.slice(i, i + 2);
      if (two === 'ch' || two === 'll' || two === 'rr') {
        units.push({ c: two });
        i += 2;
      } else {
        units.push({ c: w[i] });
        i++;
      }
      continue;
    }
    let nuc = w[i++];
    while (i < w.length && isV(w[i])) {
      const prev = nuc[nuc.length - 1];
      const cur = w[i];
      // hiato: dos fuertes, o débil acentuada junto a otra vocal
      const hiato = (!isWeak(prev) && !isWeak(cur)) || 'íú'.includes(cur) || 'íú'.includes(prev);
      if (hiato) break;
      nuc += cur;
      i++;
    }
    units.push({ v: nuc });
  }

  // 2) repartir consonantes entre núcleos
  const sylls = [];
  let cur = '';
  let k = 0;
  while (k < units.length) {
    // consonantes acumuladas antes del próximo núcleo
    const consRun = [];
    while (k < units.length && units[k].c !== undefined) {
      consRun.push(units[k].c);
      k++;
    }
    if (k >= units.length) {
      // consonantes finales: se pegan a la última sílaba
      if (sylls.length) sylls[sylls.length - 1] += consRun.join('');
      else if (consRun.length) sylls.push(consRun.join(''));
      break;
    }
    const nucleus = units[k].v;
    k++;
    if (!sylls.length && !cur) {
      // arranque de palabra: todas las consonantes iniciales van con el núcleo
      cur = consRun.join('') + nucleus;
      sylls.push(cur);
      cur = '';
      continue;
    }
    // repartir el grupo consonántico entre la sílaba anterior y la nueva
    let left = '';
    let right = '';
    const n = consRun.length;
    if (n === 0) {
      // nada que repartir
    } else if (n === 1) {
      right = consRun[0];
    } else if (n === 2) {
      if (VALID_ONSETS.has(consRun.join(''))) right = consRun.join('');
      else { left = consRun[0]; right = consRun[1]; }
    } else {
      const lastTwo = consRun.slice(-2).join('');
      if (VALID_ONSETS.has(lastTwo)) {
        left = consRun.slice(0, -2).join('');
        right = lastTwo;
      } else {
        left = consRun.slice(0, -1).join('');
        right = consRun[consRun.length - 1];
      }
    }
    if (left) sylls[sylls.length - 1] += left;
    sylls.push(right + nucleus);
  }
  return sylls.filter(Boolean);
}

// Guía en español: "in·te·li·GEN·cia" (tónica en mayúsculas, reglas RAE).
export function guideEs(word) {
  const syl = syllabifyEs(word);
  if (!syl.length) return '';
  if (syl.length === 1) return syl[0];
  let idx = syl.findIndex((s) => /[áéíóú]/.test(s));
  if (idx < 0) {
    const clean = word.toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
    idx = /[aeiouns]$/.test(clean) ? syl.length - 2 : syl.length - 1;
  }
  return syl.map((s, i) => (i === idx ? s.toUpperCase() : s)).join('·');
}

// Guía en inglés: IPA + audio de diccionario (gratuito, con CORS abierto).
const enCache = {};

export async function guideEn(word) {
  const norm = word.toLowerCase().replace(/[^a-z'-]/g, '');
  if (!norm) return { ipa: '', audioUrl: '' };
  if (enCache[norm]) return enCache[norm];
  try {
    const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(norm));
    if (!res.ok) throw new Error('sin entrada');
    const data = await res.json();
    let ipa = '';
    let audioUrl = '';
    for (const entry of Array.isArray(data) ? data : []) {
      for (const ph of entry.phonetics || []) {
        if (!ipa && ph.text) ipa = ph.text;
        if (!audioUrl && ph.audio) audioUrl = ph.audio;
      }
      if (!ipa && entry.phonetic) ipa = entry.phonetic;
      if (ipa && audioUrl) break;
    }
    enCache[norm] = { ipa, audioUrl };
  } catch {
    enCache[norm] = { ipa: '', audioUrl: '' };
  }
  return enCache[norm];
}
