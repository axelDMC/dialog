# 🎙️ Dialog — práctica de expresión oral

**Producción:** [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/axelDMC/dialog)
El plan gratuito de Render incluye HTTPS (necesario para la cámara). El servicio
se duerme tras 15 min sin uso; la primera visita después tarda ~1 min en despertar.

App para mejorar tu manera de expresarte: eliges una noticia (o pegas un texto),
la lees frente a la cámara con teleprompter, y la app analiza tu lectura.

## Cómo usarla

```
npm install   # solo la primera vez
npm start
```

- **En esta PC:** abre `http://localhost:8080` (usa Chrome o Edge para el análisis de voz).
- **Desde el celular:** conéctate a la misma red WiFi y abre `https://<IP-de-tu-PC>:8443`
  (la IP aparece en la consola al arrancar). La primera vez el navegador mostrará una
  advertencia de certificado — acéptala ("Avanzado → Continuar"). Es necesario para que
  el navegador permita usar la cámara.

## Qué mide

| Métrica | Qué significa |
|---|---|
| Palabras/min | Tu velocidad de lectura. Ideal: 120–170 ppm |
| Precisión vs guion | % de palabras del guion que efectivamente dijiste |
| Muletillas | "este…", "eh", "o sea", "pues"… que agregaste fuera del guion |
| Pausas largas | Silencios de más de 1.5 segundos |
| Ritmo | Si tu velocidad fue constante o irregular por tramos de 30s |

Cada sesión se guarda **en tu navegador** (video incluido, nada sale de tu máquina)
y en la pestaña **Historial** ves tu evolución sesión a sesión.

## Consejos de práctica

1. Lee el texto una vez en silencio antes de grabar.
2. Meta inicial: precisión > 85% y menos de 5 muletillas.
3. Cuando domines la lectura, intenta **contar** la noticia sin leerla — la
   precisión bajará, pero las muletillas y pausas te dirán qué tan fluido improvisas.
