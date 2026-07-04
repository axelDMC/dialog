// Transcripción local del audio grabado con Whisper (transformers.js).
// Se usa cuando el reconocimiento en vivo no estuvo disponible (móviles:
// el micrófono es exclusivo de la grabación). Todo corre en el dispositivo;
// el audio nunca sale de él. El modelo (~60 MB) se descarga una vez y queda
// en caché del navegador.

let asrPromise = null;

async function getAsr(onStatus) {
  if (asrPromise) return asrPromise;
  asrPromise = (async () => {
    const { pipeline } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.4'
    );
    const opts = {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
          onStatus && onStatus(`descargando el modelo de voz… ${Math.round(p.progress || 0)}%`);
        }
      }
    };
    try {
      // WebGPU: mucho más rápido en celulares y PCs modernos.
      return await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
        ...opts,
        device: 'webgpu'
      });
    } catch {
      return await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
        ...opts,
        device: 'wasm'
      });
    }
  })();
  asrPromise.catch(() => { asrPromise = null; });
  return asrPromise;
}

export async function transcribeBlob(blob, lang, onStatus) {
  const asr = await getAsr(onStatus);

  onStatus && onStatus('procesando el audio…');
  const buf = await blob.arrayBuffer();
  // AudioContext a 16 kHz: el navegador decodifica el audio del video
  // (webm/mp4) y lo re-muestrea a lo que Whisper espera.
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const decoded = await ctx.decodeAudioData(buf);
  let pcm;
  if (decoded.numberOfChannels > 1) {
    const a = decoded.getChannelData(0);
    const b = decoded.getChannelData(1);
    pcm = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) pcm[i] = (a[i] + b[i]) / 2;
  } else {
    pcm = decoded.getChannelData(0);
  }
  ctx.close().catch(() => {});

  onStatus && onStatus('transcribiendo tu voz… (la primera vez puede tardar unos minutos)');
  const out = await asr(pcm, {
    language: lang === 'en' ? 'english' : 'spanish',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5
  });
  return (out.text || '').trim();
}
