const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Parser = require('rss-parser');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const selfsigned = require('selfsigned');

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const CERT_DIR = path.join(__dirname, 'cert');

const FEEDS = [
  // Lima & Perú — IA, tecnología, ecommerce, trading (español)
  { source: 'IA en Perú', cat: 'lima', lang: 'es', url: 'https://www.bing.com/news/search?q=%22inteligencia+artificial%22+(Lima+OR+Per%C3%BA)&format=RSS&mkt=es-MX' },
  { source: 'Tecnología Lima', cat: 'lima', lang: 'es', url: 'https://www.bing.com/news/search?q=tecnolog%C3%ADa+evento+(Lima+OR+Per%C3%BA)&format=RSS&mkt=es-MX' },
  { source: 'Ecommerce Perú', cat: 'lima', lang: 'es', url: 'https://www.bing.com/news/search?q=ecommerce+comercio+electr%C3%B3nico+Per%C3%BA&format=RSS&mkt=es-MX' },
  { source: 'Trading Perú', cat: 'lima', lang: 'es', url: 'https://www.bing.com/news/search?q=trading+inversiones+bolsa+Per%C3%BA&format=RSS&mkt=es-MX' },
  // IA global (mezcla inglés + español; el RSS de Bing no soporta OR)
  { source: 'IA en español', cat: 'ai', lang: 'es', url: 'https://www.bing.com/news/search?q=inteligencia+artificial&format=RSS&mkt=es-MX' },
  { source: 'ChatGPT (ES)', cat: 'ai', lang: 'es', url: 'https://www.bing.com/news/search?q=ChatGPT&format=RSS&mkt=es-MX' },
  { source: 'Claude (ES)', cat: 'ai', lang: 'es', url: 'https://www.bing.com/news/search?q=Claude+Anthropic+IA&format=RSS&mkt=es-MX' },
  { source: 'TechCrunch AI', cat: 'ai', lang: 'en', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { source: 'The Verge AI', cat: 'ai', lang: 'en', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { source: 'The Guardian AI', cat: 'ai', lang: 'en', url: 'https://www.theguardian.com/technology/artificialintelligenceai/rss' },
  { source: 'Claude / Anthropic', cat: 'ai', lang: 'en', url: 'https://www.bing.com/news/search?q=Anthropic+Claude+AI&format=RSS&mkt=en-US&setlang=en-US' },
  { source: 'ChatGPT / OpenAI', cat: 'ai', lang: 'en', url: 'https://www.bing.com/news/search?q=ChatGPT+OpenAI&format=RSS&mkt=en-US&setlang=en-US' }
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// Límite simple de peticiones por IP para los endpoints que llaman a terceros.
const rateBuckets = new Map();
function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let b = rateBuckets.get(key);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + 60000 };
      rateBuckets.set(key, b);
    }
    if (++b.count > maxPerMin) {
      return res.status(429).json({ error: 'Demasiadas peticiones, espera un momento.' });
    }
    next();
  };
}

// Solo se extraen artículos cuyos enlaces vinieron de los feeds de noticias.
const knownLinks = new Set();

// JSDOM es pesado en memoria: solo una extracción a la vez para no
// reventar los 512 MB del plan gratuito de Render.
let extractionQueue = Promise.resolve();
function withExtractionLock(fn) {
  const run = extractionQueue.then(fn, fn);
  extractionQueue = run.catch(() => {});
  return run;
}

const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': USER_AGENT } });

let newsCache = { at: 0, items: [] };

// Los enlaces del RSS de Bing pasan por un redirector (apiclick) que trae
// la URL real como parámetro: se resuelve directo, sin la redirección.
function resolveBingLink(link) {
  try {
    const u = new URL(link);
    if (u.hostname.endsWith('bing.com')) {
      const target = u.searchParams.get('url');
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch {}
  return link;
}

async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const feed = await parser.parseURL(f.url);
      return (feed.items || []).slice(0, 10).map((it) => ({
        source: f.source,
        cat: f.cat,
        lang: f.lang,
        title: (it.title || '').trim(),
        link: resolveBingLink(it.link),
        date: it.isoDate || it.pubDate || null,
        snippet: (it.contentSnippet || '').slice(0, 200)
      }));
    })
  );
  const seen = new Set();
  const items = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .filter((it) => it.title && it.link)
    // MSN sirve páginas vacías renderizadas con JavaScript: no se pueden extraer.
    .filter((it) => {
      try { return !new URL(it.link).hostname.includes('msn.'); } catch { return false; }
    })
    .filter((it) => {
      const key = it.title.toLowerCase().replace(/[^a-z0-9áéíóúñ]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 80);
  newsCache = { at: Date.now(), items };
  if (knownLinks.size > 2000) knownLinks.clear();
  for (const it of items) knownLinks.add(it.link);
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? FEEDS[i].source : null))
    .filter(Boolean);
  return { items, failed };
}

app.get('/api/news', async (req, res) => {
  const force = req.query.force === '1';
  if (!force && Date.now() - newsCache.at < 5 * 60 * 1000 && newsCache.items.length) {
    return res.json({ items: newsCache.items, cached: true });
  }
  const { items, failed } = await fetchAllFeeds();
  res.json({ items, failed });
});

app.get('/api/article', rateLimit(30), async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL inválida' });
  }
  // Tras un reinicio del servidor el cliente puede tener una lista vieja:
  // se repuebla el índice de enlaces conocidos antes de rechazar.
  if (!knownLinks.has(url) && knownLinks.size === 0) {
    try { await fetchAllFeeds(); } catch {}
  }
  if (!knownLinks.has(url)) {
    return res.status(403).json({ error: 'Solo se pueden extraer noticias del listado. Actualiza la lista de noticias.' });
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' },
      redirect: 'follow',
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    if (html.length > 3_000_000) throw new Error('Página demasiado pesada para extraer');
    const article = await withExtractionLock(() => {
      const vc = new VirtualConsole();
      vc.on('error', () => {});
      const dom = new JSDOM(html, { url, virtualConsole: vc });
      try {
        return new Readability(dom.window.document).parse();
      } finally {
        dom.window.close();
      }
    });
    if (!article || !article.textContent || article.textContent.trim().length < 200) {
      throw new Error('No se pudo extraer el texto del artículo');
    }
    let text = article.textContent
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join('\n\n');
    const fullWords = text.split(/\s+/).length;
    text = trimToMaxWords(text, 420);
    const wordCount = text.split(/\s+/).length;
    res.json({
      title: article.title || '',
      text,
      wordCount,
      trimmed: fullWords > wordCount,
      minutes: Math.round((wordCount / 140) * 10) / 10
    });
  } catch (err) {
    res.status(502).json({
      error: 'No se pudo extraer el artículo. Prueba con otra noticia o pega el texto manualmente.',
      detail: String(err.message || err)
    });
  }
});

// Traduce un fragmento con el endpoint público de Google Translate (sin key).
async function translateChunk(text, to) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    to + '&dt=t&q=' + encodeURIComponent(text);
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) throw new Error(`Traductor HTTP ${resp.status}`);
  const data = await resp.json();
  return (data[0] || []).map((seg) => seg[0]).join('');
}

// Parte el texto en trozos de oraciones (<1500 chars) para no exceder la URL.
function chunkForTranslate(text) {
  const chunks = [];
  for (const para of text.split(/\n\n+/)) {
    let cur = '';
    for (const s of para.split(/(?<=[.!?…])\s+/)) {
      if (cur && (cur.length + s.length) > 1500) {
        chunks.push({ text: cur, para: false });
        cur = s;
      } else {
        cur = cur ? cur + ' ' + s : s;
      }
    }
    if (cur) chunks.push({ text: cur, para: true });
  }
  return chunks;
}

app.post('/api/translate', rateLimit(20), async (req, res) => {
  const { title, text, to } = req.body || {};
  if (!text || !['es', 'en'].includes(to)) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }
  try {
    const chunks = chunkForTranslate(text);
    let out = '';
    for (const c of chunks) {
      const t = await translateChunk(c.text, to);
      out += t + (c.para ? '\n\n' : ' ');
    }
    const outTitle = title ? await translateChunk(title, to) : '';
    res.json({ title: outTitle.trim(), text: out.trim() });
  } catch (err) {
    res.status(502).json({
      error: 'No se pudo traducir en este momento. Intenta de nuevo.',
      detail: String(err.message || err)
    });
  }
});

// Corta el texto en un límite de oración sin pasarse de maxWords
// (~3 minutos de lectura a 140 palabras por minuto).
function trimToMaxWords(text, maxWords) {
  if (text.split(/\s+/).length <= maxWords) return text;
  const sentences = text.split(/(?<=[.!?…])\s+/);
  const out = [];
  let count = 0;
  for (const s of sentences) {
    const w = s.split(/\s+/).length;
    if (count + w > maxWords && count > 0) break;
    out.push(s);
    count += w;
  }
  return out.join(' ');
}

function lanIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function loadOrCreateCert() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIps().map((ip) => ({ type: 7, ip }))
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'dialog.local' }], {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }]
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

if (process.env.PORT) {
  // Producción (Render, etc.): la plataforma pone el TLS.
  app.set('trust proxy', 1);
  http.createServer(app).listen(process.env.PORT, () => {
    console.log(`Dialog en producción, puerto ${process.env.PORT}`);
  });
} else {
  // Desarrollo local: HTTP para esta PC + HTTPS autofirmado para el celular.
  const { key, cert } = loadOrCreateCert();

  http.createServer(app).listen(HTTP_PORT, () => {
    console.log(`\n  Dialog — práctica de expresión oral\n`);
    console.log(`  En esta PC:      http://localhost:${HTTP_PORT}`);
  });

  https.createServer({ key, cert }, app).listen(HTTPS_PORT, '0.0.0.0', () => {
    for (const ip of lanIps()) {
      console.log(`  Desde el celular: https://${ip}:${HTTPS_PORT}  (acepta la advertencia del certificado)`);
    }
    console.log('');
  });
}
