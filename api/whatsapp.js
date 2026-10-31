// WhatsApp Cloud API webhook: every incoming WhatsApp message gets a Gemma 4 reply.
// Text questions get a short answer; photos of contracts, payslips or notices get a risk check.
// Dormant until these Vercel environment variables are set:
//   WHATSAPP_VERIFY_TOKEN  any secret string, also entered in Meta's webhook settings
//   WHATSAPP_TOKEN         access token of the WhatsApp Business app
//   WHATSAPP_PHONE_ID      phone number ID from the WhatsApp API setup page
//   WHATSAPP_APP_SECRET    app secret, used to verify Meta's signature (strongly recommended)
// GEMINI_API_KEY is shared with /api/chat.
import crypto from 'node:crypto';

const MODEL = 'gemma-4-26b-a4b-it';
const GRAPH = 'https://graph.facebook.com/v21.0';
const MOHRE = '600590000';
const TIMEOUT_MS = 30000;
const RULES = `1. The employer must not keep the worker's passport.
2. Maximum 8 working hours a day or 48 hours a week. Extra hours are overtime and must be paid extra.
3. At least 1 paid rest day every week.
4. Salary must be paid at least once a month, through WPS (bank or exchange transfer).
5. End-of-service gratuity is due after 1 year of continuous service.
6. The worker must not be charged recruitment fees, visa costs, or resignation/exit fees.`;

// Meta retries deliveries it thinks failed; skip repeats seen by this instance
const seen = new Set();

const prompt = (message, hasImage) => `You are Haqq, a kind WhatsApp assistant for migrant workers in the UAE. Many users have little schooling. Explain simply, like a trusted friend.

LANGUAGE: Reply in the same language the worker writes in, in that language's own script (never romanized). If there is no text, reply in simple English and offer to answer in their language.

Use ONLY these UAE labour rules. Never invent other laws, numbers or deadlines:
${RULES}
If something is not covered, say you are not sure and advise calling MOHRE on ${MOHRE}.
${hasImage ? '\nThe worker sent a photo of a document. Read it, then say plainly whether it looks fine, unclear, or breaks a rule, and list each problem in one short line.\n' : ''}
Style: plain WhatsApp text, no markdown headings, no JSON. At most 6 short sentences. End with: this is not legal advice, call MOHRE on ${MOHRE}.

Worker's message:
"""${message || '(no text)'}"""`;

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

function validSignature(raw, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function askGemma(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const send = (generationConfig) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    signal: ctrl.signal,
  });
  try {
    let r = await send({ temperature: 0.4, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    if (r.status === 400) r = await send({ temperature: 0.4, maxOutputTokens: 4096 });
    if ([429, 500, 503].includes(r.status)) {
      await new Promise((ok) => setTimeout(ok, 1200));
      r = await send({ temperature: 0.4, maxOutputTokens: 4096 });
    }
    const data = await r.json();
    if (!r.ok) throw new Error(`Gemini API ${r.status}: ${data?.error?.message || 'error'}`);
    const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('').trim();
    if (!text) throw new Error('empty reply');
    return text.replace(/```[a-z]*|```/gi, '').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function graph(path, init = {}) {
  return fetch(`${GRAPH}/${path}`, { ...init, headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, ...(init.headers || {}) } });
}

async function downloadImage(mediaId) {
  const meta = await (await graph(mediaId)).json();
  if (!meta.url) throw new Error('media url missing');
  const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  if (!bin.ok) throw new Error(`media download ${bin.status}`);
  return { mime: meta.mime_type || 'image/jpeg', data: Buffer.from(await bin.arrayBuffer()).toString('base64') };
}

async function reply(to, body) {
  const r = await graph(`${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: body.slice(0, 4000) } }),
  });
  if (!r.ok) console.error('[haqq-wa] send failed', r.status, (await r.text()).slice(0, 300));
}

async function handleMessage(msg) {
  if (seen.has(msg.id)) return;
  seen.add(msg.id);
  if (seen.size > 500) seen.clear();

  const from = msg.from;
  try {
    if (msg.type === 'text') {
      await reply(from, await askGemma([{ text: prompt(msg.text?.body) }]));
    } else if (msg.type === 'image') {
      const img = await downloadImage(msg.image.id);
      await reply(from, await askGemma([{ text: prompt(msg.image.caption, true) }, { inline_data: { mime_type: img.mime, data: img.data } }]));
    } else {
      await reply(from, 'Haqq can read text messages and photos of documents. Please type your question, or send a clear photo of your contract or payslip.');
    }
  } catch (err) {
    console.error('[haqq-wa] failed', err.message);
    await reply(from, `Sorry, Haqq could not answer just now. Please try again in a moment. For urgent help, call MOHRE on ${MOHRE}.`);
  }
}

export default async function handler(req, res) {
  const configured = Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_VERIFY_TOKEN && process.env.GEMINI_API_KEY);
  const query = Object.fromEntries(new URL(req.url, 'http://local').searchParams);

  // Meta's one-time webhook verification
  if (req.method === 'GET') {
    if (query['hub.mode'] === 'subscribe') {
      const ok = process.env.WHATSAPP_VERIFY_TOKEN && query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN;
      return ok ? res.status(200).send(query['hub.challenge']) : res.status(403).send('Forbidden');
    }
    return res.status(200).json({ ok: true, configured, signatureCheck: Boolean(process.env.WHATSAPP_APP_SECRET) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!configured) return res.status(503).json({ error: 'WhatsApp bot is not configured' });

  const raw = await readRaw(req);
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret && !validSignature(raw, req.headers['x-hub-signature-256'], secret)) {
    return res.status(401).json({ error: 'Bad signature' });
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ error: 'Bad JSON' }); }

  // one delivery can carry several messages; status updates (sent/read) carry none
  const messages = (body.entry || []).flatMap((e) => (e.changes || []).flatMap((c) => c.value?.messages || []));
  await Promise.all(messages.map(handleMessage));
  return res.status(200).json({ ok: true, handled: messages.length });
}
