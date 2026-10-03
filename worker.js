const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const FREE_AI_LIMIT = 3;
const PREMIUM_AI_LIMIT = 100;

const SUPABASE_URL = 'https://gxixgacuryslyoawhrej.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cjEbbJ_VUoT_vKMOR-vBmA_It8gXYQd';
function corsHeaders(origin){return{'access-control-allow-origin':origin,'access-control-allow-methods':'GET, POST, DELETE, OPTIONS','access-control-allow-headers':'content-type, authorization','cache-control':'no-store'}}
function apiJson(data,status,origin){return new Response(JSON.stringify(data),{status,headers:{...corsHeaders(origin),'content-type':'application/json; charset=utf-8'}})}
async function supabaseUser(request){const auth=request.headers.get('Authorization')||'';if(!auth.startsWith('Bearer '))return null;const res=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{apikey:SUPABASE_KEY,authorization:auth,accept:'application/json'}});if(!res.ok)return null;try{return await res.json()}catch{return null}}
function bearer(request){const auth=request.headers.get('Authorization')||'';return auth.startsWith('Bearer ')?auth:null}
async function supabaseRpc(request,name,body){const auth=bearer(request);if(!auth)return null;const res=await fetch(SUPABASE_URL+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:SUPABASE_KEY,authorization:auth,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body||{})});if(!res.ok)return null;try{return await res.json()}catch{return null}}
async function hmacHex(secret,rawBody){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(rawBody)));return [...sig].map(x=>x.toString(16).padStart(2,'0')).join('')}
function safeEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0}
async function supabaseAdmin(env,path,options={}){if(!env.SUPABASE_SERVICE_ROLE_KEY)return null;const res=await fetch(SUPABASE_URL+path,{...options,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,accept:'application/json','content-type':'application/json',...(options.headers||{})}});if(!res.ok)return null;const raw=await res.text();if(!raw)return {ok:true};try{return JSON.parse(raw)}catch{return {ok:true}}}
async function handleBillingWebhook(request,env){
  const secret=env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if(!secret||!env.SUPABASE_SERVICE_ROLE_KEY)return apiJson({error:'Billing webhook is not configured.'},503,'*');
  const raw=await request.text();
  const signature=request.headers.get('X-Signature')||'';
  const digest=await hmacHex(secret,raw);
  if(!safeEqual(digest,signature))return apiJson({error:'Invalid webhook signature.'},401,'*');
  let event;try{event=JSON.parse(raw)}catch{return apiJson({error:'Invalid webhook payload.'},400,'*')}
  const eventName=String(event?.meta?.event_name||request.headers.get('X-Event-Name')||'unknown');
  const eventId=String(event?.data?.id||'')+'::'+eventName;
  const userId=String(event?.meta?.custom_data?.user_id||'');
  if(!eventId||!userId)return apiJson({ok:true},200,'*');
  const saved=await supabaseAdmin(env,'/rest/v1/billing_events',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({event_id:eventId,event_name:eventName,user_id:userId,provider:'lemonsqueezy',payload:event})});
  if(saved===null){
    const check=await fetch(SUPABASE_URL+'/rest/v1/billing_events?event_id=eq.'+encodeURIComponent(eventId),{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,accept:'application/json'}});
    if(check.ok){const rows=await check.json();if(rows?.length)return apiJson({ok:true,duplicate:true},200,'*')}
  }
  const a=event?.data?.attributes||{};
  const status=String(a.status||'').toLowerCase();
  const ends=a.ends_at||null;
  const renews=a.renews_at||null;
  const activeStatuses=new Set(['active','on_trial','past_due','cancelled']);
  const until=ends||renews||new Date(Date.now()+31*86400000).toISOString();
  const active=activeStatuses.has(status)&&(!ends||new Date(ends)>new Date());
  const plan=active?'premium':'free';
  await supabaseAdmin(env,'/rest/v1/user_entitlements',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_id:userId,plan,premium_until:active?until:null,updated_at:new Date().toISOString()})});
  return apiJson({ok:true,plan},200,'*');
}
async function createLemonCheckout(request,env,url){
  if(request.method!=='POST')return apiJson({error:'Method not allowed'},405,url.origin);
  if(!env.LEMONSQUEEZY_API_KEY||!env.LEMONSQUEEZY_STORE_ID||!env.LEMONSQUEEZY_MONTHLY_VARIANT_ID)return apiJson({error:'Payment checkout is not configured yet.'},503,url.origin);
  const user=await supabaseUser(request);if(!user?.id)return apiJson({error:'Sign in required.'},401,url.origin);
  let body;try{body=await request.json()}catch{return apiJson({error:'Invalid JSON request.'},400,url.origin)}
  const plan=body.plan==='yearly'?'yearly':'monthly';
  const variant=plan==='yearly'?(env.LEMONSQUEEZY_YEARLY_VARIANT_ID||env.LEMONSQUEEZY_MONTHLY_VARIANT_ID):env.LEMONSQUEEZY_MONTHLY_VARIANT_ID;
  const payload={data:{type:'checkouts',attributes:{checkout_options:{embed:true},checkout_data:{email:user.email||'',name:user.user_metadata?.full_name||'',custom:{user_id:user.id,plan}},product_options:{redirect_url:url.origin+'/#profile'}},relationships:{store:{data:{type:'stores',id:String(env.LEMONSQUEEZY_STORE_ID)}},variant:{data:{type:'variants',id:String(variant)}}}}};
  const res=await fetch('https://api.lemonsqueezy.com/v1/checkouts',{method:'POST',headers:{Accept:'application/vnd.api+json','Content-Type':'application/vnd.api+json',Authorization:'Bearer '+env.LEMONSQUEEZY_API_KEY},body:JSON.stringify(payload)});
  if(!res.ok)return apiJson({error:'Unable to create checkout.'},502,url.origin);
  const data=await res.json();return apiJson({url:data?.data?.attributes?.url||''},200,url.origin);
}
function alertJobKey(j){return String(j.id||j.url||((j.title||'')+'|'+(j.company_name||'')))}
function alertSalaryMax(j){const s=String(j.salary||'').replace(/,/g,'');const nums=[...s.matchAll(/(?:\$|€|£)?\s*(\d+(?:\.\d+)?)\s*([kKmM])?/g)].map(m=>{let n=Number(m[1]);if((m[2]||'').toLowerCase()==='k')n*=1000;if((m[2]||'').toLowerCase()==='m')n*=1000000;return n});return nums.length?Math.max(...nums):0}
function alertJobExperience(j){const t=String(j.title||'').toLowerCase();if(/senior|sr\.?|lead|principal|staff|manager|director|head|architect/.test(t))return'senior';if(/junior|jr\.?|entry|intern|trainee|graduate/.test(t))return'entry';return'mid'}
function alertJobLocation(j){return Array.isArray(j.candidate_required_location)?j.candidate_required_location.join(', '):String(j.candidate_required_location||'Remote')}
function alertMatchesJob(j,a){const q=String(a.keyword||'').toLowerCase().trim(),loc=String(a.location||'').toLowerCase().trim(),t=[j.title,j.company_name,j.category,...(Array.isArray(j.tags)?j.tags:[])].join(' ').toLowerCase(),jl=alertJobLocation(j).toLowerCase();const words=q.split(/\\s+/).filter(Boolean);if(words.length&&!words.every(w=>t.includes(w)))return false;const broad=/\\b(worldwide|anywhere|remote|global|asia|asia[- ]pacific|apac)\\b/.test(jl);if(loc&&!broad&&!jl.includes(loc)&&!String(j.title||'').toLowerCase().includes(loc)&&!String(j.company_name||'').toLowerCase().includes(loc)&&!String(j.description||'').toLowerCase().includes(loc))return false;if(a.job_type&&String(j.job_type||'')!==a.job_type)return false;if(a.experience&&alertJobExperience(j)!==a.experience)return false;if(Number(a.min_salary||0)&&alertSalaryMax(j)<Number(a.min_salary))return false;return true}

function providerJobs(data){if(Array.isArray(data?.jobs))return data.jobs;if(Array.isArray(data?.data))return data.data;if(Array.isArray(data))return data;return []}
async function fetchRemoteJobs(){
  const providers = [
    {
      name: 'Himalayas',
      url: 'https://himalayas.app/jobs/api?limit=20&offset=0',
      map: j => ({
        id: j.guid || j.applicationLink || (j.title+'|'+j.companyName),
        title: j.title,
        company_name: j.companyName,
        category: Array.isArray(j.parentCategories) ? j.parentCategories.join(', ') : '',
        job_type: String(j.employmentType || '').toLowerCase().replace(/\s+/g,'_'),
        candidate_required_location: Array.isArray(j.locationRestrictions) && j.locationRestrictions.length ? j.locationRestrictions.join(', ') : 'Remote',
        salary: j.minSalary || j.maxSalary ? String(j.minSalary || '') + (j.minSalary && j.maxSalary ? ' - ' : '') + String(j.maxSalary || '') + ' ' + String(j.currency || '') : '',
        publication_date: j.pubDate ? new Date(Number(j.pubDate)*1000).toISOString() : '',
        url: j.applicationLink || j.guid || '',
        description: j.description || j.excerpt || '',
        tags: Array.isArray(j.categories) ? j.categories : []
      })
    },
          {name:'Remote OK',url:'https://remoteok.com/api',map:j=>({id:j.id||j.slug||j.url,title:j.position,company_name:j.company,category:Array.isArray(j.tags)?j.tags.join(', '):'',job_type:(Array.isArray(j.tags)?j.tags:[]).find(x=>/full[ -]?time|part[ -]?time|contract|freelance/i.test(String(x)))?.toLowerCase().replace(/\s+/g,'_')||'',candidate_required_location:j.location||'Remote',salary:j.salary_min||j.salary_max?String(j.salary_min||'')+(j.salary_min&&j.salary_max?' - ':'')+String(j.salary_max||'')+' USD':'',publication_date:j.date||'',url:j.apply_url||j.url||'',description:j.description||'',tags:Array.isArray(j.tags)?j.tags:[]})},
          {name:'Arbeitnow',url:'https://www.arbeitnow.com/api/job-board-api',map:j=>({id:j.slug||j.url||(j.title+'|'+j.company_name),title:j.title,company_name:j.company_name,category:Array.isArray(j.tags)?j.tags.join(', '):'',job_type:Array.isArray(j.job_types)?String(j.job_types[0]||'').toLowerCase().replace(/\s+/g,'_'):String(j.job_types||'').toLowerCase().replace(/\s+/g,'_'),candidate_required_location:j.remote?'Remote':(j.location||'Remote'),salary:'',publication_date:j.created_at?new Date(Number(j.created_at)*1000).toISOString():'',url:j.url||'',description:j.description||'',tags:Array.isArray(j.tags)?j.tags:[]})},
    {
      name: 'Jobicy',
      url: 'https://jobicy.com/api/v2/remote-jobs?count=100',
      map: j => ({
        id: j.id,
        title: j.jobTitle,
        company_name: j.companyName,
        category: Array.isArray(j.jobIndustry) ? j.jobIndustry.join(', ') : String(j.jobIndustry || ''),
        job_type: Array.isArray(j.jobType) ? String(j.jobType[0] || '').toLowerCase().replace(/[-\s]+/g,'_') : String(j.jobType || '').toLowerCase().replace(/-/g,'_'),
        candidate_required_location: j.jobGeo || 'Remote',
        salary: j.salaryMin || j.salaryMax ? String(j.salaryMin || '') + (j.salaryMin && j.salaryMax ? ' - ' : '') + String(j.salaryMax || '') + ' ' + String(j.salaryCurrency || '') : '',
        publication_date: j.pubDate,
        url: j.url,
        description: j.jobDescription || j.jobExcerpt || '',
        tags: Array.isArray(j.jobIndustry) ? j.jobIndustry : []
      })
    },
    {
      name: 'Remotive',
      url: 'https://remotive.com/api/remote-jobs?limit=100',
      map: j => ({
        id:j.id,title:j.title,company_name:j.company_name,category:j.category,job_type:j.job_type,
        candidate_required_location:j.candidate_required_location,salary:j.salary,publication_date:j.publication_date,
        url:j.url,description:j.description||'',tags:Array.isArray(j.tags)?j.tags:[]
      })
    }
  ];
  const results = await Promise.all(providers.map(async provider => {
    try {
      const res = await fetch(provider.url, {headers:{accept:'application/json','user-agent':'CareerPilot/1.0'}});
      if (!res.ok) return [];
      const data = await res.json();
      const raw = providerJobs(data);
      return raw.map(provider.map).filter(j => j && j.title && j.url);
    } catch {
      return [];
    }
  }));
  const jobs = results.flat();
  if (!jobs.length) throw new Error('Job provider unavailable');
  const seen = new Set();
  return jobs.filter(j => {
    const key = String(j.url || j.id || ((j.title || '') + '|' + (j.company_name || '')));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
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
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const live = await fetch('https://raw.githubusercontent.com/haris730/careerpilot/main/index.html', { headers: { accept: 'text/html' } });
        if (live.ok) return new Response(await live.text(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      } catch {}
    }
    if (url.pathname === '/api/billing/webhook') return handleBillingWebhook(request, env);
    if (url.pathname === '/api/checkout') return createLemonCheckout(request, env, url);
    if (url.pathname === '/api/job-alerts') return handleServerAlerts(request, env, url);
    if (url.pathname === '/api/jobs') {
      const jobsOrigin = 'https://careerpilot.pages.dev';
      const cors = {'content-type':'application/json; charset=utf-8','access-control-allow-origin':jobsOrigin,'cache-control':'no-store'};
      if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:{'access-control-allow-origin':jobsOrigin,'access-control-allow-methods':'GET, OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'86400'}});
      if (request.method !== 'GET') return new Response(JSON.stringify({error:'Method not allowed'}),{status:405,headers:cors});
      const requestOrigin=request.headers.get('Origin');
      if (requestOrigin && requestOrigin!==jobsOrigin) return new Response(JSON.stringify({error:'Origin not allowed'}),{status:403,headers:cors});
      const q=String(url.searchParams.get('search')||'').trim().toLowerCase().slice(0,120);
      const type=String(url.searchParams.get('type')||'').slice(0,30);
      const limit=Math.min(Math.max(Number(url.searchParams.get('limit')||30),1),60);
      try {
        const remotiveUrl=q?'https://remotive.com/api/remote-jobs?limit=100&search='+encodeURIComponent(q):'https://remotive.com/api/remote-jobs?limit=100';
        const providers=[
          {name:'Remotive',url:remotiveUrl,map:j=>({id:j.id,title:j.title,company_name:j.company_name,category:j.category,job_type:String(j.job_type||'').toLowerCase().replace(/[-\s]+/g,'_'),candidate_required_location:j.candidate_required_location||'Remote',salary:j.salary||'',publication_date:j.publication_date||'',url:j.url,description:j.description||'',tags:Array.isArray(j.tags)?j.tags:[]})},
          {name:'Remote OK',url:'https://remoteok.com/api',map:j=>({id:j.id||j.slug||j.url,title:j.position,company_name:j.company,category:Array.isArray(j.tags)?j.tags.join(', '):'',job_type:(Array.isArray(j.tags)?j.tags:[]).find(x=>/full[ -]?time|part[ -]?time|contract|freelance/i.test(String(x)))?.toLowerCase().replace(/[-\s]+/g,'_')||'',candidate_required_location:j.location||'Remote',salary:j.salary_min||j.salary_max?String(j.salary_min||'')+(j.salary_min&&j.salary_max?' - ':'')+String(j.salary_max||'')+' USD':'',publication_date:j.date||'',url:j.apply_url||j.url||'',description:j.description||'',tags:Array.isArray(j.tags)?j.tags:[]})},
          {name:'Arbeitnow',url:'https://www.arbeitnow.com/api/job-board-api',map:j=>({id:j.slug||j.url||(j.title+'|'+j.company_name),title:j.title,company_name:j.company_name,category:Array.isArray(j.tags)?j.tags.join(', '):'',job_type:Array.isArray(j.job_types)?String(j.job_types[0]||'').toLowerCase().replace(/[-\s]+/g,'_'):String(j.job_types||'').toLowerCase().replace(/[-\s]+/g,'_'),candidate_required_location:j.remote?'Remote':(j.location||'Remote'),salary:'',publication_date:j.created_at?new Date(Number(j.created_at)*1000).toISOString():'',url:j.url||'',description:j.description||'',tags:Array.isArray(j.tags)?j.tags:[]})},
          {name:'Jobicy',url:'https://jobicy.com/api/v2/remote-jobs?count=100',map:j=>({id:j.id,title:j.jobTitle,company_name:j.companyName,category:Array.isArray(j.jobIndustry)?j.jobIndustry.join(', '):String(j.jobIndustry||''),job_type:Array.isArray(j.jobType)?String(j.jobType[0]||'').toLowerCase().replace(/[-\s]+/g,'_'):String(j.jobType||'').toLowerCase().replace(/[-\s]+/g,'_'),candidate_required_location:j.jobGeo||'Remote',salary:j.salaryMin||j.salaryMax?String(j.salaryMin||'')+(j.salaryMin&&j.salaryMax?' - ':'')+String(j.salaryMax||'')+' '+String(j.salaryCurrency||''):'',publication_date:j.pubDate||'',url:j.url||'',description:j.jobDescription||j.jobExcerpt||'',tags:Array.isArray(j.jobIndustry)?j.jobIndustry:[]})},
          {name:'Himalayas',url:'https://himalayas.app/jobs/api?limit=50&offset=0',map:j=>({id:j.guid||j.applicationLink||(j.title+'|'+j.companyName),title:j.title,company_name:j.companyName,category:Array.isArray(j.parentCategories)?j.parentCategories.join(', '):'',job_type:String(j.employmentType||'').toLowerCase().replace(/[-\s]+/g,'_'),candidate_required_location:Array.isArray(j.locationRestrictions)&&j.locationRestrictions.length?j.locationRestrictions.join(', '):'Remote',salary:j.minSalary||j.maxSalary?String(j.minSalary||'')+(j.minSalary&&j.maxSalary?' - ':'')+String(j.maxSalary||'')+' '+String(j.currency||''):'',publication_date:j.pubDate?new Date(Number(j.pubDate)*1000).toISOString():'',url:j.applicationLink||j.guid||'',description:j.description||j.excerpt||'',tags:Array.isArray(j.categories)?j.categories:[]})}
        ];
        const results=await Promise.all(providers.map(async p=>{
          try{
            const r=await fetch(p.url,{headers:{accept:'application/json','user-agent':'CareerPilot/1.0'}});
            if(!r.ok)return {source:p.name,jobs:[]};
            const d=await r.json();
            const raw=providerJobs(d);
            return {source:p.name,jobs:raw.map(p.map).filter(j=>j.title&&j.url)};
          }catch{return {source:p.name,jobs:[]}}
        }));
        let jobs=results.flatMap(x=>x.jobs.map(j=>({...j,_source:x.source})));
        if(q){const words=q.split(/\\s+/).filter(Boolean);jobs=jobs.filter(j=>{const text=[j.title,j.company_name,j.category,j.description,...(j.tags||[]),j.candidate_required_location].join(' ').toLowerCase();return words.every(w=>text.includes(w))});}
        if(type)jobs=jobs.filter(j=>String(j.job_type||'')===type);
        const seen=new Set();
        jobs=jobs.filter(j=>{const k=String(j.id||j.url||j.title+'|'+j.company_name);if(seen.has(k))return false;seen.add(k);return true});
        jobs.sort((a,b)=>new Date(b.publication_date||0)-new Date(a.publication_date||0));
        const sources=[...new Set(jobs.map(j=>j._source))];
        jobs=jobs.slice(0,limit).map(({_source,...j})=>({...j,source:_source}));
        if(!jobs.length)return new Response(JSON.stringify({jobs:[],source:sources.join(', ')||'Live providers',fetched_at:new Date().toISOString()}),{status:200,headers:cors});
        return new Response(JSON.stringify({jobs,source:sources.join(', '),fetched_at:new Date().toISOString()}),{status:200,headers:cors});
      }catch{
        return new Response(JSON.stringify({error:'Job search failed. Please try again.'}),{status:502,headers:cors});
      }
    }
    if (url.pathname === '/api/ai') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': url.origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (!allowed(request)) return json({ error: 'Origin not allowed' }, 403);
      if (!env.AI || typeof env.AI.run !== 'function') return json({ error: 'AI service is not configured. Add the Workers AI binding named AI in Cloudflare.' }, 503);
      const user = await supabaseUser(request);
      if (!user?.id) return json({ error: 'Sign in required for AI tools.' }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON request.' }, 400); }
      if (!['bullet','summary','tailor','letter'].includes(body.task)) return json({ error: 'Invalid AI task.' }, 400);
      if (body.task !== 'letter' && !String(body.input || '').trim()) return json({ error: 'Input is required.' }, 400);
      if (body.task === 'tailor' && !String(body.jobDescription || '').trim()) return json({ error: 'Job description is required for tailoring.' }, 400);
      if (body.task === 'letter' && (!String(body.role || '').trim() || !String(body.jobDescription || '').trim())) return json({ error: 'Job title and job description are required.' }, 400);
      const quota = await supabaseRpc(request,'consume_ai_credit',{p_kind:String(body.task||'ai'),p_free_limit:FREE_AI_LIMIT,p_premium_limit:PREMIUM_AI_LIMIT});
      if (!quota) return json({ error: 'Usage service unavailable. Please try again.' }, 503);
      if (!quota.allowed) return json({ error: 'Free AI limit reached. Upgrade to Premium for more AI actions.' , code:'AI_LIMIT_REACHED', plan:quota.plan, remaining:quota.remaining}, 402);
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
