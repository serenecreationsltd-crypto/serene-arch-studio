/**
 * SERENE CREATIONS — Blog Worker
 * Deploy this to your serene-growth Cloudflare Worker
 * Route: serenecreations.org/blog*
 *
 * Add to existing worker or create a new route in Workers dashboard:
 *   Route: serenecreations.org/blog*  →  this worker
 */

const FIREBASE_URL = 'https://serene-creations-default-rtdb.firebaseio.com';
const SITE_NAME    = 'Serene Creations Ltd';
const SITE_URL     = 'https://serenecreations.org';
const BRAND_COLOR  = '#0d2137';
const LOGO_INITIALS = 'SC';

export default {
  async fetch(request) {
    const url  = new URL(request.url);
    const path = url.pathname; // e.g. /blog or /blog/cost-of-building-in-uganda-2026

    const slug = path.replace(/^\/blog\/?/, '').replace(/\/$/, '');

    if (!slug) {
      // Blog index — list all published posts
      return await serveBlogIndex();
    } else {
      // Single post
      return await serveBlogPost(slug);
    }
  }
};

async function fetchPost(slug) {
  const res  = await fetch(`${FIREBASE_URL}/blog/${slug}.json`);
  const post = await res.json();
  return post && post.status === 'Published' ? post : null;
}

async function fetchAllPosts() {
  const res  = await fetch(`${FIREBASE_URL}/blog.json`);
  const data = await res.json();
  if (!data) return [];
  return Object.values(data)
    .filter(p => p.status === 'Published')
    .sort((a, b) => new Date(b.publishedDate) - new Date(a.publishedDate));
}

function catColor(cat) {
  return {Construction:'#f59e0b',Engineering:'#3b82f6','Real Estate':'#22c55e'}[cat] || '#8b5cf6';
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString('en-UG',{day:'numeric',month:'long',year:'numeric'}); } catch(e){return d||'';}
}

function shell(title, desc, canonical, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | ${SITE_NAME}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-WQC4VL5FPD"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-WQC4VL5FPD');</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#f8f9fa;color:#1f2937;line-height:1.6}
a{color:#0d2137}
.nav{background:#0d2137;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.nav-logo{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none}
.nav-badge{width:36px;height:36px;background:#1e6bb1;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#fff}
.nav-name{font-size:14px;font-weight:600;color:#fff}
.nav-links{display:flex;gap:16px}
.nav-links a{color:#94b8d0;font-size:13px;text-decoration:none}
.nav-links a:hover{color:#fff}
.wrap{max-width:780px;margin:0 auto;padding:32px 20px 60px}
.breadcrumb{font-size:12px;color:#9ca3af;margin-bottom:20px}
.breadcrumb a{color:#9ca3af}
.article-header{margin-bottom:28px}
.cat-badge{display:inline-flex;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:12px;color:#fff}
h1{font-size:28px;font-weight:700;color:#0d2137;line-height:1.3;margin-bottom:10px}
.article-meta{font-size:13px;color:#6b7280;margin-bottom:24px}
.article-body h2{font-size:20px;font-weight:700;color:#0d2137;margin:28px 0 10px}
.article-body h3{font-size:16px;font-weight:600;color:#374151;margin:20px 0 8px}
.article-body p{margin-bottom:14px;color:#374151}
.article-body ul,.article-body ol{margin:0 0 14px 24px;color:#374151}
.article-body li{margin-bottom:6px}
.article-body strong{color:#1f2937}
.cta-box{background:#0d2137;border-radius:12px;padding:28px;text-align:center;margin-top:40px}
.cta-box h3{color:#fff;font-size:18px;margin-bottom:8px}
.cta-box p{color:#94b8d0;font-size:14px;margin-bottom:16px}
.cta-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.cta-btn{padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none}
.cta-primary{background:#1e6bb1;color:#fff}
.cta-wa{background:#25d366;color:#fff}
.back-link{display:inline-flex;align-items:center;gap:5px;color:#0d2137;font-size:14px;text-decoration:none;margin-bottom:20px}
.footer{background:#0d2137;padding:20px;text-align:center;font-size:12px;color:#94b8d0;margin-top:40px}
@media(max-width:600px){h1{font-size:22px}.wrap{padding:20px 16px 40px}}
</style>
</head>
<body>
<nav class="nav">
  <a class="nav-logo" href="${SITE_URL}">
    <div class="nav-badge">${LOGO_INITIALS}</div>
    <span class="nav-name">${SITE_NAME}</span>
  </a>
  <div class="nav-links">
    <a href="${SITE_URL}/blog">Blog</a>
    <a href="${SITE_URL}">Home</a>
    <a href="${SITE_URL}#contact">Contact</a>
  </div>
</nav>
${body}
<footer class="footer">
  &copy; ${new Date().getFullYear()} ${SITE_NAME} &middot; Mukono, Uganda &middot; info@serenecreations.org &middot; +256 783 691337
</footer>
</body>
</html>`;
}

async function serveBlogIndex() {
  const posts = await fetchAllPosts();
  const cards = posts.length
    ? posts.map(p => `
      <a href="${SITE_URL}/blog/${p.slug}" style="text-decoration:none">
        <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.07);margin-bottom:20px;display:flex;gap:0">
          <div style="width:6px;background:${catColor(p.category)};flex-shrink:0;border-radius:12px 0 0 12px"></div>
          <div style="padding:18px;flex:1">
            <span style="font-size:11px;font-weight:600;color:${catColor(p.category)};text-transform:uppercase;letter-spacing:.5px">${p.category}</span>
            <h2 style="font-size:17px;font-weight:700;color:#0d2137;margin:4px 0 6px;line-height:1.3">${p.title}</h2>
            <p style="font-size:13px;color:#6b7280;margin-bottom:10px;line-height:1.5">${p.excerpt||''}</p>
            <span style="font-size:12px;color:#9ca3af">${fmtDate(p.publishedDate)} &middot; ${p.readMinutes||5} min read</span>
          </div>
        </div>
      </a>`).join('')
    : '<p style="color:#9ca3af;text-align:center;padding:40px">No articles yet. Check back soon.</p>';

  const body = `<div class="wrap">
    <h1 style="margin-bottom:6px">Engineering &amp; Real Estate Insights</h1>
    <p style="color:#6b7280;margin-bottom:28px">Practical guides from Uganda's construction and property professionals</p>
    ${cards}
  </div>`;

  const html = shell('Blog — Engineering & Real Estate Guides', 'Practical guides on construction costs, BOQs, and real estate in Uganda from Serene Creations Ltd.', `${SITE_URL}/blog`, body);
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=3600' }});
}

async function serveBlogPost(slug) {
  const post = await fetchPost(slug);

  if (!post) {
    return new Response('Article not found', { status: 404 });
  }

  const body = `<div class="wrap">
    <a class="back-link" href="${SITE_URL}/blog">&#8592; All articles</a>
    <div class="breadcrumb"><a href="${SITE_URL}">Home</a> &rsaquo; <a href="${SITE_URL}/blog">Blog</a> &rsaquo; ${post.title}</div>
    <div class="article-header">
      <span class="cat-badge" style="background:${catColor(post.category)}">${post.category}</span>
      <h1>${post.title}</h1>
      <div class="article-meta">By ${post.author||SITE_NAME} &middot; ${fmtDate(post.publishedDate)} &middot; ${post.readMinutes||5} min read</div>
    </div>
    <div class="article-body">${post.content||''}</div>
    <div class="cta-box">
      <h3>Need professional engineering or real estate services in Uganda?</h3>
      <p>Serene Creations Ltd offers structural engineering, architectural design, BOQ preparation, and property sales across Uganda.</p>
      <div class="cta-btns">
        <a class="cta-btn cta-primary" href="${SITE_URL}#contact">Get in Touch</a>
        <a class="cta-btn cta-wa" href="https://wa.me/256783691337">&#128172; WhatsApp Us</a>
      </div>
    </div>
  </div>`;

  const html = shell(post.title, post.seoDescription||post.excerpt||'', `${SITE_URL}/blog/${slug}`, body);
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=3600' }});
}