import { computeMetrics, formatDuration, normalizeWord } from './analysis.js';
import { saveSession, listSessions, getSession, deleteSession } from './storage.js';
import { preloadModel, startLiveRecognition } from './vosk-live.js';

const $ = (id) => document.getElementById(id);

// En móviles Web Speech no puede escuchar mientras se graba (micrófono
// exclusivo): ahí el reconocimiento en vivo corre con Vosk (WASM), que
// lee el audio del mismo stream de la grabación.
const IS_MOBILE = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);

const screens = ['screen-setup', 'screen-preview', 'screen-practice', 'screen-results', 'screen-history'];
function show(screenId) {
  for (const s of screens) $(s).classList.toggle('hidden', s !== screenId);
  $('nav-practice').classList.toggle('active', screenId !== 'screen-history');
  $('nav-history').classList.toggle('active', screenId === 'screen-history');
}

// ---------- estado ----------
let currentScript = { title: '', text: '', source: '' };
let mediaStream = null;
let recorder = null;
let recordedChunks = [];
let recStartMs = 0;
let recTimerInt = null;
let recognition = null;
let finalTranscript = '';
let speechChunks = []; // {tMs, words}
let pauses = [];
let silenceMonitor = null;
let autoScrollRaf = null;
let lastSessionBlob = null;

// Seguidor de voz: posición de lectura dentro del guion del teleprompter.
let prompterSpans = [];
let followTokens = [];
let readPos = 0;
let fedCounts = {};
let lastFollowScroll = 0;
let speechAvailable = false;
let useVoskLive = false;
let voskSession = null;
let discardRecording = false;
let hadAudioTrack = true;

// Detección de micrófono ocupado: en móviles el reconocimiento de voz no
// puede escuchar mientras se graba video (el mic es exclusivo).
let recogResultCount = 0;
let recogErrorCount = 0;
let recogGivenUp = false;
let recogWatchdog = null;
let speechWarningDefault = ''; // se captura del HTML al cargar

// ---------- noticias ----------
let newsItems = [];
let currentCat = 'lima';

async function loadNews(force = false) {
  const status = $('news-status');
  status.textContent = 'Cargando noticias…';
  status.classList.remove('hidden');
  $('news-list').innerHTML = '';
  try {
    const res = await fetch('/api/news' + (force ? '?force=1' : ''));
    const data = await res.json();
    newsItems = data.items || [];
    if (!newsItems.length) {
      status.textContent = 'No se pudieron cargar noticias. Pega un texto manualmente.';
      return;
    }
    status.classList.add('hidden');
    renderNewsList();
  } catch {
    status.textContent = 'Error al conectar con el servidor de noticias.';
  }
}

function renderNewsList() {
  const list = $('news-list');
  list.innerHTML = '';
  const filtered = newsItems.filter((it) => it.cat === currentCat);
  if (!filtered.length) {
    list.innerHTML = '<li class="muted">No hay noticias en esta categoría ahora mismo.</li>';
    return;
  }
  for (const item of filtered) {
    const li = document.createElement('li');
    const date = item.date ? new Date(item.date).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const langBadge = `<span class="badge ${item.lang || 'es'}">${(item.lang || 'es').toUpperCase()}</span>`;
    li.innerHTML = `<div class="news-title"></div><div class="news-meta">${langBadge} ${item.source} · ${date}</div>`;
    li.querySelector('.news-title').textContent = item.title;
    li.addEventListener('click', () => pickArticle(item, li));
    list.appendChild(li);
  }
}

async function pickArticle(item, li) {
  if (li.classList.contains('unavailable')) return;
  const orig = li.innerHTML;
  li.innerHTML = '<div class="news-meta">⏳ Descargando artículo…</div>';
  try {
    const res = await fetch('/api/article?url=' + encodeURIComponent(item.link));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'error');
    li.innerHTML = orig;
    openPreview({ title: data.title || item.title, text: data.text, source: item.source, lang: item.lang });
  } catch {
    // Algunos medios tienen paywall o bloquean la descarga: se marca y listo.
    li.innerHTML = orig;
    li.classList.add('unavailable');
    li.querySelector('.news-meta').textContent = '✕ No disponible (paywall o bloqueo del medio) — elige otra noticia';
  }
}

// ---------- previsualización ----------

// Heurística simple de idioma por palabras funcionales.
function detectLang(text) {
  const t = ' ' + text.toLowerCase().replace(/[^a-záéíóúñü]+/g, ' ') + ' ';
  const count = (words) => words.reduce((n, w) => n + t.split(` ${w} `).length - 1, 0);
  const es = count(['el', 'la', 'de', 'que', 'los', 'una', 'para', 'con', 'del']);
  const en = count(['the', 'and', 'of', 'to', 'in', 'for', 'with', 'that', 'is']);
  return en > es ? 'en' : 'es';
}

// Versiones del guion en cada idioma (para alternar sin re-traducir).
let scriptVersions = { es: null, en: null };
let translateInflight = { es: null, en: null };
let editGen = 0; // invalida traducciones en curso si el usuario edita el texto

function openPreview({ title, text, source, lang }) {
  currentScript = { title, text, source, lang: lang || detectLang(text) };
  scriptVersions = { es: null, en: null };
  translateInflight = { es: null, en: null };
  editGen++;
  scriptVersions[currentScript.lang] = { title, text };
  $('script-title').value = title;
  $('script-text').value = text;
  updateScriptStats();
  updateLangButtons();
  show('screen-preview');
  // Pre-traduce al otro idioma en segundo plano: el cambio será instantáneo.
  const other = currentScript.lang === 'es' ? 'en' : 'es';
  ensureVersion(other).catch(() => {});
}

function updateLangButtons() {
  $('btn-lang-es').classList.toggle('active', currentScript.lang === 'es');
  $('btn-lang-en').classList.toggle('active', currentScript.lang === 'en');
}

function ensureVersion(target) {
  if (scriptVersions[target]) return Promise.resolve(scriptVersions[target]);
  if (translateInflight[target]) return translateInflight[target];
  const gen = editGen;
  const payload = { title: $('script-title').value, text: $('script-text').value, to: target };
  translateInflight[target] = fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo traducir');
      const version = { title: data.title || payload.title, text: data.text };
      if (gen === editGen) scriptVersions[target] = version;
      return version;
    })
    .finally(() => { translateInflight[target] = null; });
  return translateInflight[target];
}

async function setScriptLang(target) {
  if (target === currentScript.lang) return;
  // Guarda lo que el usuario tenga escrito como versión del idioma actual.
  scriptVersions[currentScript.lang] = { title: $('script-title').value, text: $('script-text').value };
  let version = scriptVersions[target];
  if (!version) {
    $('script-overlay').classList.remove('hidden');
    $('btn-lang-es').disabled = $('btn-lang-en').disabled = $('btn-start-practice').disabled = true;
    try {
      version = await ensureVersion(target);
    } catch (e) {
      $('script-stats').textContent = '⚠️ ' + (e.message || 'No se pudo traducir. Intenta de nuevo.');
      $('script-stats').style.color = 'var(--orange)';
      return;
    } finally {
      $('script-overlay').classList.add('hidden');
      $('btn-lang-es').disabled = $('btn-lang-en').disabled = $('btn-start-practice').disabled = false;
    }
  }
  currentScript.lang = target;
  $('script-title').value = version.title;
  $('script-text').value = version.text;
  updateScriptStats();
  updateLangButtons();
}

function updateScriptStats() {
  const words = $('script-text').value.trim().split(/\s+/).filter(Boolean).length;
  const min = (words / 140).toFixed(1);
  const over = words > 440;
  $('script-stats').textContent = `${words} palabras · ~${min} min de lectura` + (over ? ' — supera los 3 min, usa "Recortar"' : '');
  $('script-stats').style.color = over ? 'var(--orange)' : '';
  $('btn-trim').classList.toggle('hidden', !over);
}

function trimScriptTo3Min() {
  const sentences = $('script-text').value.trim().split(/(?<=[.!?…])\s+/);
  const out = [];
  let count = 0;
  for (const s of sentences) {
    const w = s.split(/\s+/).length;
    if (count + w > 420 && count > 0) break;
    out.push(s);
    count += w;
  }
  $('script-text').value = out.join(' ');
  updateScriptStats();
}

// ---------- práctica ----------
async function startPractice() {
  currentScript.title = $('script-title').value.trim() || 'Práctica sin título';
  currentScript.text = $('script-text').value.trim();
  currentScript.lang = detectLang(currentScript.text);
  if (currentScript.text.split(/\s+/).length < 20) {
    alert('El guion es muy corto. Agrega más texto.');
    return;
  }
  $('rec-lang').value = currentScript.lang === 'en' ? 'en-US' : 'es-419';
  renderPrompter(currentScript.text);
  $('prompter').scrollTop = 0;
  show('screen-practice');
  speechAvailable = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  useVoskLive = !speechAvailable;
  // En el celular el micrófono es exclusivo: se dedica al reconocimiento
  // (prioridad: que siga tu voz) y el video se graba sin audio.
  const muteVideo = IS_MOBILE && speechAvailable;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: muteVideo ? false : { echoCancellation: true, noiseSuppression: true }
    });
    $('cam-preview').srcObject = mediaStream;
    $('mobile-note').classList.toggle('hidden', !muteVideo);
  } catch (e) {
    alert('No se pudo acceder a la cámara/micrófono: ' + e.message +
      '\n\nSi entras desde el celular usa la dirección https:// y acepta el certificado.');
    show('screen-preview');
    return;
  }
  $('speech-warning').textContent = speechWarningDefault;
  $('speech-warning').classList.add('hidden');
  if (useVoskLive) {
    // Sin Web Speech: se precarga el modelo Vosk mientras el usuario se acomoda.
    const langKey = $('rec-lang').value.startsWith('en') ? 'en' : 'es';
    preloadModel(langKey, (msg) => { $('recog-status').textContent = msg; })
      .catch(() => {
        $('recog-status').textContent = '';
        $('speech-warning').classList.remove('hidden');
      });
  }
  updateScrollControls();
}

// Construye el teleprompter palabra por palabra para poder resaltar
// por dónde vas leyendo.
function renderPrompter(text) {
  const prompter = $('prompter');
  prompter.innerHTML = '';
  prompterSpans = [];
  followTokens = [];
  readPos = 0;
  const frag = document.createDocumentFragment();
  for (const piece of text.split(/(\s+)/)) {
    const norm = normalizeWord(piece);
    if (norm) {
      const span = document.createElement('span');
      span.textContent = piece;
      frag.appendChild(span);
      prompterSpans.push(span);
      followTokens.push(norm);
    } else if (piece) {
      frag.appendChild(document.createTextNode(piece));
    }
  }
  prompter.appendChild(frag);
}

// Avanza la posición de lectura con tres defensas contra adelantarse:
// 1) descarta duplicados re-emitidos (Chrome en Android repite tramos),
// 2) los saltos hacia adelante requieren confirmación (palabra larga o
//    dos palabras seguidas que coincidan en secuencia),
// 3) límite físico de velocidad (~240 palabras/min).
let lastAdvanceTimes = [];
let lastFedWords = [];

function advanceFollower(words) {
  // Deduplicación: si el tramo entrante repite la cola de lo ya procesado,
  // se descarta ese prefijo.
  let start = 0;
  outer: for (let ov = Math.min(lastFedWords.length, words.length); ov > 0; ov--) {
    for (let k = 0; k < ov; k++) {
      if (lastFedWords[lastFedWords.length - ov + k] !== words[k]) continue outer;
    }
    start = ov;
    break;
  }
  const fresh = words.slice(start).filter(Boolean);
  if (!fresh.length) return;
  lastFedWords = lastFedWords.concat(fresh).slice(-12);

  let moved = false;
  for (let wi = 0; wi < fresh.length; wi++) {
    if (readPos >= followTokens.length) break;
    const w = fresh[wi];
    // Caso normal: es exactamente la siguiente palabra del guion.
    if (followTokens[readPos] === w) {
      if (advanceTo(readPos + 1)) moved = true;
      continue;
    }
    // Salto corto solo con confirmación.
    const limit = Math.min(readPos + 6, followTokens.length);
    for (let j = readPos + 1; j < limit; j++) {
      if (followTokens[j] !== w) continue;
      const isLong = w.length >= 5;
      const next = fresh[wi + 1];
      const bigramOk = next && j + 1 < followTokens.length && followTokens[j + 1] === next;
      if (isLong || bigramOk) {
        if (advanceTo(j + 1)) moved = true;
      }
      break;
    }
  }
  if (moved) markCurrentAndScroll();
}

// Aplica el avance respetando el límite de velocidad de lectura humana.
function advanceTo(target) {
  const now = performance.now();
  lastAdvanceTimes = lastAdvanceTimes.filter((t) => now - t < 2000);
  const budget = 8 - lastAdvanceTimes.length; // máx 8 palabras por 2 s
  if (budget <= 0) return false;
  target = Math.min(target, readPos + budget, followTokens.length);
  if (target <= readPos) return false;
  for (let k = readPos; k < target; k++) {
    prompterSpans[k].classList.add('read');
    lastAdvanceTimes.push(now);
  }
  readPos = target;
  return true;
}

function markCurrentAndScroll() {
  const current = prompterSpans[Math.min(readPos, prompterSpans.length - 1)];
  prompterSpans.forEach((s) => s.classList.remove('current'));
  current.classList.add('current');
  const now = performance.now();
  if ($('scroll-mode').value === 'voz' && now - lastFollowScroll > 600) {
    lastFollowScroll = now;
    current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function updateScrollControls() {
  $('speed-label').classList.toggle('hidden', $('scroll-mode').value !== 'fijo');
}

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
}

function startRecording() {
  recordedChunks = [];
  finalTranscript = '';
  speechChunks = [];
  pauses = [];
  lastSessionBlob = null;
  readPos = 0;
  lastFollowScroll = 0;
  wordFloat = 0;
  lastAdvanceTimes = [];
  lastFedWords = [];
  clearInterval(energyInterval);
  energyInterval = null;
  prompterSpans.forEach((s) => s.classList.remove('read', 'current'));
  $('prompter').scrollTop = 0;

  const mime = pickMimeType();
  recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
  recorder.onstop = onRecordingStopped;
  recorder.start(1000);
  recStartMs = performance.now();

  recogResultCount = 0;
  recogErrorCount = 0;
  recogGivenUp = false;
  hadAudioTrack = mediaStream.getAudioTracks().length > 0;
  if (useVoskLive && hadAudioTrack) {
    startVoskRecognition();
  } else {
    startSpeechRecognition();
  }
  if (hadAudioTrack) {
    startSilenceMonitor();
  } else {
    startRecogPauseMonitor();
  }
  startAutoScroll();

  $('btn-record').classList.add('hidden');
  $('btn-stop').classList.remove('hidden');
  $('rec-indicator').classList.remove('hidden');
  recTimerInt = setInterval(() => {
    $('rec-timer').textContent = formatDuration(performance.now() - recStartMs);
  }, 500);
}

// En móviles la grabadora de video acapara el micrófono y el reconocimiento
// no recibe audio: si en unos segundos no hay ni un resultado (o hay errores
// de captura), se pasa a scroll de velocidad fija calibrada al guion.
function fallbackToFixedScroll() {
  recogGivenUp = true;
  if ($('scroll-mode').value !== 'voz') return;
  $('scroll-mode').value = 'fijo';
  updateScrollControls();
  const p = $('prompter');
  const estSec = Math.max((followTokens.length / 140) * 60, 30);
  const px = Math.round((p.scrollHeight - p.clientHeight * 0.6) / estSec);
  $('scroll-speed').value = Math.min(80, Math.max(5, px));
  const warn = $('speech-warning');
  warn.textContent = '⚠️ El reconocimiento de voz no está respondiendo en este dispositivo. El texto avanzará a velocidad fija calibrada a tu guion; el video se graba normal, pero no habrá transcripción ni análisis de precisión.';
  warn.classList.remove('hidden');
}

function maybeGiveUpOnSpeech() {
  if (recogGivenUp || recogResultCount > 0) return;
  if (!recorder || recorder.state !== 'recording') return;
  // Si el micrófono sí detecta que hablas pero el reconocimiento no entrega
  // nada, es el mic exclusivo del móvil: se sigue tu voz por actividad.
  // Si ni siquiera hay energía de voz, se cae a velocidad fija.
  if (hasSpokenOnce) {
    switchToEnergyFollower();
  } else {
    fallbackToFixedScroll();
  }
}

// Reconocimiento en vivo con Vosk sobre el stream de la grabación
// (móviles y navegadores sin Web Speech).
function startVoskRecognition() {
  clearTimeout(recogWatchdog);
  recogWatchdog = setTimeout(maybeGiveUpOnSpeech, 15000);
  const langKey = $('rec-lang').value.startsWith('en') ? 'en' : 'es';
  startLiveRecognition({
    stream: mediaStream,
    lang: langKey,
    onStatus: (msg) => { $('recog-status').textContent = msg || ''; },
    onPartialWords: (words) => {
      recogResultCount++;
      // Si ya se cayó al seguidor por actividad, no se compite con él.
      if (!recogGivenUp) advanceFollower(words.map(normalizeWord));
    },
    onFinal: (text) => {
      recogResultCount++;
      finalTranscript += ' ' + text;
      speechChunks.push({
        tMs: performance.now() - recStartMs,
        words: text.split(/\s+/).length
      });
    }
  })
    .then((session) => {
      voskSession = session;
      // Si la práctica ya terminó mientras el modelo cargaba, se cierra.
      if (!recorder || recorder.state !== 'recording') session.stop();
    })
    .catch(() => {
      $('recog-status').textContent = '';
      maybeGiveUpOnSpeech();
    });
}

function startSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  recognition = new SR();
  recognition.lang = $('rec-lang').value;
  recognition.continuous = true;
  recognition.interimResults = true;
  fedCounts = {};
  clearTimeout(recogWatchdog);
  recogWatchdog = setTimeout(maybeGiveUpOnSpeech, 6000);
  recognition.onresult = (ev) => {
    recogResultCount++;
    lastSpeechAt = performance.now();
    hasSpokenOnce = true;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const text = ev.results[i][0].transcript.trim();
      if (!text) continue;
      // Alimenta el seguidor solo con las palabras nuevas de este resultado
      // (los resultados intermedios se re-emiten completos en cada evento).
      const words = text.split(/\s+/).map(normalizeWord);
      const prev = fedCounts[i] || 0;
      if (words.length > prev) {
        advanceFollower(words.slice(prev));
        fedCounts[i] = words.length;
      }
      if (ev.results[i].isFinal) {
        finalTranscript += ' ' + text;
        speechChunks.push({
          tMs: performance.now() - recStartMs,
          words: words.length
        });
      }
    }
  };
  // Chrome corta el reconocimiento cada cierto tiempo: se reinicia solo
  // (salvo que ya nos hayamos rendido por micrófono ocupado).
  recognition.onend = () => {
    if (!recogGivenUp && recorder && recorder.state === 'recording') {
      fedCounts = {};
      try { recognition.start(); } catch {}
    }
  };
  recognition.onerror = (ev) => {
    if (['audio-capture', 'not-allowed', 'service-not-allowed'].includes(ev.error)) {
      recogErrorCount += 2;
    } else {
      recogErrorCount++;
    }
    if (recogErrorCount >= 2) maybeGiveUpOnSpeech();
  };
  try { recognition.start(); } catch {}
}

// Estado de voz según la energía del micrófono (lo comparte el seguidor
// por actividad y el detector de que el reconocimiento no escucha).
let isSpeakingNow = false;
let hasSpokenOnce = false;

function startSilenceMonitor() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(mediaStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let silenceStart = null;
  isSpeakingNow = false;
  hasSpokenOnce = false;
  const int = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now() - recStartMs;
    if (rms < 0.012) {
      isSpeakingNow = false;
      if (silenceStart === null) silenceStart = now;
    } else {
      if (silenceStart !== null && hasSpokenOnce) {
        const dur = now - silenceStart;
        if (dur >= 1500) pauses.push({ startMs: Math.round(silenceStart), durMs: Math.round(dur) });
      }
      silenceStart = null;
      isSpeakingNow = true;
      hasSpokenOnce = true;
    }
  }, 100);
  silenceMonitor = { ctx, int };
}

// Sin pista de audio en la grabación (celular), las pausas se estiman por
// los huecos entre resultados del reconocimiento de voz.
let gapInterval = null;
let lastSpeechAt = 0;

function startRecogPauseMonitor() {
  lastSpeechAt = 0;
  let pauseStart = null;
  gapInterval = setInterval(() => {
    if (!lastSpeechAt) return; // aún no dice la primera palabra
    const silent = performance.now() - lastSpeechAt > 1500;
    if (silent && pauseStart === null) {
      pauseStart = lastSpeechAt;
    } else if (!silent && pauseStart !== null) {
      pauses.push({
        startMs: Math.round(pauseStart - recStartMs),
        durMs: Math.round(lastSpeechAt - pauseStart)
      });
      pauseStart = null;
    }
  }, 250);
}

// Seguidor por actividad de voz: cuando el equipo no permite reconocer
// palabras mientras graba (micrófono exclusivo en móviles), el teleprompter
// avanza a ritmo de lectura mientras detecta que estás hablando y se
// detiene cuando haces pausa.
let energyInterval = null;
let wordFloat = 0;

function switchToEnergyFollower() {
  recogGivenUp = true;
  if (recognition) { try { recognition.onend = null; recognition.stop(); } catch {} }
  const warn = $('speech-warning');
  warn.textContent = '🎤 Tu equipo no permite reconocer palabras mientras graba: el teleprompter seguirá tu voz por actividad (avanza mientras hablas, se detiene si pausas). El video se graba con sonido normal.';
  warn.classList.remove('hidden');
  wordFloat = readPos;
  const wordsPerSec = 150 / 60; // ritmo medio de lectura
  energyInterval = setInterval(() => {
    if (!isSpeakingNow || !prompterSpans.length) return;
    wordFloat = Math.min(wordFloat + wordsPerSec * 0.2, prompterSpans.length);
    const target = Math.floor(wordFloat);
    if (target > readPos) {
      for (let k = readPos; k < target; k++) prompterSpans[k].classList.add('read');
      readPos = target;
      markCurrentAndScroll();
    }
  }, 200);
}

function startAutoScroll() {
  const prompter = $('prompter');
  let last = performance.now();
  let userPausedUntil = 0;
  const onUser = () => { userPausedUntil = performance.now() + 2500; };
  prompter.addEventListener('wheel', onUser);
  prompter.addEventListener('touchmove', onUser);
  const step = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    const mode = $('scroll-mode').value;
    const fixedActive = mode === 'fijo' || (mode === 'voz' && !speechAvailable);
    if (fixedActive && now > userPausedUntil) {
      prompter.scrollTop += Number($('scroll-speed').value) * dt;
    }
    autoScrollRaf = requestAnimationFrame(step);
  };
  autoScrollRaf = requestAnimationFrame(step);
}

function stopRecording() {
  if (recorder && recorder.state === 'recording') {
    $('analyzing-detail').textContent = 'transcribiendo y comparando con el guion';
    $('analyzing').classList.remove('hidden');
    recorder.stop();
  }
  // Nota: el reconocimiento de voz NO se detiene aquí; se detiene en
  // onRecordingStopped con un periodo de gracia para no perder la última frase.
  clearTimeout(recogWatchdog);
  clearInterval(energyInterval);
  energyInterval = null;
  clearInterval(gapInterval);
  gapInterval = null;
  if (silenceMonitor) {
    clearInterval(silenceMonitor.int);
    silenceMonitor.ctx.close().catch(() => {});
    silenceMonitor = null;
  }
  if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
  clearInterval(recTimerInt);
  $('btn-record').classList.remove('hidden');
  $('btn-stop').classList.add('hidden');
  $('rec-indicator').classList.add('hidden');
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

async function onRecordingStopped() {
  const durationMs = performance.now() - recStartMs;

  // Periodo de gracia: el reconocimiento entrega la última frase con
  // ~1s de retraso; sin esta espera el final de la lectura se perdía.
  if (recognition || voskSession) {
    if (recognition) { try { recognition.onend = null; recognition.stop(); } catch {} }
    if (voskSession) { try { voskSession.stop(); } catch {} }
    await new Promise((r) => setTimeout(r, 1500));
    recognition = null;
    voskSession = null;
  }
  $('recog-status').textContent = '';
  stopCamera();

  if (discardRecording) {
    discardRecording = false;
    $('analyzing').classList.add('hidden');
    return;
  }

  const blob = new Blob(recordedChunks, { type: recorder.mimeType || 'video/webm' });
  lastSessionBlob = blob;

  // Sin transcripción en vivo pero con audio grabado: se transcribe
  // localmente con Whisper para recuperar el análisis completo.
  if (!finalTranscript.trim() && hadAudioTrack && hasSpokenOnce && blob.size > 1000) {
    const text = await transcribeLocally(blob);
    if (text) {
      finalTranscript = text;
      speechChunks = []; // sin marcas de tiempo: no hay ritmo por tramos
    }
  }

  const metrics = computeMetrics(currentScript.text, finalTranscript, durationMs, pauses, speechChunks);
  const session = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    title: currentScript.title,
    source: currentScript.source || 'texto propio',
    lang: currentScript.lang || 'es',
    script: currentScript.text,
    transcript: finalTranscript.trim(),
    metrics,
    mimeType: blob.type,
    videoBlob: blob
  };
  try {
    await saveSession(session);
  } catch (e) {
    console.warn('No se pudo guardar la sesión', e);
  }
  $('analyzing').classList.add('hidden');
  renderResults(session);
  show('screen-results');
}

// Transcribe el audio grabado en el propio dispositivo (Whisper local).
// El usuario puede saltarla si tarda demasiado.
async function transcribeLocally(blob) {
  const detail = $('analyzing-detail');
  const skipBtn = $('btn-skip-analysis');
  skipBtn.classList.remove('hidden');
  let skipped = false;
  const skip = new Promise((resolve) => {
    skipBtn.onclick = () => { skipped = true; resolve(''); };
  });
  try {
    const { transcribeBlob } = await import('./whisper.js');
    const text = await Promise.race([
      transcribeBlob(blob, currentScript.lang, (msg) => { detail.textContent = msg; }),
      skip
    ]);
    return skipped ? '' : (text || '');
  } catch (e) {
    console.warn('Transcripción local no disponible', e);
    return '';
  } finally {
    skipBtn.classList.add('hidden');
    detail.textContent = 'comparando con el guion…';
  }
}

// ---------- resultados ----------
function metricCard(value, label, cls = '', hint = '') {
  return `<div class="card ${cls}"><div class="value">${value}</div><div class="label">${label}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function renderResults(session) {
  const m = session.metrics;
  currentScript = { title: session.title, text: session.script, source: session.source, lang: session.lang || detectLang(session.script) };
  $('results-title').textContent = session.title;

  const accCls = m.accuracy >= 90 ? 'good' : m.accuracy >= 75 ? 'mid' : 'bad';
  const wpmCls = m.wpm >= 120 && m.wpm <= 170 ? 'good' : 'mid';
  const filCls = m.fillerCount <= 3 ? 'good' : m.fillerCount <= 8 ? 'mid' : 'bad';
  const pauCls = m.longPauseCount <= 2 ? 'good' : m.longPauseCount <= 5 ? 'mid' : 'bad';

  let ritmo = '';
  if (m.wpmBuckets && m.wpmBuckets.length > 1) {
    const nonzero = m.wpmBuckets.filter((b) => b > 0);
    if (nonzero.length > 1) {
      const max = Math.max(...nonzero), min = Math.min(...nonzero);
      ritmo = max - min > 50 ? 'ritmo irregular' : 'ritmo constante';
    }
  }

  $('metrics-cards').innerHTML =
    metricCard(formatDuration(m.durationMs), 'Duración') +
    metricCard(m.wpm, 'Palabras/min', wpmCls, wpmCls === 'good' ? 'buen ritmo (120–170)' : m.wpm < 120 ? 'un poco lento' : 'un poco rápido') +
    metricCard(m.accuracy + '%', 'Precisión vs guion', accCls) +
    metricCard(m.fillerCount, 'Muletillas', filCls) +
    metricCard(m.longPauseCount, 'Pausas largas (>1.5s)', pauCls, ritmo);

  const video = $('result-video');
  if (session.videoBlob) {
    video.src = URL.createObjectURL(session.videoBlob);
    video.classList.remove('hidden');
  } else {
    video.classList.add('hidden');
  }

  // diff guion vs dicho
  const diffEl = $('diff-view');
  diffEl.innerHTML = '';
  if (!session.transcript) {
    diffEl.innerHTML = '<p class="muted">No hubo transcripción (el reconocimiento de voz no está disponible en este navegador).</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const tok of m.diff.script) {
    const span = document.createElement('span');
    span.className = tok.ok ? 'ok' : 'missed';
    span.textContent = tok.raw + ' ';
    if (!tok.ok) {
      span.title = 'Toca para probar la pronunciación de esta palabra';
      span.addEventListener('click', () => {
        $('drill-word').value = tok.raw.replace(/[^\p{L}\p{N}'-]/gu, '');
        $('drill-word').scrollIntoView({ block: 'center', behavior: 'smooth' });
        $('drill-result').innerHTML = '';
      });
    }
    frag.appendChild(span);
  }
  if (m.diff.insertions.some((t) => t.filler)) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.marginTop = '14px';
    p.textContent = 'Muletillas detectadas: ';
    for (const t of m.diff.insertions.filter((t) => t.filler)) {
      const s = document.createElement('span');
      s.className = 'filler';
      s.textContent = t.raw + ' ';
      p.appendChild(s);
    }
    frag.appendChild(p);
  }
  diffEl.appendChild(frag);
}

// ---------- prueba de pronunciación ----------
function drillLang() {
  return (currentScript.lang || 'es') === 'en' ? 'en-US' : 'es-MX';
}

function hearWord() {
  const w = $('drill-word').value.trim();
  if (!w) return;
  const u = new SpeechSynthesisUtterance(w);
  u.lang = drillLang();
  u.rate = 0.85;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function tryWord() {
  const w = $('drill-word').value.trim();
  const out = $('drill-result');
  if (!w) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    out.textContent = 'El reconocimiento de voz no está disponible en este navegador (usa Chrome o Edge).';
    return;
  }
  const rec = new SR();
  rec.lang = drillLang();
  rec.interimResults = false;
  rec.maxAlternatives = 5;
  let gotResult = false;
  out.innerHTML = '<span class="muted">🎤 Escuchando… di la palabra ahora</span>';
  rec.onresult = (ev) => {
    gotResult = true;
    const alts = Array.from(ev.results[0]).map((a) => a.transcript.trim());
    const target = normalizeWord(w);
    const ok = alts.some((a) => a.split(/\s+/).some((x) => normalizeWord(x) === target));
    if (ok) {
      out.innerHTML = `✅ <b style="color:var(--green)">¡Bien pronunciada!</b> Se entendió claramente «${w}».`;
    } else {
      out.innerHTML = `❌ <b style="color:var(--red)">Se escuchó «${alts[0] || '?'}»</b> en vez de «${w}». Escúchala de nuevo (🔊) e inténtalo otra vez.`;
    }
  };
  rec.onend = () => {
    if (!gotResult) out.innerHTML = '<span class="muted">No se escuchó nada. Intenta de nuevo más cerca del micrófono.</span>';
  };
  rec.onerror = () => {};
  rec.start();
}

// ---------- historial ----------
async function renderHistory() {
  const sessions = await listSessions();
  const list = $('history-list');
  list.innerHTML = '';
  $('history-empty').classList.toggle('hidden', sessions.length > 0);
  renderTrend(sessions.slice().reverse());
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'session-row';
    const date = new Date(s.createdAt).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `
      <div class="session-info">
        <div class="session-title"></div>
        <div class="session-meta">${date} · ${s.source} · ${formatDuration(s.metrics.durationMs)}</div>
      </div>
      <div class="session-stats">
        <span><b>${s.metrics.accuracy}%</b>precisión</span>
        <span><b>${s.metrics.wpm}</b>ppm</span>
        <span><b>${s.metrics.fillerCount}</b>muletillas</span>
      </div>
      <button class="small danger btn-del">🗑</button>`;
    row.querySelector('.session-title').textContent = s.title;
    row.querySelector('.btn-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('¿Borrar esta sesión y su video?')) {
        await deleteSession(s.id);
        renderHistory();
      }
    });
    row.addEventListener('click', async () => {
      const full = await getSession(s.id);
      renderResults(full);
      show('screen-results');
    });
    list.appendChild(row);
  }
}

function renderTrend(sessions) {
  const el = $('trend-chart');
  if (sessions.length < 2) {
    el.innerHTML = '<p class="muted">Cuando tengas 2+ sesiones verás aquí tu evolución de precisión y ritmo.</p>';
    return;
  }
  const W = 600, H = 110, pad = 10;
  const xs = sessions.map((_, i) => pad + (i * (W - 2 * pad)) / (sessions.length - 1));
  const line = (vals, max, color) => {
    const pts = vals.map((v, i) => `${xs[i]},${H - pad - (v / max) * (H - 2 * pad)}`).join(' ');
    return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>`;
  };
  const accs = sessions.map((s) => s.metrics.accuracy);
  const wpms = sessions.map((s) => s.metrics.wpm);
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${line(accs, 100, '#3ecf8e')}
      ${line(wpms, Math.max(...wpms, 180), '#4f8ef7')}
    </svg>
    <p class="muted"><span style="color:#3ecf8e">■</span> Precisión (%) &nbsp; <span style="color:#4f8ef7">■</span> Palabras por minuto</p>`;
}

// ---------- eventos ----------
$('nav-practice').addEventListener('click', () => show('screen-setup'));
$('nav-history').addEventListener('click', () => { renderHistory(); show('screen-history'); });
$('btn-refresh-news').addEventListener('click', () => loadNews(true));
$('btn-use-pasted').addEventListener('click', () => {
  const text = $('paste-text').value.trim();
  if (text.split(/\s+/).length < 20) { alert('Pega un texto más largo (mínimo ~20 palabras).'); return; }
  openPreview({ title: 'Texto propio', text, source: 'texto propio' });
});
$('script-text').addEventListener('input', () => {
  updateScriptStats();
  // Si editas el texto, la traducción al otro idioma queda obsoleta.
  editGen++;
  scriptVersions[currentScript.lang === 'es' ? 'en' : 'es'] = null;
});
$('btn-lang-es').addEventListener('click', () => setScriptLang('es'));
$('btn-lang-en').addEventListener('click', () => setScriptLang('en'));
$('btn-back-setup').addEventListener('click', () => show('screen-setup'));
$('btn-start-practice').addEventListener('click', startPractice);
$('btn-record').addEventListener('click', startRecording);
$('btn-stop').addEventListener('click', stopRecording);
$('btn-cancel-practice').addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') discardRecording = true;
  stopRecording();
  $('analyzing').classList.add('hidden');
  stopCamera();
  show('screen-preview');
});
$('btn-trim').addEventListener('click', trimScriptTo3Min);
document.querySelectorAll('#news-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    currentCat = tab.dataset.cat;
    document.querySelectorAll('#news-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderNewsList();
  });
});
$('btn-results-again').addEventListener('click', () => openPreview(currentScript));
$('btn-results-home').addEventListener('click', () => show('screen-setup'));
$('font-size').addEventListener('input', (e) => {
  $('prompter').style.fontSize = e.target.value + 'px';
});
$('scroll-mode').addEventListener('change', updateScrollControls);
$('btn-hear').addEventListener('click', hearWord);
$('btn-try').addEventListener('click', tryWord);

speechWarningDefault = $('speech-warning').textContent;
$('app-version').textContent = 'v8';
loadNews();
