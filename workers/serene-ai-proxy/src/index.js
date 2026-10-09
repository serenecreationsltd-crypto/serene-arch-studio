/**
 * Serene Creations Ltd — AI Worker v4 (hardened)
 *
 * PUBLIC (browser) routes — no shared secret in any web page:
 *   POST /boq-generate  fixed, clamped inputs; prompt composed here; origin allowlist; per-IP limits
 *   POST /scrape        Firebase sign-in required (Pro/Premium subscriber or admin); per-user limits
 *   GET  /news[?ai=1]   live industry headlines (+ cached AI briefing)
 *   GET  /health
 *
 * SERVER-TO-SERVER (Activepieces only):
 *   POST /              Anthropic proxy — header X-Server-Secret; model allowlist; token cap
 *   POST /scrape        also accepts X-Server-Secret
 *
 * The old X-Proxy-Secret header is no longer accepted anywhere.
 *
 * Secrets / bindings (Settings → Variables and Secrets / Bindings):
 *   ANTHROPIC_API_KEY  (secret)
 *   SERVER_SECRET      (secret — never put in a web page)
 *   FIREBASE_SECRET    (secret — RTDB database secret)
 *   RATE_KV            (KV binding → namespace serene-ai-ratelimit)
 *   DAILY_AI_CAP       (optional plain variable, default 250 Anthropic calls/day)
 */

const FIREBASE_DB = 'https://serene-creations-default-rtdb.firebaseio.com';
const FIREBASE_WEB_KEY = 'AIzaSyDmwc6sp35Bxs0L3csv4qUBJ2yyuP_0beo'; // public web key, used only to verify sign-in tokens
const ACTIVEPIECES_LEAD_HOOK = 'https://cloud.activepieces.com/api/v1/webhooks/gaqpTTBjcrwCpNPukckrm';

const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
const MAX_TOKENS_CAP = 2500;

const ALLOWED_HOSTS = ['serenecreations.org', 'serene-boq.pages.dev', 'serene-tenders-hub.pages.dev', 'serene-portal.pages.dev', 'landingsite.ai'];

/* ═════════════ ENTRY ═════════════ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsFor(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (request.method === 'GET') {
        if (url.pathname === '/news')   return await handleNews(url, env, cors);
        if (url.pathname === '/health') return json({ ok: true, version: 4, time: new Date().toISOString() }, 200, cors);
        return json({ error: 'Not found' }, 404, cors);
      }
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

      const isServer = !!env.SERVER_SECRET && timingSafeEqual(request.headers.get('X-Server-Secret') || '', env.SERVER_SECRET);

      if (url.pathname === '/boq-generate') return await handleBoq(request, env, cors, origin);
      if (url.pathname === '/scrape')       return await handleScrapeRoute(request, env, cors, isServer);
      if (url.pathname === '/')             return await handleServerProxy(request, env, cors, isServer);
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'Server error', detail: String(e.message || e).slice(0, 200) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTenderScraper(env));
  }
};

/* ═════════════ SERVER PROXY (Activepieces) ═════════════ */

async function handleServerProxy(request, env, cors, isServer) {
  if (!isServer) return json({ error: 'Unauthorized' }, 401, cors);
  if (!(await allow(env, 'server', 300, 86400))) return json({ error: 'Daily server quota reached' }, 429, cors);
  if (!(await allowGlobalAI(env))) return json({ error: 'Daily AI budget reached' }, 429, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400, cors); }
  const model = ALLOWED_MODELS.includes(body.model) ? body.model : ALLOWED_MODELS[0];
  const safe = {
    model,
    max_tokens: Math.min(Math.max(parseInt(body.max_tokens) || 1500, 1), MAX_TOKENS_CAP),
    messages: Array.isArray(body.messages) ? body.messages.slice(0, 20) : []
  };
  if (typeof body.system === 'string') safe.system = body.system.slice(0, 8000);
  if (!safe.messages.length) return json({ error: 'messages required' }, 400, cors);

  const res = await callClaude(env, safe);
  const data = await res.json();
  if (!res.ok) return json({ error: data?.error?.message || 'Anthropic API error' }, res.status, cors);
  return json(data, 200, cors);
}

/* ═════════════ BOQ GENERATOR (public, hardened) ═════════════ */

// ── Planning ratio bounds (review with your QS — single place to tune) ──
// Each ratio is expressed relative to gross floor area (GFA).
// AI sections falling outside these bands are withheld, not shown.
const RATIO_BANDS = {
  preliminaries:  { min: 0.04, max: 0.09 },   // 4–9 % of construction cost
  substructure:   { min: 0.10, max: 0.22 },   // substructure ÷ GFA (m²/m²)
  superstructure: { min: 0.25, max: 0.55 },
  roofing:        { min: 0.08, max: 0.20 },
  finishes:       { min: 0.18, max: 0.40 },
  doorsWindows:   { min: 0.06, max: 0.15 },
  plumbing:       { min: 0.05, max: 0.14 },
  electrical:     { min: 0.04, max: 0.11 },
  external:       { min: 0.04, max: 0.14 }
};

// ── Rate matrix — SINGLE SOURCE OF TRUTH for all site pages ──
// All-in rates (materials + labour) in UGX per m² of GFA
// These replace smart-site-tools.js and any other estimator on the site.
const RATE_MATRIX = {
  meta: {
    currency: 'UGX',
    basis: 'Gross Floor Area (GFA)',
    updated: '2026-Q3',
    region: 'Uganda — Kampala/Mukono base; rural deduct 8–15%',
    exclusions: 'Professional fees, land, furniture, external utilities',
    authority: 'Serene Creations Ltd — review annually'
  },
  byFinish: {
    basic:    { min: 1200000, max: 1650000, label: 'Basic (cement screed, basic fittings)' },
    standard: { min: 1550000, max: 2100000, label: 'Standard (ceramic tiles, standard fittings)' },
    highEnd:  { min: 2000000, max: 2900000, label: 'High-end (granite/marble, premium fittings)' }
  },
  byType: {
    residentialHouse:    { factor: 1.00 },
    apartmentBuilding:   { factor: 1.10 },
    commercialBuilding:  { factor: 1.20 },
    renovation:          { factor: 0.65 },
    perimeterWall:       { factor: 0.00, perMetre: { min: 290000, max: 480000 } }
  },
  sections: {
    A: { name: 'Preliminaries',        pctMin: 0.05, pctMax: 0.08 },
    B: { name: 'Substructure',         pctMin: 0.12, pctMax: 0.20 },
    C: { name: 'Superstructure',       pctMin: 0.28, pctMax: 0.48 },
    D: { name: 'Roofing',              pctMin: 0.09, pctMax: 0.17 },
    E: { name: 'Finishes',             pctMin: 0.20, pctMax: 0.36 },
    F: { name: 'Doors & Windows',      pctMin: 0.07, pctMax: 0.13 },
    G: { name: 'Plumbing & Sanitation',pctMin: 0.06, pctMax: 0.12 },
    H: { name: 'Electrical',           pctMin: 0.04, pctMax: 0.10 },
    I: { name: 'External Works',       pctMin: 0.04, pctMax: 0.12 }
  },
  contingency:       0.10,
  professionalFees:  0.08
};

const BOQ_SPEC = {
  projectType: ['Residential House', 'Apartment Building', 'Commercial Building', 'Renovation / Extension', 'Perimeter Wall & Gate', 'Other'],
  walling:     ['Hollow concrete blocks (150mm)', 'Solid concrete blocks (150mm)', 'Burnt clay bricks', 'Stone masonry'],
  roofing:     ['Iron sheet roofing on timber trusses', 'Clay roof tiles on timber trusses', 'Flat concrete slab roof', 'Mabati (corrugated iron) roofing'],
  foundation:  ['Strip foundation in firm ground', 'Raft foundation', 'Pad and beam foundation'],
  extras:      ['Covered veranda', 'Garage / carport', 'Perimeter wall and gate', 'Rainwater harvesting tank', 'Solar installation', 'Borehole'],
  location:    ['Kampala / Wakiso', 'Mukono / Jinja', 'Entebbe / Masaka', 'Mbale / Eastern Uganda', 'Mbarara / Western Uganda', 'Gulu / Northern Uganda', 'Rural Uganda']
};
const pick = (list, v, dflt) => (list.includes(v) ? v : dflt);

async function handleBoq(request, env, cors, origin) {
  if (!originAllowed(origin)) return json({ error: 'Origin not allowed', code: 'FORBIDDEN_ORIGIN' }, 403, cors);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await allow(env, 'boq-h:' + ip, 4, 3600)) || !(await allow(env, 'boq-d:' + ip, 10, 86400)))
    return json({ error: 'You have reached the hourly limit for AI estimates. Try again later, or email info@serenecreations.org.', code: 'RATE_LIMITED' }, 429, cors);
  if (!(await allowGlobalAI(env))) return json({ error: 'AI estimates are paused for today. The standard estimate is still available.', code: 'BUDGET', fallback: true }, 503, cors);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI unavailable', code: 'NO_KEY', fallback: true }, 503, cors);

  let b;
  try { b = await request.json(); } catch { return json({ error: 'Invalid request body' }, 400, cors); }

  const projectType = pick(BOQ_SPEC.projectType, b.projectType, 'Residential House');
  const areaM2      = Math.min(Math.max(parseFloat(b.areaM2) || 100, 10), 20000);
  const floors      = Math.min(Math.max(parseInt(b.floors) || 1, 1), 10);
  const finishLevel = ['basic', 'standard', 'highEnd'].includes(b.finishLevel) ? b.finishLevel : 'standard';
  const location    = pick(BOQ_SPEC.location, b.location, 'Mukono / Jinja');
  const walling     = pick(BOQ_SPEC.walling, b.walling, BOQ_SPEC.walling[0]);
  const roofing     = pick(BOQ_SPEC.roofing, b.roofing, BOQ_SPEC.roofing[0]);
  const foundation  = pick(BOQ_SPEC.foundation, b.foundation, BOQ_SPEC.foundation[0]);
  const extras      = (Array.isArray(b.extras) ? b.extras : []).filter(x => BOQ_SPEC.extras.includes(x)).slice(0, 6);
  const clientEmail = /^[^@\s]{1,64}@[^@\s]{1,120}\.[a-z]{2,}$/i.test(String(b.clientEmail || '')) ? String(b.clientEmail) : '';

  const rates = RATE_MATRIX.byFinish[finishLevel];
  const sectionGuide = Object.entries(RATE_MATRIX.sections).map(([k, s]) =>
    `  ${k} ${s.name}: ${(s.pctMin * 100).toFixed(0)}–${(s.pctMax * 100).toFixed(0)}% of construction cost`).join('\n');

  const prompt = `You are a senior quantity surveyor at Serene Creations Ltd, an engineering consultancy in Mukono, Uganda. Prepare a planning-level bill of quantities using Uganda 2026 market rates.

PROJECT (fixed inputs, do not change them):
Type: ${projectType}
Gross floor area: ${areaM2} m²
Floors: ${floors}
Finish level: ${finishLevel} (all-in rate band UGX ${(rates.min / 1e6).toFixed(2)}M–${(rates.max / 1e6).toFixed(2)}M per m²)
Walling: ${walling}
Roofing: ${roofing}
Foundation: ${foundation}
Extras: ${extras.length ? extras.join(', ') : 'none'}
Location: ${location}

SECTION COST BANDS (% of construction cost; keep each section inside its band):
${sectionGuide}
Contingency 10%, professional fees 8%.

For each section A–I give 5–8 line items: ref, description, unit, quantity, rateMin, rateMax (UGX), notes.
Each section must include "sectionRatioUsed" (section total at mid rates ÷ total construction cost) and "withinBand" (true/false).

Return ONLY valid JSON:
{"sections":[{"id":"A","title":"PRELIMINARIES","sectionRatioUsed":0.06,"withinBand":true,"items":[{"ref":"A.1","description":"...","unit":"sum","quantity":1,"rateMin":500000,"rateMax":800000,"notes":"..."}]}],
 "contingencyPct":10,"professionalFeesPct":8,"keyAssumptions":["...","..."]}`;

  const aiRes = await callClaude(env, { model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
  const aiData = await aiRes.json();
  if (!aiRes.ok) return json({ error: 'AI generation failed. The standard estimate is still available.', code: 'AI_FAILED', fallback: true }, 502, cors);

  let boq;
  try { boq = JSON.parse((aiData.content?.[0]?.text || '').match(/\{[\s\S]*\}/)[0]); }
  catch { return json({ error: 'AI returned an unreadable estimate. Try again.', code: 'PARSE', fallback: true }, 502, cors); }

  // Audit: withhold sections outside planning bands
  const bandKeys = { PRELIMINARIES: 'preliminaries', SUBSTRUCTURE: 'substructure', SUPERSTRUCTURE: 'superstructure', ROOFING: 'roofing',
    FINISHES: 'finishes', DOORS: 'doorsWindows', PLUMBING: 'plumbing', ELECTRICAL: 'electrical', EXTERNAL: 'external' };
  const withheld = [];
  boq.sections = (boq.sections || []).filter(sec => {
    const key = Object.keys(bandKeys).find(k => String(sec.title || '').toUpperCase().includes(k));
    const band = key && RATIO_BANDS[bandKeys[key]];
    if (!band) return true;
    const r = Number(sec.sectionRatioUsed) || 0;
    if (r < band.min || r > band.max) { withheld.push(sec.title); return false; }
    return true;
  }).map(sec => ({ ...sec, items: (sec.items || []).slice(0, 10).map(it => ({
    ref: String(it.ref || '').slice(0, 10), description: String(it.description || '').slice(0, 160), unit: String(it.unit || '').slice(0, 10),
    quantity: Math.max(0, Number(it.quantity) || 0), rateMin: Math.max(0, Number(it.rateMin) || 0), rateMax: Math.max(0, Number(it.rateMax) || 0),
    notes: String(it.notes || '').slice(0, 200) })) }));

  boq.contingencyPct = 10;
  boq.professionalFeesPct = 8;
  boq.inputs = { projectType, areaM2, floors, finishLevel, location, walling, roofing, foundation, extras };
  if (withheld.length) boq.withheldSections = withheld;
  boq.disclaimer = 'Planning-level estimate. For a measured bill of quantities, send drawings to info@serenecreations.org.';

  if (clientEmail) {
    fetch(ACTIVEPIECES_LEAD_HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'BOQ Request', email: clientEmail, phone: '', company: '', service: 'BOQ Generator — ' + projectType,
        message: `AI BOQ generated: ${areaM2} m², ${floors} floor(s), ${finishLevel} finish, ${location}. Sections returned: ${boq.sections.length}` + (withheld.length ? '. Withheld: ' + withheld.join(', ') : '') })
    }).catch(() => {});
  }
  return json(boq, 200, cors);
}

/* ═════════════ SCRAPE ROUTE ═════════════ */

async function handleScrapeRoute(request, env, cors, isServer) {
  if (!isServer) {
    const user = await verifyFirebaseUser(request);
    if (!user) return json({ error: 'Sign in to fetch live tenders.', code: 'AUTH' }, 401, cors);
    const [admin, sub] = await Promise.all([
      fbGet('admins/' + user.uid, user.token),
      fbGet('subscribers/' + user.uid, user.token)
    ]);
    const tier = sub?.tier || 'free';
    if (admin !== true && tier !== 'pro' && tier !== 'premium')
      return json({ error: 'Live fetch is a Pro feature.', code: 'TIER' }, 403, cors);
    if (!(await allow(env, 'scrape-u:' + user.uid, 3, 3600)))
      return json({ error: 'You can fetch live tenders 3 times per hour. Try again later.', code: 'RATE_LIMITED' }, 429, cors);
  }
  if (!(await allow(env, 'scrape-global', 24, 86400)))
    return json({ error: 'Live fetch limit for today reached. The daily update still runs automatically.', code: 'RATE_LIMITED' }, 429, cors);
  if (!(await allowGlobalAI(env))) return json({ error: 'Daily AI budget reached' }, 429, cors);

  const result = await runTenderScraper(env);
  return json({ ok: !result.error && !result.reason, ...result }, 200, cors);
}

async function verifyFirebaseUser(request) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_WEB_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: m[1] })
  });
  if (!res.ok) return null;
  const u = (await res.json()).users?.[0];
  return u ? { uid: u.localId, email: u.email || '', token: m[1] } : null;
}

async function fbGet(path, idToken) {
  const res = await fetch(FIREBASE_DB + '/' + path + '.json?auth=' + encodeURIComponent(idToken));
  return res.ok ? res.json() : null;
}

/* ═════════════ TENDER SCRAPER — per-notice links ═════════════ */

const TENDER_SOURCES = [
  { url: 'https://gpp.ppda.go.ug/tenderer-notices',  name: 'PPDA Uganda' },
  { url: 'https://www.unra.go.ug/index.php/tenders', name: 'UNRA Uganda' },
  { url: 'https://www.kcca.go.ug/tenders',           name: 'KCCA Uganda' },
  { url: 'https://www.nwsc.co.ug/tenders',           name: 'NWSC Uganda' },
  { url: 'https://www.health.go.ug/procurement',     name: 'Ministry of Health' }
];

// Replace each <a href> with "text [L#]" BEFORE stripping tags, so notices keep their own links
function htmlToTextWithLinks(html, baseUrl, links) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
             .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  html = html.replace(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let abs;
    try { abs = new URL(href.trim(), baseUrl).href; } catch { return ' ' + text + ' '; }
    if (!/^https?:\/\//i.test(abs) || /^(mailto|tel|javascript):/i.test(href)) return ' ' + text + ' ';
    const n = links.push(abs);
    return ' ' + text + ' [L' + n + '] ';
  });
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function runTenderScraper(env) {
  if (!env.ANTHROPIC_API_KEY || !env.FIREBASE_SECRET) return { saved: 0, reason: 'Missing secrets' };
  const AUTH = '?auth=' + env.FIREBASE_SECRET;

  const fullRes = await fetch(FIREBASE_DB + '/tenders.json' + AUTH);
  if (!fullRes.ok) return { saved: 0, reason: 'Firebase rejected the database secret (HTTP ' + fullRes.status + ')' };
  const existing = await fullRes.json();
  const existingTitles = new Set(existing ? Object.values(existing).map(t => String(t.title || '').toLowerCase()) : []);

  const links = [];
  let corpus = '', sourcesHit = 0;
  for (const src of TENDER_SOURCES) {
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SereneBot/1.0)' }, signal: AbortSignal.timeout(9000) });
      if (!res.ok) continue;
      const text = htmlToTextWithLinks(await res.text(), src.url, links).slice(0, 6000);
      corpus += `\n\n=== SOURCE: ${src.name} | LISTING PAGE: ${src.url} ===\n${text}`;
      sourcesHit++;
    } catch { /* unavailable */ }
  }
  if (!corpus) return { saved: 0, scraped: 0, sourcesHit: 0, reason: 'No sources responded' };

  const prompt = `Extract tender / procurement notices from these Uganda public-sector pages. Links appear as [L#] right after the link text.
Return a JSON array; each object:
{ "title", "category", "procuringEntity", "location", "referenceNo", "publishedDate", "closingDate", "estimatedValue", "description", "source", "linkRef", "matchScore" }
- category: "Construction Works" | "Engineering Consultancy" | "Civil Works" | "Architecture & Design" | "Supply of Goods" | "Services"
- source: the SOURCE name of the section the notice came from
- linkRef: the number of the [L#] link that belongs to THIS notice (its notice page, bid document or PDF). Use null if the notice has no link of its own. Never reuse a navigation or menu link.
- dates as YYYY-MM-DD; estimatedValue in UGX, 0 if not stated; matchScore 0-100 relevance to a civil/structural engineering and construction firm
Only include notices actually present in the text. Return ONLY the JSON array.
${corpus}`;

  const aiRes = await callClaude(env, { model: 'claude-sonnet-4-6', max_tokens: 3500, messages: [{ role: 'user', content: prompt }] });
  const aiData = await aiRes.json();
  let tenders;
  try { tenders = JSON.parse((aiData.content?.[0]?.text || '[]').match(/\[[\s\S]*\]/)[0]); }
  catch { return { saved: 0, scraped: 0, sourcesHit, error: 'Parse failed' }; }

  const today = new Date().toISOString().split('T')[0];
  const newTenders = [];
  for (const t of tenders) {
    if (!t.title || existingTitles.has(String(t.title).toLowerCase())) continue;
    const src = TENDER_SOURCES.find(s => s.name === t.source) || TENDER_SOURCES[0];
    const n = parseInt(t.linkRef);
    const noticeUrl = n >= 1 && n <= links.length ? links[n - 1] : null;   // only links actually captured from the page
    const rec = {
      id: 'live-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      title: String(t.title).slice(0, 240), category: t.category || 'Services', procuringEntity: t.procuringEntity || '',
      location: t.location || '', referenceNo: t.referenceNo || '', publishedDate: t.publishedDate || '', closingDate: t.closingDate || '',
      estimatedValue: Number(t.estimatedValue) || 0, description: String(t.description || '').slice(0, 800), source: src.name,
      bidDocumentsUrl: noticeUrl || src.url, urlType: noticeUrl ? 'notice' : 'listing', listingUrl: src.url,
      matchScore: Math.max(0, Math.min(100, Number(t.matchScore) || 70)), status: 'Active', tier: 'pro', addedDate: today
    };
    await fetch(FIREBASE_DB + '/tenders/' + rec.id + '.json' + AUTH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
    newTenders.push(rec);
    existingTitles.add(rec.title.toLowerCase());
    await new Promise(r => setTimeout(r, 150));
  }
  return { saved: newTenders.length, scraped: tenders.length, sourcesHit, linksCaptured: links.length, newTenders };
}

/* ═════════════ NEWS FEED ═════════════ */

const NEWS_FEEDS = [
  { q: 'Uganda construction', tag: 'Construction' },
  { q: 'Uganda infrastructure project', tag: 'Infrastructure' },
  { q: 'Uganda real estate', tag: 'Real estate' },
  { q: 'Uganda tender procurement PPDA', tag: 'Procurement' },
  { q: 'East Africa engineering', tag: 'Engineering' }
];
const MEM = { news: null, newsAt: 0, digest: null, digestAt: 0, rl: new Map() };

async function handleNews(url, env, cors) {
  const wantAI = url.searchParams.get('ai') === '1';
  const now = Date.now();
  if (!MEM.news || now - MEM.newsAt > 30 * 60e3) {
    const fresh = await fetchFeeds();
    if (fresh.length) { MEM.news = fresh; MEM.newsAt = now; }
  }
  if (wantAI && env.ANTHROPIC_API_KEY && MEM.news?.length && (!MEM.digest || now - MEM.digestAt > 6 * 3600e3)) {
    // at most 6 briefings per day across all isolates
    if (await allow(env, 'digest', 6, 86400) && await allowGlobalAI(env)) {
      try { MEM.digest = await buildDigest(MEM.news, env); MEM.digestAt = now; } catch { /* keep previous */ }
    }
  }
  return new Response(JSON.stringify({
    ok: true, updated: MEM.newsAt ? new Date(MEM.newsAt).toISOString() : null, items: MEM.news || [],
    digest: wantAI ? MEM.digest : null, digestUpdated: wantAI && MEM.digestAt ? new Date(MEM.digestAt).toISOString() : null
  }), { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } });
}

async function fetchFeeds() {
  const results = await Promise.all(NEWS_FEEDS.map(async f => {
    try {
      const rss = 'https://news.google.com/rss/search?q=' + encodeURIComponent(f.q + ' when:14d') + '&hl=en-UG&gl=UG&ceid=UG:en';
      const res = await fetch(rss, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SereneFeed/1.0)' }, signal: AbortSignal.timeout(8000) });
      return res.ok ? parseRss(await res.text(), f.tag) : [];
    } catch { return []; }
  }));
  const seen = new Set();
  return results.flat()
    .filter(i => i.title && i.link && !seen.has(i.title.toLowerCase()) && seen.add(i.title.toLowerCase()))
    .sort((a, b) => new Date(b.published) - new Date(a.published)).slice(0, 30);
}

function parseRss(xml, tag) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 8) {
    const b = m[1];
    const get = t => { const r = b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')); return r ? decode(r[1]) : ''; };
    const src = b.match(/<source url="([^"]*)">([\s\S]*?)<\/source>/);
    const source = src ? decode(src[2]) : '';
    let title = get('title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    items.push({ title, link: get('link'), published: get('pubDate'), source, sourceUrl: src ? src[1] : '', tag });
  }
  return items;
}
function decode(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
}

async function buildDigest(items, env) {
  const top = items.slice(0, 18);
  const list = top.map((i, n) => `[${n + 1}] (${i.tag}) ${i.title} — ${i.source}`).join('\n');
  const prompt = `You write a short briefing for Serene Creations Ltd, an engineering consultancy and real estate firm in Mukono, Uganda.
Using ONLY the headlines below, write 4 points on what matters this week for construction, infrastructure, procurement and property in Uganda and East Africa.
Do not invent facts, figures or names that are not in the headlines. Each point is one or two plain sentences and cites its headline number.
Return ONLY JSON: {"summary":"one sentence overview","points":[{"text":"...","ref":1}]}

${list}`;
  const res = await callClaude(env, { model: 'claude-sonnet-4-6', max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
  const raw = (await res.json()).content?.[0]?.text || '';
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  parsed.points = (parsed.points || []).slice(0, 4).map(p => {
    const src = top[(parseInt(p.ref) || 1) - 1];
    return { text: String(p.text || ''), link: src?.link || '', source: src?.source || '' };
  });
  return parsed;
}

/* ═════════════ LIMITS ═════════════ */

// Fixed-window counter: KV when bound (shared across all edge locations), in-memory fallback
async function allow(env, key, max, windowSec) {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = 'rl:' + key + ':' + bucket;
  if (env.RATE_KV) {
    const n = parseInt(await env.RATE_KV.get(k)) || 0;
    if (n >= max) return false;
    await env.RATE_KV.put(k, String(n + 1), { expirationTtl: Math.max(60, windowSec + 60) });
    return true;
  }
  const n = MEM.rl.get(k) || 0;
  if (n >= max) return false;
  MEM.rl.set(k, n + 1);
  if (MEM.rl.size > 5000) MEM.rl.clear();
  return true;
}
function allowGlobalAI(env) {
  return allow(env, 'ai-global', parseInt(env.DAILY_AI_CAP) || 250, 86400);
}

/* ═════════════ HELPERS ═════════════ */

function originAllowed(origin) {
  if (!origin) return false;
  try {
    const h = new URL(origin).hostname;
    return ALLOWED_HOSTS.some(a => h === a || h.endsWith('.' + a));
  } catch { return false; }
}
function corsFor(origin) {
  return {
    'Access-Control-Allow-Origin': originAllowed(origin) ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function callClaude(env, body) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
}
function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
