import { generateWidget } from './generate.js';

// Tailored Tool — site analyzer + spec generator + widget builder
// Reads a visitor's website, then returns a full build spec via OpenAI structured outputs.

const ALLOWED_ORIGINS = [
  'https://tailoredtool.com',
  'https://www.tailoredtool.com',
  'https://tailoredtool.pages.dev'
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const ok = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.tailoredtool\.pages\.dev$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

// ---- Rate limiter: 5 scans per IP per hour ----
export class RateLimiter {
  constructor(state) { this.state = state; }
  async fetch() {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const LIMIT = 5;
    let hits = (await this.state.storage.get('hits')) || [];
    hits = hits.filter(t => now - t < HOUR);
    if (hits.length >= LIMIT) {
      return new Response(JSON.stringify({ allowed: false }), { headers: { 'Content-Type': 'application/json' } });
    }
    hits.push(now);
    await this.state.storage.put('hits', hits);
    return new Response(JSON.stringify({ allowed: true }), { headers: { 'Content-Type': 'application/json' } });
  }
}

// ---- Pull the client's real brand out of their CSS ----
function extractBrand(css, fontHrefs, themeColor) {
  const counts = new Map();
  const bump = (hex) => {
    const h = normalizeHex(hex);
    if (!h) return;
    // skip pure black, pure white and near-greys — they carry no brand signal
    const { r, g, b } = hexToRgb(h);
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    if (max - min < 18 && (max > 235 || max < 25)) return;
    counts.set(h, (counts.get(h) || 0) + 1);
  };

  for (const m of css.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) bump('#' + m[1]);
  for (const m of css.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/g)) {
    bump(rgbToHex(+m[1], +m[2], +m[3]));
  }
  if (themeColor) bump(themeColor);

  const colors = [...counts.entries()]
    .sort((a,b) => b[1] - a[1])
    .slice(0, 6)
    .map(e => e[0]);

  const fonts = new Set();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}"']+)/gi)) {
    const first = m[1].split(',')[0].replace(/['"]/g,'').trim();
    if (first && !/^(inherit|initial|unset|sans-serif|serif|monospace)$/i.test(first) && first.length < 40) {
      fonts.add(first);
    }
  }
  for (const href of fontHrefs) {
    for (const m of href.matchAll(/family=([^:&]+)/g)) {
      fonts.add(decodeURIComponent(m[1]).replace(/\+/g, ' '));
    }
  }

  return { colors, fonts: [...fonts].slice(0, 5) };
}

function normalizeHex(hex) {
  let h = hex.trim().toLowerCase();
  if (!h.startsWith('#')) h = '#' + h;
  if (h.length === 4) h = '#' + h[1]+h[1] + h[2]+h[2] + h[3]+h[3];
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}
function hexToRgb(h) {
  return { r: parseInt(h.slice(1,3),16), g: parseInt(h.slice(3,5),16), b: parseInt(h.slice(5,7),16) };
}
function rgbToHex(r,g,b) {
  const c = n => Math.max(0, Math.min(255, n)).toString(16).padStart(2,'0');
  return '#' + c(r) + c(g) + c(b);
}

// ---- Read a website with HTMLRewriter ----
async function readSite(url) {
  const collected = {
    title: '', description: '', headings: [], navLinks: [], bodyText: [], generator: '',
    styleText: [], inlineStyles: [], themeColor: '', fontHrefs: []
  };

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TailoredToolBot/1.0)' },
    redirect: 'follow',
    cf: { cacheTtl: 300 }
  });
  if (!res.ok) throw new Error('fetch failed: ' + res.status);

  const rewriter = new HTMLRewriter()
    .on('title', { text(t){ if(collected.title.length < 200) collected.title += t.text; } })
    .on('meta[name="description"]', { element(e){ collected.description = e.getAttribute('content') || ''; } })
    .on('meta[property="og:description"]', { element(e){ if(!collected.description) collected.description = e.getAttribute('content') || ''; } })
    .on('meta[name="generator"]', { element(e){ collected.generator = e.getAttribute('content') || ''; } })
    .on('h1, h2, h3', { text(t){ const v = t.text.trim(); if(v && collected.headings.length < 40) collected.headings.push(v); } })
    .on('nav a, header a', { text(t){ const v = t.text.trim(); if(v && v.length < 40 && collected.navLinks.length < 30) collected.navLinks.push(v); } })
    .on('p, li', { text(t){ const v = t.text.trim(); if(v.length > 25 && collected.bodyText.length < 60) collected.bodyText.push(v); } })
    .on('meta[name="theme-color"]', { element(e){ collected.themeColor = e.getAttribute('content') || ''; } })
    .on('style', { text(t){ if(collected.styleText.join('').length < 60000) collected.styleText.push(t.text); } })
    .on('link[rel="stylesheet"]', { element(e){ const h = e.getAttribute('href') || ''; if(/fonts\.googleapis|fonts\.bunny|typekit/.test(h)) collected.fontHrefs.push(h); } })
    .on('[style]', { element(e){ const v = e.getAttribute('style') || ''; if(collected.inlineStyles.length < 80) collected.inlineStyles.push(v); } });

  await rewriter.transform(res).text();

  const dedupe = a => [...new Set(a.map(s => s.replace(/\s+/g,' ').trim()))].filter(Boolean);

  const css = collected.styleText.join(' ') + ' ' + collected.inlineStyles.join(' ');
  const brand = extractBrand(css, collected.fontHrefs, collected.themeColor);

  return {
    title: collected.title.replace(/\s+/g,' ').trim(),
    description: collected.description.trim(),
    platform: collected.generator,
    headings: dedupe(collected.headings).slice(0, 25),
    navLinks: dedupe(collected.navLinks).slice(0, 20),
    bodyText: dedupe(collected.bodyText).slice(0, 30),
    brand
  };
}

// ---- Fallback: Cloudflare Browser Rendering for JS-heavy sites ----
async function readSiteRendered(url, env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) throw new Error('browser rendering not configured');
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
      body: JSON.stringify({ url })
    }
  );
  const data = await res.json();
  const html = data?.result;
  if (!html) throw new Error('render failed');

  const strip = s => s.replace(/<script[\s\S]*?<\/script>/gi,' ')
                      .replace(/<style[\s\S]*?<\/style>/gi,' ')
                      .replace(/<[^>]+>/g,' ')
                      .replace(/\s+/g,' ').trim();

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const headings = [...html.matchAll(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi)]
    .map(m => strip(m[1])).filter(Boolean).slice(0, 25);

  return {
    title: titleMatch ? strip(titleMatch[1]) : '',
    description: '',
    platform: '',
    headings,
    navLinks: [],
    bodyText: strip(html).slice(0, 4000).split('. ').slice(0, 30),
    brand: extractBrand(html, [], '')
  };
}

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['business_summary','tool_name','tagline','what_it_does','where_it_goes','problem_solved','impact','features','tier','price','build_days'],
  properties: {
    business_summary: { type:'string', description:"One sentence proving we read their site: what the business actually does, referencing something specific from their pages." },
    tool_name: { type:'string', description:'Short punchy plain-English name for the tool, 2-4 words.' },
    tagline: { type:'string', description:'One line, under 12 words, describing the tool.' },
    what_it_does: { type:'string', description:'2-3 sentences in plain language. No jargon.' },
    where_it_goes: { type:'string', description:'Exactly where on their site it would live, referencing their real pages.' },
    problem_solved: { type:'string', description:'The specific problem it kills, in one or two sentences.' },
    impact: { type:'string', description:'One concrete, honest sentence about the likely benefit. Avoid fake precise statistics.' },
    features: { type:'array', items:{ type:'string' }, description:'4-5 short bullet features, under 10 words each.' },
    tier: { type:'string', enum:['Simple','Standard','Advanced'] },
    price: { type:'integer', description:'950 for Simple, 1500 for Standard, 2800 for Advanced.' },
    build_days: { type:'integer', description:'Realistic build time in business days: 5 for Simple, 10 for Standard, 18 for Advanced.' }
  }
};

const SYSTEM_PROMPT = `You are the spec engine for Tailored Tool, which builds one custom AI tool per client for a one-time fee.
You are given real content scraped from a prospect's website. Design THE ONE best AI tool to add to their site.

Rules:
- Prove you read their actual site. Reference their real services, products, or page names.
- Plain language a non-technical business owner instantly understands. No jargon, no buzzwords.
- Choose the tier honestly: Simple ($950) = one focused job like FAQ answering, product finding, or lead capture. Standard ($1500) = tool plus booking/forms plus brand-voice training. Advanced ($2800) = multi-step workflows or integrations with calendars, CRM, or Shopify.
- Be honest in "impact" — describe the benefit plainly. Never invent precise statistics or dollar figures.
- Everything must be specific to this business. Generic output is a failure.`;

export default {
  async fetch(request, env) {
    const CORS = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

    const json = (obj, status=200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type':'application/json' } });

    // rate limit
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
    const check = await (await limiter.fetch('https://limiter/check')).json();
    if (!check.allowed) {
      return json({ error: "You've hit the scan limit for now. Get in touch and we'll build your spec by hand." }, 429);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error:'Bad request' }, 400); }

    // ---- BUILD route: turn an approved spec into a real widget ----
    if (body.action === 'generate') {
      if (!body.spec || !body.spec.tool_name) return json({ error:'Missing spec.' }, 400);
      if (!env.BUILD_TOKEN || body.token !== env.BUILD_TOKEN) {
        return json({ error:'Builds are unlocked after your deposit is confirmed.' }, 403);
      }
      try {
        const site = body.site || { title:'', description:'', headings:[], navLinks:[], bodyText:[], platform:'' };
        const brand = body.brand || site.brand || { colors:[], fonts:[] };
        const built = await generateWidget(env, { brand, site, spec: body.spec });
        return json({ plan: built.plan, code: built.code });
      } catch (e) {
        return json({ error:'The build failed. Try again in a moment.' }, 500);
      }
    }

    let siteUrl = String(body.url || '').trim();
    const fallbackDescription = String(body.business || '').trim().slice(0, 300);

    let siteData = null;

    if (siteUrl) {
      if (!/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;
      let parsed;
      try { parsed = new URL(siteUrl); } catch { return json({ error:'That doesn\'t look like a valid website address.' }, 400); }
      // block internal addresses
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(parsed.hostname)) {
        return json({ error:'That address can\'t be scanned.' }, 400);
      }

      try {
        siteData = await readSite(parsed.href);
        const thin = (siteData.headings.length + siteData.bodyText.length) < 4;
        if (thin) {
          try { siteData = await readSiteRendered(parsed.href, env); } catch (_) {}
        }
      } catch (e) {
        try { siteData = await readSiteRendered(parsed.href, env); }
        catch (_) {
          return json({ error: "We couldn't read that site — it may be blocking us. Try another page, or describe your business instead.", needsFallback: true }, 422);
        }
      }
    }

    if (!siteData && !fallbackDescription) {
      return json({ error:'Enter your website address to get started.' }, 400);
    }

    const userContent = siteData
      ? `Website: ${siteUrl}
Page title: ${siteData.title}
Meta description: ${siteData.description}
Platform: ${siteData.platform || 'unknown'}
Navigation: ${siteData.navLinks.join(' | ')}
Headings: ${siteData.headings.join(' | ')}
Page content: ${siteData.bodyText.join(' ').slice(0, 3500)}`
      : `The prospect did not provide a website. They described their business as: "${fallbackDescription}". Base the spec on that description and note in business_summary that this is based on their description.`;

    try {
      const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          temperature: 0.7,
          max_tokens: 900,
          messages: [
            { role:'system', content: SYSTEM_PROMPT },
            { role:'user', content: userContent }
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name:'tool_spec', strict:true, schema: SPEC_SCHEMA }
          }
        })
      });

      const data = await apiRes.json();
      const raw = data?.choices?.[0]?.message?.content;
      if (!raw) return json({ error:'Something went wrong generating your spec. Try again in a moment.' }, 500);

      const spec = JSON.parse(raw);
      spec.deposit = 250;
      spec.source_url = siteUrl || null;
      return json({ spec, site: siteData || null, brand: siteData ? siteData.brand : null });

    } catch (e) {
      return json({ error:'Something went wrong. Try again in a moment.' }, 500);
    }
  }
};
