// Vercel serverless proxy: browser -> /api/chat -> Gemma 4 on the Gemini API.
// The API key lives only in the GEMINI_API_KEY env var, never in the client.

const ALLOWED_MODELS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it'];
const DEFAULT_MODEL = ALLOWED_MODELS[0];
const TIMEOUT_MS = 24000; // client aborts at 25s; answer slightly before that

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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: body.contents, generationConfig: body.generationConfig }),
      signal: ctrl.signal,
    });
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(text);
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return res.status(timedOut ? 504 : 502).json({
      error: {
        message: timedOut ? 'Gemma did not respond in time' : `Could not reach the Gemini API: ${err.message}`,
        status: timedOut ? 'TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
