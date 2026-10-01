const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const LIMIT = 6;
const WINDOW_MS = 60 * 60 * 1000;
const buckets = new Map();

const SUPABASE_URL = 'https://gxixgacuryslyoawhrej.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cjEbbJ_VUoT_vKMOR-vBmA_It8gXYQd';
function corsHeaders(origin){return{'access-control-allow-origin':origin,'access-control-allow-methods':'GET, POST, DELETE, OPTIONS','access-control-allow-headers':'content-type, authorization','cache-control':'no-store'}}
function apiJson(data,status,origin){return new Response(JSON.stringify(data),{status,headers:{...corsHeaders(origin),'content-type':'application/json; charset=utf-8'}})}
async function supabaseUser(request){const auth=request.headers.get('Authorization')||'';if(!auth.startsWith('Bearer '))return null;const res=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{apikey:SUPABASE_KEY,authorization:auth,accept:'application/json'}});if(!res.ok)return null;try{return await res.json()}catch{return null}}
function alertJobKey(j){return String(j.id||j.url||((j.title||'')+'|'+(j.company_name||'')))}
function alertSalaryMax(j){const s=String(j.salary||'').replace(/,/g,'');const nums=[...s.matchAll(/(?:\$|€|£)?\s*(\d+(?:\.\d+)?)\s*([kKmM])?/g)].map(m=>{let n=Number(m[1]);if((m[2]||'').toLowerCase()==='k')n*=1000;if((m[2]||'').toLowerCase()==='m')n*=1000000;return n});return nums.length?Math.max(...nums):0}
function alertJobExperience(j){const t=String(j.title||'').toLowerCase();if(/senior|sr\.?|lead|principal|staff|manager|director|head|architect/.test(t))return'senior';if(/junior|jr\.?|entry|intern|trainee|graduate/.test(t))return'entry';return'mid'}
function alertJobLocation(j){return Array.isArray(j.candidate_required_location)?j.candidate_required_location.join(', '):String(j.candidate_required_location||'Remote')}
function alertMatchesJob(j,a){const q=String(a.keyword||'').toLowerCase(),loc=String(a.location||'').toLowerCase(),t=[j.title,j.category,j.company_name,j.job_type,alertJobLocation(j)].join(' ').toLowerCase();if(q&&!t.includes(q))return false;if(loc&&!alertJobLocation(j).toLowerCase().includes(loc)&&!String(j.title||'').toLowerCase().includes(loc)&&!String(j.company_name||'').toLowerCase().includes(loc))return false;if(a.job_type&&String(j.job_type||'')!==a.job_type)return false;if(a.experience&&alertJobExperience(j)!==a.experience)return false;if(Number(a.min_salary||0)&&alertSalaryMax(j)<Number(a.min_salary))return false;return true}
async function fetchRemoteJobs(){const upstream=new URL('https://remotive.com/api/remote-jobs');upstream.searchParams.set('limit','100');const res=await fetch(upstream.toString(),{headers:{accept:'application/json','user-agent':'CareerPilot/1.0'}});if(!res.ok)throw new Error('Job provider unavailable');const data=await res.json();return Array.isArray(data.jobs)?data.jobs.map(j=>({id:j.id,title:j.title,company_name:j.company_name,category:j.category,job_type:j.job_type,candidate_required_location:j.candidate_required_location,salary:j.salary,publication_date:j.publication_date,url:j.url})):[]}
async function processServerAlerts(env,onlyIds){if(!env.ALERTS_DB)throw new Error('Alert database is not configured.');const now=Date.now();const where=onlyIds?.length?'WHERE active=1 AND id IN ('+onlyIds.map(()=>'?').join(',')+')':'WHERE active=1';const stmt=onlyIds?.length?env.ALERTS_DB.prepare('SELECT * FROM job_alerts '+where).bind(...onlyIds):env.ALERTS_DB.prepare('SELECT * FROM job_alerts '+where);const {results:alerts=[]}=await stmt.all();if(!alerts.length)return{processed:0,newMatches:0,alerts:[]};const jobs=await fetchRemoteJobs();let newTotal=0;const output=[];for(const a of alerts){const gap=a.frequency==='weekly'?7*86400000:86400000;if(!onlyIds?.length&&a.last_checked&&now-Number(a.last_checked)<gap)continue;const matches=jobs.filter(j=>alertMatchesJob(j,a));let newCount=0;for(const j of matches){const key=alertJobKey(j);const r=await env.ALERTS_DB.prepare('INSERT OR IGNORE INTO job_alert_matches (alert_id,job_key,job_json,first_seen,is_new) VALUES (?,?,?,?,1)').bind(a.id,key,JSON.stringify(j),now).run();if(r.meta?.changes){newCount++;newTotal++}}await env.ALERTS_DB.prepare('UPDATE job_alerts SET last_checked=? WHERE id=?').bind(now,a.id).run();output.push({id:a.id,newCount,checkedAt:now})}return{processed:output.length,newMatches:newTotal,alerts:output}}
async function handleServerAlerts(request,env,url){const origin=url.origin;if(request.method==='OPTIONS')return apiJson({},204,origin);if(!allowed(request))return apiJson({error:'Origin not allowed'},403,origin);if(!env.ALERTS_DB)return apiJson({error:'Alert database is not configured.'},503,origin);const user=await supabaseUser(request);if(!user?.id)return apiJson({error:'Sign in required.'},401,origin);if(request.method==='GET'){const {results:alerts=[]}=await env.ALERTS_DB.prepare('SELECT id,email,keyword,location,job_type,experience,min_salary,frequency,active,last_checked,created_at FROM job_alerts WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all();const {results:matches=[]}=await env.ALERTS_DB.prepare('SELECT m.alert_id,m.job_key,m.job_json,m.first_seen,m.is_new FROM job_alert_matches m JOIN job_alerts a ON a.id=m.alert_id WHERE a.user_id=? ORDER BY m.first_seen DESC LIMIT 50').bind(user.id).all();return apiJson({alerts,matches:matches.map(m=>({...m,job:JSON.parse(m.job_json||'{}')}))},200,origin)}if(request.method==='POST'){let body;try{body=await request.json()}catch{return apiJson({error:'Invalid JSON request.'},400,origin)}const id=String(body.id||'').slice(0,80),keyword=String(body.keyword||'').slice(0,120),location=String(body.location||'').slice(0,120),jobType=String(body.job_type||'').slice(0,30),experience=String(body.experience||'').slice(0,30);const minSalary=Math.max(0,Math.min(Number(body.min_salary||0),10000000)),frequency=body.frequency==='weekly'?'weekly':'daily';if(!id||(!keyword&&!location))return apiJson({error:'Add a job keyword or location.'},400,origin);const email=String(user.email||'').slice(0,320);const existing=await env.ALERTS_DB.prepare('SELECT user_id FROM job_alerts WHERE id=?').bind(id).first();if(existing&&existing.user_id!==user.id)return apiJson({error:'Alert id already exists.'},409,origin);await env.ALERTS_DB.prepare('INSERT INTO job_alerts (id,user_id,email,keyword,location,job_type,experience,min_salary,frequency,active,last_checked,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,0,?) ON CONFLICT(id) DO UPDATE SET keyword=excluded.keyword,location=excluded.location,job_type=excluded.job_type,experience=excluded.experience,min_salary=excluded.min_salary,frequency=excluded.frequency,active=1,email=excluded.email').bind(id,user.id,email,keyword,location,jobType,experience,minSalary,frequency,Date.now()).run();const checked=await processServerAlerts(env,[id]);return apiJson({ok:true,...checked},200,origin)}if(request.method==='DELETE'){const id=String(url.searchParams.get('id')||'').slice(0,80);if(!id)return apiJson({error:'Alert id is required.'},400,origin);await env.ALERTS_DB.prepare('DELETE FROM job_alerts WHERE id=? AND user_id=?').bind(id,user.id).run();return apiJson({ok:true},200,origin)}return apiJson({error:'Method not allowed'},405)}


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
    return rules.join('\\n') + '\\nTask: Rewrite this CV bullet into one concise, achievement-focused bullet. Use a strong action verb and preserve the original facts.\\nCV context:\\n' + cv + '\\nInput:\\n' + input;
  }
  if (task === 'summary') {
    return rules.join('\\n') + '\\nTask: Write a professional 3-4 sentence CV summary based only on the supplied background. Do not invent years of experience or achievements.\\nCV context:\\n' + cv + '\\nInput:\\n' + input;
  }
  if (task === 'letter') {
    const role = String(body.role || '').slice(0, 300);
    const company = String(body.company || '').slice(0, 300);
    return rules.join('\\n') + '\\nTask: Write a concise, professional one-page cover letter for the target role. Use the CV context and job description to emphasize relevant existing experience. Address the employer professionally without inventing a hiring manager name. Include a greeting, 3-4 short paragraphs, and a professional closing.\\nTarget role:\\n' + role + '\\nCompany:\\n' + company + '\\nCV context:\\n' + cv + '\\nJob description:\\n' + job;
  }
  return rules.join('\\n') + '\\nTask: Tailor the supplied CV content to the job description. Return a concise revised version that naturally emphasizes relevant existing skills and experience. Do not add missing qualifications.\\nCV context:\\n' + cv + '\\nCV content:\\n' + input + '\\nJob description:\\n' + job;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/job-alerts') return handleServerAlerts(request, env, url);
    if (url.pathname === '/api/jobs') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': url.origin, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (!allowed(request)) return json({ error: 'Origin not allowed' }, 403);
      const q = String(url.searchParams.get('search') || '').slice(0, 120);
      const type = String(url.searchParams.get('type') || '').slice(0, 30);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 30);
      const upstream = new URL('https://remotive.com/api/remote-jobs');
      if (q) upstream.searchParams.set('search', q);
      if (type) upstream.searchParams.set('type', type);
      upstream.searchParams.set('limit', String(limit));
      try {
        const res = await fetch(upstream.toString(), { headers: { 'accept': 'application/json', 'user-agent': 'CareerPilot/1.0' } });
        if (!res.ok) return json({ error: 'Job provider unavailable.' }, 502);
        const data = await res.json();
        const jobs = Array.isArray(data.jobs) ? data.jobs.slice(0, limit).map(j => ({
          id: j.id, title: j.title, company_name: j.company_name, category: j.category,
          job_type: j.job_type, candidate_required_location: j.candidate_required_location,
          salary: j.salary, publication_date: j.publication_date, url: j.url
        })) : [];
        return json({ jobs, source: 'Remotive', fetched_at: new Date().toISOString() });
      } catch {
        return json({ error: 'Job search failed. Please try again.' }, 502);
      }
    }
    if (url.pathname === '/api/ai') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': url.origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (!allowed(request)) return json({ error: 'Origin not allowed' }, 403);
      if (!env.AI || typeof env.AI.run !== 'function') return json({ error: 'AI service is not configured. Add the Workers AI binding named AI in Cloudflare.' }, 503);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (rateLimited(ip)) return json({ error: 'Hourly AI limit reached. Please try again later.' }, 429);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON request.' }, 400); }
      if (!['bullet','summary','tailor','letter'].includes(body.task)) return json({ error: 'Invalid AI task.' }, 400);
      if (body.task !== 'letter' && !String(body.input || '').trim()) return json({ error: 'Input is required.' }, 400);
      if (body.task === 'tailor' && !String(body.jobDescription || '').trim()) return json({ error: 'Job description is required for tailoring.' }, 400);
      if (body.task === 'letter' && (!String(body.role || '').trim() || !String(body.jobDescription || '').trim())) return json({ error: 'Job title and job description are required.' }, 400);
      try {
        const result = await env.AI.run(MODEL, { prompt: buildPrompt(body), max_tokens: 700, temperature: 0.35 });
        const text = typeof result === 'string' ? result : (result?.response || result?.text || result?.output_text || '');
        return json({ text: String(text).trim().slice(0, 8000) });
      } catch (e) {
        return json({ error: 'AI generation failed. Please try again.' }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processServerAlerts(env));
  }
};
