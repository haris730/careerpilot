const MODEL = '@cf/meta/llama-3.1-8b-instruct';
const LIMIT = 6;
const WINDOW_MS = 60 * 60 * 1000;
const buckets = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function allowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

function rateLimited(ip) {
  const now = Date.now();
  const old = buckets.get(ip) || { start: now, count: 0 };
  if (now - old.start >= WINDOW_MS) { old.start = now; old.count = 0; }
  old.count++;
  buckets.set(ip, old);
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) if (now - value.start >= WINDOW_MS) buckets.delete(key);
  }
  return old.count > LIMIT;
}

function buildPrompt(body) {
  const task = body.task;
  const input = String(body.input || '').slice(0, 8000);
  const job = String(body.jobDescription || '').slice(0, 8000);
  const cv = String(body.cvContext || '').slice(0, 12000);
  const rules = [
    'You are CareerPilot, a professional CV writing assistant.',
    'Return only the finished writing requested by the user. No preamble, no markdown fences.',
    'Never invent employers, job titles, skills, dates, education, metrics, achievements, certifications, or experience.',
    'Improve wording using only information supplied in the CV context and input.',
    'Keep claims truthful and professional.'
  ];
  if (task === 'bullet') {
    return rules.join('\n') + '\nTask: Rewrite this CV bullet into one concise, achievement-focused bullet. Use a strong action verb and preserve the original facts.\nCV context:\n' + cv + '\nInput:\n' + input;
  }
  if (task === 'summary') {
    return rules.join('\n') + '\nTask: Write a professional 3-4 sentence CV summary based only on the supplied background. Do not invent years of experience or achievements.\nCV context:\n' + cv + '\nInput:\n' + input;
  }
  return rules.join('\n') + '\nTask: Tailor the supplied CV content to the job description. Return a concise revised version that naturally emphasizes relevant existing skills and experience. Do not add missing qualifications.\nCV context:\n' + cv + '\nCV content:\n' + input + '\nJob description:\n' + job;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': url.origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (!allowed(request)) return json({ error: 'Origin not allowed' }, 403);
      if (!env.AI || typeof env.AI.run !== 'function') return json({ error: 'AI service is not configured. Add the Workers AI binding named AI in Cloudflare.' }, 503);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (rateLimited(ip)) return json({ error: 'Hourly AI limit reached. Please try again later.' }, 429);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON request.' }, 400); }
      if (!['bullet','summary','tailor'].includes(body.task)) return json({ error: 'Invalid AI task.' }, 400);
      if (!String(body.input || '').trim()) return json({ error: 'Input is required.' }, 400);
      if (body.task === 'tailor' && !String(body.jobDescription || '').trim()) return json({ error: 'Job description is required for tailoring.' }, 400);
      try {
        const result = await env.AI.run(MODEL, { prompt: buildPrompt(body), max_tokens: 700, temperature: 0.35 });
        const text = typeof result === 'string' ? result : (result?.response || result?.text || result?.output_text || '');
        return json({ text: String(text).trim().slice(0, 8000) });
      } catch (e) {
        return json({ error: 'AI generation failed. Please try again.' }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
