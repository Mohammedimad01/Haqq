// Vercel serverless proxy: browser -> /api/chat -> Gemma 4 on the Gemini API.
// The API key lives only in the GEMINI_API_KEY env var, never in the client.

const ALLOWED_MODELS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it'];
const DEFAULT_MODEL = ALLOWED_MODELS[0];
const TIMEOUT_MS = 40000; // client aborts at 45s; answer slightly before that

export default async function handler(req, res) {
  // GET = health check, handy for verifying a deploy: /api/chat
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY), models: ALLOWED_MODELS });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Use POST', status: 'METHOD_NOT_ALLOWED' } });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(401).json({ error: { message: 'GEMINI_API_KEY is not set on the server', status: 'NO_KEY' } });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || !Array.isArray(body.contents)) {
    return res.status(400).json({ error: { message: 'Request needs a "contents" array', status: 'BAD_REQUEST' } });
  }

  const model = ALLOWED_MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const config = body.generationConfig || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();

  const send = (generationConfig) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: body.contents, generationConfig }),
    signal: ctrl.signal,
  });

  try {
    let upstream = await send(config);
    let text = await upstream.text();
    let fallback = false;
    if (upstream.status === 400 && (config.thinkingConfig || config.responseMimeType)) {
      // the model may reject JSON mode or thinkingConfig: retry once with the basics
      console.warn('[haqq] 400 with extended config, retrying basic:', text.slice(0, 300));
      upstream = await send({ temperature: config.temperature, maxOutputTokens: config.maxOutputTokens });
      text = await upstream.text();
      fallback = true;
    }
    let usage = {};
    try { usage = JSON.parse(text).usageMetadata || {}; } catch { /* error bodies may not be JSON */ }
    console.log(`[haqq] ${model} status=${upstream.status} ms=${Date.now() - started} thoughts=${usage.thoughtsTokenCount ?? 0} out=${usage.candidatesTokenCount ?? 0}${fallback ? ' fallback' : ''}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(text);
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    console.error(`[haqq] ${model} ${timedOut ? 'timeout' : 'fetch error'} after ${Date.now() - started}ms`, err.message);
    return res.status(timedOut ? 504 : 502).json({
      error: {
        message: timedOut ? `Gemma did not respond within ${TIMEOUT_MS / 1000}s` : `Could not reach the Gemini API: ${err.message}`,
        status: timedOut ? 'TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
