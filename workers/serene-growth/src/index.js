/* ============================================================
   SERENE CREATIONS — GROWTH BACKEND (Cloudflare Worker #2)
   Deploy as a SECOND worker named: serene-growth
   Powers: newsletter capture, building-cost calculator leads,
   bid/quote requests, AI website assistant, automated AI blog.

   SECRETS (Settings > Variables and Secrets):
     RESEND_API_KEY      same key as the payments worker
     ANTHROPIC_API_KEY   from console.anthropic.com (for AI assistant + auto-blog)
     ADMIN_KEY           any long random password you invent (protects /blog/generate)

   VARIABLES (Text):
     OWNER_EMAIL    = "info@serenecreations.org"
     FROM_EMAIL     = "Serene Creations <no-reply@serenecreations.org>"
     ALLOWED_ORIGIN = "https://serenecreations.org"
     SITE_NAME      = "Serene Creations Ltd"

   KV NAMESPACE (Storage & Databases > KV > Create namespace "SERENE_KV",
   then Worker > Settings > Bindings > Add > KV Namespace, variable name: KV)

   CRON (Worker > Settings > Triggers > Cron: 0 6 * * 1  = every Monday 6am)
   -> auto-generates and publishes a new blog post weekly.

   ENDPOINTS
     POST /subscribe        newsletter/lead-magnet signup
     POST /calc-lead        building calculator result + lead capture
     POST /bids             detailed bid/quote request (also used by site-visit bookings)
     POST /ai               AI assistant chat (Claude)
     GET  /blog/posts       list published posts (JSON, used by blog snippet)
     GET  /blog/generate?key=ADMIN_KEY   manually generate a post now
     GET  /listings         public property/land listings (JSON)
     POST /listings/add     publish a listing (admin key required)
     POST /listings/update  mark sold / change price / delete (admin key)
     GET  /adverts          current site-wide promo banner (JSON)
     POST /adverts/update   set/replace/disable the banner (admin key)
============================================================ */

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
const json = (d, env, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", ...cors(env) } });
const esc = (x = "") =>
  String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtUGX = (n) => "UGX " + Number(n || 0).toLocaleString("en-UG");

async function sendEmail(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) console.log("Resend error:", await r.text());
  return r.ok;
}

async function askClaude(env, system, userText, maxTokens = 1024) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const d = await r.json();
  if (!d.content) throw new Error(d.error?.message || "AI request failed");
  return d.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/* ------------------- automated blog generation ------------------- */

const BLOG_TOPICS = [
  "Cost of building a 3-bedroom house in Uganda: a realistic breakdown",
  "How to verify a land title in Uganda before buying (Mailo, NLIS, and due diligence)",
  "Ring beams, columns and foundations: structural basics every home builder in Uganda should know",
  "Buying land in Mukono and Wakiso: what drives plot prices in 2026",
  "How to choose between solid and hollow concrete blocks for your build",
  "The land subdivision investment model: turning one acre into eight plots",
  "Why every construction project needs a Bill of Quantities (BOQ)",
  "Hiring a structural engineer vs a fundi: what it costs and what it saves",
  "Rainwater, drainage and site levels: protecting your building from Uganda's wet seasons",
  "From sketch to approval: the building plan approval process in Ugandan municipalities",
];

async function generateBlogPost(env) {
  const listRaw = (await env.KV.get("blog:index")) || "[]";
  const index = JSON.parse(listRaw);
  const used = new Set(index.map((p) => p.topic));
  const topic = BLOG_TOPICS.find((t) => !used.has(t)) || BLOG_TOPICS[index.length % BLOG_TOPICS.length];

  const article = await askClaude(
    env,
    `You are the content writer for ${env.SITE_NAME}, a licensed civil & structural engineering consultancy and real-estate firm in Mukono, Uganda. Write practical, trustworthy articles for Ugandan homeowners, diaspora investors and developers. Use UGX figures where helpful, Ugandan context (Mailo land, local materials, municipal approvals). Return STRICT JSON only, no markdown fences: {"title": "...", "excerpt": "2-sentence summary", "html": "<p>...</p> article body of 600-900 words using only <p>, <h3>, <ul>, <li>, <strong> tags"}`,
    `Write the article on: ${topic}. End the body with one paragraph inviting readers to contact ${env.SITE_NAME} via the website for a professional consultation.`,
    3000,
  );

  const clean = article.replace(/```json|```/g, "").trim();
  const post = JSON.parse(clean);
  const id = "post-" + Date.now();
  const record = {
    id,
    topic,
    title: post.title,
    excerpt: post.excerpt,
    date: new Date().toISOString().slice(0, 10),
  };

  await env.KV.put("blog:" + id, JSON.stringify({ ...record, html: post.html }));
  index.unshift(record);
  await env.KV.put("blog:index", JSON.stringify(index.slice(0, 50)));

  await sendEmail(env, {
    to: env.OWNER_EMAIL,
    subject: `📝 New blog post auto-published: ${post.title}`,
    html: `<p>A new article was generated and published on serenecreations.org:</p>
           <p><b>${esc(post.title)}</b><br>${esc(post.excerpt)}</p>`,
  });
  return record;
}

/* =========================== router =========================== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    try {
      /* ---------- newsletter / lead magnet ---------- */
      if (path === "/subscribe" && request.method === "POST") {
        const { email = "", name = "", interest = "" } = await request.json();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
          return json({ ok: false, error: "Valid email required" }, env, 400);

        await env.KV.put("sub:" + email.toLowerCase(), JSON.stringify({ name, interest, date: new Date().toISOString() }));

        await sendEmail(env, {
          to: env.OWNER_EMAIL, replyTo: email,
          subject: `📬 New subscriber: ${email}`,
          html: `<p><b>${esc(name || email)}</b> subscribed.<br>Interest: ${esc(interest || "-")}</p>`,
        });
        await sendEmail(env, {
          to: email, replyTo: env.OWNER_EMAIL,
          subject: `Welcome — ${env.SITE_NAME}`,
          html: `<p>Dear ${esc(name.split(" ")[0] || "friend")},</p>
            <p>Thank you for subscribing to <b>${esc(env.SITE_NAME)}</b>. You will receive practical
            insights on building, land investment and engineering in Uganda.</p>
            <p>Kind regards,<br>${esc(env.SITE_NAME)}<br>info@serenecreations.org</p>`,
        });
        return json({ ok: true }, env);
      }

      /* ---------- building cost calculator lead ---------- */
      if (path === "/calc-lead" && request.method === "POST") {
        const b = await request.json();
        const { name = "", email = "", phone = "", area, floors = 1, quality = "standard", location = "" } = b;
        if (!email || !area) return json({ ok: false, error: "email and area required" }, env, 400);

        const RATES = { basic: 950000, standard: 1350000, premium: 2100000 }; // UGX per m² (indicative 2026)
        const rate = RATES[quality] || RATES.standard;
        const total = Math.round(Number(area) * Number(floors) * rate);
        const low = Math.round(total * 0.9), high = Math.round(total * 1.15);

        const breakdown = [
          ["Substructure (foundation, ring beam)", 0.16], ["Walling & blockwork", 0.14],
          ["Roofing", 0.15], ["Doors & windows", 0.09], ["Finishes (plaster, paint, floors)", 0.2],
          ["Electrical & plumbing", 0.12], ["Preliminaries & labour", 0.14],
        ].map(([k, f]) => `<tr><td style="padding:4px 16px 4px 0;color:#555;">${k}</td><td><b>${fmtUGX(Math.round(total * f))}</b></td></tr>`).join("");

        await sendEmail(env, {
          to: email, replyTo: env.OWNER_EMAIL,
          subject: `Your building cost estimate — ${env.SITE_NAME}`,
          html: `<div style="font-family:system-ui,sans-serif;color:#222;">
            <h2>Indicative Building Cost Estimate</h2>
            <p>${esc(Number(area))} m² × ${esc(floors)} floor(s), ${esc(quality)} finish${location ? ", " + esc(location) : ""}:</p>
            <p style="font-size:20px;"><b>${fmtUGX(low)} – ${fmtUGX(high)}</b></p>
            <table style="border-collapse:collapse;">${breakdown}</table>
            <p style="color:#777;font-size:13px;">Indicative estimate based on 2026 market rates; final costs depend on
            design, site conditions and specifications. For a professional Bill of Quantities, reply to this email.</p>
            <p>${esc(env.SITE_NAME)} · info@serenecreations.org</p></div>`,
        });
        await sendEmail(env, {
          to: env.OWNER_EMAIL, replyTo: email,
          subject: `🏗️ Calculator lead: ${name || email} — ${fmtUGX(total)}`,
          html: `<p><b>New calculator lead</b><br>Name: ${esc(name)}<br>Email: ${esc(email)}<br>Phone: ${esc(phone)}<br>
            Area: ${esc(area)} m² × ${esc(floors)} floors, ${esc(quality)}<br>Location: ${esc(location || "-")}<br>
            Estimate: <b>${fmtUGX(low)} – ${fmtUGX(high)}</b></p><p>Follow up within 24h for best conversion.</p>`,
        });
        return json({ ok: true, low, high, total }, env);
      }

      /* ---------- bid / quote request ---------- */
      if (path === "/bids" && request.method === "POST") {
        const b = await request.json();
        const { name = "", email = "", phone = "", projectType = "", location = "", budget = "", timeline = "", details = "" } = b;
        if (!name || !email || !details)
          return json({ ok: false, error: "name, email and project details required" }, env, 400);

        const ref = "BID-" + Date.now().toString().slice(-6);
        await sendEmail(env, {
          to: env.OWNER_EMAIL, replyTo: email,
          subject: `📐 Bid request ${ref}: ${projectType || "project"} — ${name}`,
          html: `<h2>New bid/quote request ${ref}</h2>
            <table style="border-collapse:collapse;">
            <tr><td style="padding:4px 16px 4px 0;color:#666;">Name</td><td><b>${esc(name)}</b></td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#666;">Email</td><td>${esc(email)}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#666;">Phone</td><td>${esc(phone)}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#666;">Project</td><td>${esc(projectType)}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#666;">Location</td><td>${esc(location)}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#666;">Budget</td><td>${esc(budget)}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#666;">Timeline</td><td>${esc(timeline)}</td></tr></table>
            <p><b>Details:</b><br>${esc(details).replace(/\n/g, "<br>")}</p>`,
        });
        await sendEmail(env, {
          to: email, replyTo: env.OWNER_EMAIL,
          subject: `We received your project brief (${ref}) — ${env.SITE_NAME}`,
          html: `<p>Dear ${esc(name.split(" ")[0])},</p>
            <p>Thank you for requesting a quotation from <b>${esc(env.SITE_NAME)}</b>. Your reference is <b>${ref}</b>.
            Our engineering team will review your brief and respond with a proposal or clarifying questions
            within 1–2 business days.</p>
            <p>Kind regards,<br>${esc(env.SITE_NAME)}<br>info@serenecreations.org</p>`,
        });
        return json({ ok: true, ref }, env);
      }

      /* ---------- AI website assistant ---------- */
      if (path === "/ai" && request.method === "POST") {
        const { message = "", history = [] } = await request.json();
        if (!message || message.length > 2000) return json({ error: "Invalid message" }, env, 400);
        if (!env.ANTHROPIC_API_KEY) return json({ error: "AI not configured" }, env, 500);

        const convo = history.slice(-6).map((h) => `${h.role === "user" ? "Visitor" : "Assistant"}: ${h.text}`).join("\n");
        const reply = await askClaude(
          env,
          `You are the helpful assistant on serenecreations.org, website of ${env.SITE_NAME} — a civil & structural engineering consultancy and real-estate company in Mukono, Uganda. Services: structural design, building supervision, BOQs, project management, land sales & subdivision investment, concrete products. You answer questions about services, building in Uganda, and land buying. Be concise (under 120 words), warm and professional. For pricing, quotes or site visits, invite them to use the Request a Quote form or email info@serenecreations.org. Never invent specific prices or commitments.`,
          (convo ? convo + "\n" : "") + "Visitor: " + message,
          400,
        );
        return json({ reply }, env);
      }

      /* ---------- blog ---------- */
      if (path === "/blog/posts" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (id) {
          const post = await env.KV.get("blog:" + id);
          return post ? new Response(post, { headers: { "Content-Type": "application/json", ...cors(env) } })
                      : json({ error: "Not found" }, env, 404);
        }
        const index = (await env.KV.get("blog:index")) || "[]";
        return new Response(index, { headers: { "Content-Type": "application/json", ...cors(env) } });
      }

      if (path === "/blog/generate") {
        if (url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, env, 401);
        const rec = await generateBlogPost(env);
        return json({ ok: true, published: rec }, env);
      }

      /* ---------- property listings (real estate) ---------- */
      if (path === "/listings" && request.method === "GET") {
        const raw = (await env.KV.get("listings:index")) || "[]";
        return new Response(raw, { headers: { "Content-Type": "application/json", ...cors(env) } });
      }

      if (path === "/listings/add" && request.method === "POST") {
        const b = await request.json();
        if (b.key !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, env, 401);
        const listing = {
          id: "L-" + Date.now(),
          title: String(b.title || "").slice(0, 120),
          location: String(b.location || "").slice(0, 80),
          size: String(b.size || "").slice(0, 60),           // e.g. "50x100 ft" or "1 acre"
          tenure: String(b.tenure || "").slice(0, 60),        // e.g. "Private Mailo, title ready"
          price: Number(b.price || 0),                        // UGX
          status: b.status === "sold" ? "sold" : "available",
          description: String(b.description || "").slice(0, 1000),
          image: String(b.image || "").slice(0, 500),         // image URL (optional)
          date: new Date().toISOString().slice(0, 10),
        };
        const index = JSON.parse((await env.KV.get("listings:index")) || "[]");
        index.unshift(listing);
        await env.KV.put("listings:index", JSON.stringify(index.slice(0, 100)));
        return json({ ok: true, listing }, env);
      }

      if (path === "/listings/update" && request.method === "POST") {
        const b = await request.json();
        if (b.key !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, env, 401);
        let index = JSON.parse((await env.KV.get("listings:index")) || "[]");
        if (b.action === "delete") index = index.filter((l) => l.id !== b.id);
        else index = index.map((l) => (l.id === b.id ? { ...l, status: b.status || l.status, price: b.price ?? l.price } : l));
        await env.KV.put("listings:index", JSON.stringify(index));
        return json({ ok: true, count: index.length }, env);
      }

      /* ---------- adverts / promo banner (site-wide, admin-managed) ---------- */
      if (path === "/adverts" && request.method === "GET") {
        const raw = (await env.KV.get("adverts:current")) || JSON.stringify({ active: false });
        return new Response(raw, { headers: { "Content-Type": "application/json", ...cors(env) } });
      }

      if (path === "/adverts/update" && request.method === "POST") {
        const b = await request.json();
        if (b.key !== env.ADMIN_KEY) return json({ error: "Unauthorized" }, env, 401);
        const advert = {
          active: !!b.active,
          text: String(b.text || "").slice(0, 200),        // e.g. "🔥 Promo: 2 plots left in Nsambwe at UGX 25M — ends Friday"
          link: String(b.link || "").slice(0, 300),        // where the banner points (e.g. #listings)
          linkLabel: String(b.linkLabel || "View").slice(0, 40),
          updated: new Date().toISOString(),
        };
        await env.KV.put("adverts:current", JSON.stringify(advert));
        return json({ ok: true, advert }, env);
      }

      if (path === "/" || path === "/health")
        return json({ ok: true, service: "serene-growth" }, env);

      return json({ error: "Not found" }, env, 404);
    } catch (err) {
      console.log("Growth worker error:", err.stack || err.message);
      return json({ error: err.message }, env, 500);
    }
  },

  /* weekly cron: auto-publish a new article */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateBlogPost(env).catch((e) => console.log("Auto-blog failed:", e.message)));
  },
};// ============================================================
// Mailchimp Integration Route for Serene Creations
// Endpoint: POST /mailchimp
// ============================================================

// 🔒 SET YOUR SECRETS HERE (stored server-side, never exposed to the browser)
const MAILCHIMP_API_KEY = 'YOUR_MAILCHIMP_API_KEY'    // e.g. "abc123...-us21"
const MAILCHIMP_LIST_ID = 'YOUR_AUDIENCE_OR_LIST_ID'  // e.g. "a1b2c3d4e5"

// Extract datacenter from the API key (e.g. "us21" from "...-us21")
const DATACENTER = MAILCHIMP_API_KEY.split('-')[1]

// ============================================================
// Main route handler — call this from your existing fetch handler
// ============================================================
async function handleMailchimp(request) {
  // Only allow POST
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // CORS headers (so the browser can call this endpoint from your site)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const body = await request.json()
    const email = body.email_address
    const mergeFields = body.merge_fields || {}

    if (!email || !email.includes('@')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid email address' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      )
    }

    // Build the Mailchimp payload
    const payload = {
      email_address: email,
      status: 'subscribed',
      merge_fields: {
        FNAME: mergeFields.FNAME || '',
        LNAME: mergeFields.LNAME || '',
        PHONE: mergeFields.PHONE || '',
      },
      tags: body.tags || [],
    }

    // Add/update member via Mailchimp API (no MD5 required)
    const url = `https://${DATACENTER}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa('anystring:' + MAILCHIMP_API_KEY)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...payload,
        status: 'subscribed',
        status_if_new: 'subscribed',
      }),
    })

    const data = await res.json()

    if (res.ok) {
      return new Response(
        JSON.stringify({ success: true, id: data.id, status: data.status }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      )
    }

    // Mailchimp may return "Member Exists" (400) — that's fine, they're already on the list
    if (data.title === 'Member Exists') {
      return new Response(
        JSON.stringify({ success: true, status: 'existing' }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      )
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: data.title || 'Mailchimp error',
        detail: data.detail || '',
      }),
      { status: res.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    )
  }
}