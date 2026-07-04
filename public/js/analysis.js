// Análisis de la lectura: alineación guion vs transcripción, WPM, muletillas, pausas.

// Muletillas de una sola palabra. Solo cuentan si son INSERCIONES
// (palabras dichas que no están en el guion), así no se penalizan
// palabras legítimas del texto.
const FILLERS = new Set([
  // español
  'eh', 'ehh', 'em', 'emm', 'mm', 'mmm', 'este', 'estee',
  'pues', 'bueno', 'entonces', 'osea', 'digo', 'verdad',
  'aja', 'ajam', 'okey', 'ok', 'ya', 'como',
  // inglés
  'um', 'uh', 'uhm', 'er', 'hmm', 'like', 'so', 'well',
  'actually', 'basically', 'right', 'okay', 'yeah', 'kinda', 'sorta'
]);

export function normalizeWord(w) {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function tokenize(text) {
  return text
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalizeWord(raw) }))
    .filter((t) => t.norm.length > 0);
}

// LCS palabra a palabra entre guion y transcripción.
// Devuelve por cada token del guion si fue leído, y por cada token
// de la transcripción si fue una inserción.
function align(scriptTokens, saidTokens) {
  const m = scriptTokens.length;
  const n = saidTokens.length;
  const W = n + 1;
  const dp = new Uint16Array((m + 1) * W);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * W + j] =
        scriptTokens[i].norm === saidTokens[j].norm
          ? dp[(i + 1) * W + j + 1] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const scriptMatched = new Array(m).fill(false);
  const saidMatched = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (scriptTokens[i].norm === saidTokens[j].norm) {
      scriptMatched[i] = true;
      saidMatched[j] = true;
      i++; j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { scriptMatched, saidMatched };
}

/**
 * @param {string} scriptText  guion original
 * @param {string} saidText    transcripción de lo dicho
 * @param {number} durationMs  duración de la grabación
 * @param {Array<{startMs:number,durMs:number}>} pauses  silencios detectados
 * @param {Array<{tMs:number,words:number}>} chunks  resultados de voz con marca de tiempo
 */
export function computeMetrics(scriptText, saidText, durationMs, pauses, chunks) {
  const scriptTokens = tokenize(scriptText);
  const saidTokens = tokenize(saidText);
  const { scriptMatched, saidMatched } = align(scriptTokens, saidTokens);

  const matched = scriptMatched.filter(Boolean).length;
  const accuracy = scriptTokens.length ? matched / scriptTokens.length : 0;

  // Muletillas: inserciones que están en el léxico de fillers,
  // más el bigrama "o sea" insertado.
  let fillerCount = 0;
  const fillerFlags = new Array(saidTokens.length).fill(false);
  for (let k = 0; k < saidTokens.length; k++) {
    if (saidMatched[k]) continue;
    const bigram =
      k + 1 < saidTokens.length && !saidMatched[k + 1]
        ? saidTokens[k].norm + ' ' + saidTokens[k + 1].norm
        : '';
    if (FILLERS.has(saidTokens[k].norm)) {
      fillerCount++;
      fillerFlags[k] = true;
    } else if (bigram === 'o sea' || bigram === 'you know' || bigram === 'i mean') {
      fillerCount++;
      fillerFlags[k] = true;
      fillerFlags[k + 1] = true;
    }
  }

  const minutes = Math.max(durationMs / 60000, 0.01);
  const wpm = Math.round(saidTokens.length / minutes);

  const longPauses = (pauses || []).filter((p) => p.durMs >= 1500);
  const totalPauseMs = longPauses.reduce((s, p) => s + p.durMs, 0);

  // WPM por tramos de 30 s para ver si el ritmo fue parejo.
  const buckets = [];
  if (chunks && chunks.length) {
    const nBuckets = Math.max(1, Math.ceil(durationMs / 30000));
    for (let b = 0; b < nBuckets; b++) buckets.push(0);
    for (const c of chunks) {
      const b = Math.min(buckets.length - 1, Math.floor(c.tMs / 30000));
      buckets[b] += c.words;
    }
    for (let b = 0; b < buckets.length; b++) {
      const spanMs = Math.min(30000, durationMs - b * 30000);
      buckets[b] = Math.round(buckets[b] / Math.max(spanMs / 60000, 0.05));
    }
  }

  return {
    durationMs,
    wordsScript: scriptTokens.length,
    wordsSaid: saidTokens.length,
    accuracy: Math.round(accuracy * 100),
    wpm,
    wpmBuckets: buckets,
    fillerCount,
    longPauseCount: longPauses.length,
    totalPauseMs,
    diff: {
      script: scriptTokens.map((t, idx) => ({ raw: t.raw, ok: scriptMatched[idx] })),
      insertions: saidTokens
        .map((t, idx) => ({ raw: t.raw, idx, filler: fillerFlags[idx], matched: saidMatched[idx] }))
        .filter((t) => !t.matched)
    }
  };
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
