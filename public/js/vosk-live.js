// Reconocimiento de voz en vivo con Vosk (Kaldi compilado a WebAssembly).
// A diferencia de Web Speech, se alimenta por Web Audio desde el MISMO
// stream que se está grabando, así que no compite por el micrófono:
// funciona en móviles con la grabación de audio+video activa.
// El modelo (~40 MB) se descarga una vez y queda en la caché del navegador.

const VOSK_CDN = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js';
const MODEL_URLS = {
  es: 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-es-0.3.tar.gz',
  en: 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz'
};

let voskLibPromise = null;
const modelCache = {};
const modelLoading = {};

function loadVoskLib() {
  if (!voskLibPromise) {
    voskLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = VOSK_CDN;
      s.onload = () => resolve(window.Vosk);
      s.onerror = () => reject(new Error('No se pudo cargar la librería de voz'));
      document.head.appendChild(s);
    });
    voskLibPromise.catch(() => { voskLibPromise = null; });
  }
  return voskLibPromise;
}

export async function preloadModel(lang, onStatus) {
  const key = lang === 'en' ? 'en' : 'es';
  if (modelCache[key]) return modelCache[key];
  if (modelLoading[key]) return modelLoading[key];
  modelLoading[key] = (async () => {
    const Vosk = await loadVoskLib();
    onStatus && onStatus('descargando reconocedor de voz…');
    const resp = await fetch(MODEL_URLS[key]);
    if (!resp.ok) throw new Error('Modelo de voz no disponible');
    const total = Number(resp.headers.get('Content-Length')) || 0;
    const reader = resp.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (total && onStatus) {
        onStatus(`descargando reconocedor de voz… ${Math.round((got / total) * 100)}%`);
      }
    }
    onStatus && onStatus('preparando reconocedor de voz…');
    const blobUrl = URL.createObjectURL(new Blob(parts));
    const model = await Vosk.createModel(blobUrl);
    modelCache[key] = model;
    onStatus && onStatus('');
    return model;
  })();
  modelLoading[key].catch(() => { modelLoading[key] = null; });
  return modelLoading[key];
}

// Inicia el reconocimiento sobre un MediaStream ya abierto (el de la
// grabación). Devuelve un objeto con stop() para cerrar todo.
export async function startLiveRecognition({ stream, lang, onPartialWords, onFinal, onStatus }) {
  const model = await preloadModel(lang, onStatus);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const rec = new model.KaldiRecognizer(ctx.sampleRate);

  // Los parciales re-emiten la frase completa en curso: solo se pasan
  // las palabras nuevas desde el último evento.
  let prevPartialCount = 0;
  rec.on('partialresult', (m) => {
    const words = (m.result.partial || '').trim().split(/\s+/).filter(Boolean);
    if (words.length > prevPartialCount) {
      onPartialWords(words.slice(prevPartialCount));
      prevPartialCount = words.length;
    }
  });
  rec.on('result', (m) => {
    prevPartialCount = 0;
    const text = (m.result.text || '').trim();
    if (text) onFinal(text);
  });

  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => { try { rec.acceptWaveform(e.inputBuffer); } catch {} };
  // ScriptProcessor necesita llegar al destino para procesar; se silencia
  // con una ganancia en cero para no re-emitir tu voz por el parlante.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  return {
    stop() {
      // retrieveFinalResult fuerza la entrega del último tramo pendiente.
      try { rec.retrieveFinalResult(); } catch {}
      setTimeout(() => {
        try { proc.disconnect(); source.disconnect(); mute.disconnect(); } catch {}
        try { rec.remove(); } catch {}
        ctx.close().catch(() => {});
      }, 400);
    }
  };
}
