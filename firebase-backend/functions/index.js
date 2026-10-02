"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG  —  via environment variables (functions.config() is decommissioned).
//
// Locally / in CI, write firebase-backend/functions/.env (gitignored) with:
//   REPLICATE_TOKEN=r8_YOUR_TOKEN
//   REPLICATE_MODEL_VERSION=THE_VERSION_HASH
//   SMTP_PASSWORD=your_zoho_password
//   STRIPE_SECRET=sk_live_...
//   STRIPE_WEBHOOK_SECRET=whsec_...
// Firebase loads this .env automatically on `firebase deploy` and exposes each
// key as process.env.<KEY> at runtime. In CI, the deploy workflow generates
// this .env from GitHub repo secrets of the same names.
// ═══════════════════════════════════════════════════════════════════════════
// ── AI render engine (Replicate) ───────────────────────────────────────────
// The render pipeline expects a ControlNet / img2img model whose input schema
// accepts: image, prompt, negative_prompt, controlnet_conditioning_scale,
// strength, num_inference_steps, guidance_scale (see processRenderJob below).
//
// Recommended model for sketch/floor-plan → photoreal architecture:
//   • batouresearch/sdxl-controlnet-lora   (SDXL, strong on buildings)
//   • jagilley/controlnet-hough            (MLSD line-guided, great for plans)
// Open the chosen model on replicate.com, copy its current "Version" hash, and
// set REPLICATE_TOKEN + REPLICATE_MODEL_VERSION (see CONFIG block above).
// Until both are set, renders return a friendly "engine not configured" message.
const REPLICATE_TOKEN         = process.env.REPLICATE_TOKEN || "";
const REPLICATE_MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION ||
                                "TODO_REPLACE_WITH_REPLICATE_VERSION_HASH";

// Stripe — subscription tier management
const STRIPE_SECRET         = process.env.STRIPE_SECRET         || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET, { apiVersion: "2023-10-16" }) : null;

// Tier name mapping from Stripe price IDs / metadata
const STRIPE_TIER_MAP = {
  pro:        "pro",
  enterprise: "enterprise",
  free:       "free",
};

// Activepieces automation webhooks
const WELCOME_HOOK = "https://cloud.activepieces.com/api/v1/webhooks/DdrUpk3GiVuV4iHXuotOj";
const LEAD_HOOK    = "https://cloud.activepieces.com/api/v1/webhooks/gaqpTTBjcrwCpNPukckrm";

// Subscription tier limits (renders / day)
const TIER_LIMITS = { free: 3, pro: 20, enterprise: 100 };

// Replicate polling
const POLL_ATTEMPTS    = 24;   // 24 × 5 s = 2 min max
const POLL_INTERVAL_MS = 5000;

// SMTP — Zoho
const SMTP_HOST  = "smtp.zoho.com";
const SMTP_PORT  = 465;
const SMTP_USER  = "info@serenecreations.org";
const FROM_EMAIL = "Serene Arch Studio <info@serenecreations.org>";
const REPLY_TO   = "info@serenecreations.org";

// Email signature — injected into every customer-facing outbound email
const EMAIL_SIGNATURE = `
  <div style="border-top:1px solid #e0e0e0;margin:24px 0 0;padding-top:16px;color:#555;font-size:13px;line-height:1.7">
    <p style="margin:0 0 2px"><strong>Warm regards,</strong></p>
    <p style="margin:0 0 2px"><strong>Bwambale Godfrey Lubangula</strong></p>
    <p style="margin:0 0 2px">Director, Serene Creations Ltd</p>
    <p style="margin:0 0 2px;font-size:12px;color:#777">BSc (Hons) Civil &amp; Environmental Engineering (Uganda Christian University, 2015); PGDip Project Management (UMI, 2018) | UIPE GM/3664</p>
    <p style="margin:0">📞 +256 783 691337</p>
  </div>`;

/** Build a configured Zoho SMTP transporter. */
function getMailer() {
  const pass = process.env.SMTP_PASSWORD || "";
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true, // SSL on port 465
    auth: { user: SMTP_USER, pass },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER STYLE / ENVIRONMENT PROMPTS
// ═══════════════════════════════════════════════════════════════════════════
// Render STYLE — sets the medium/character. Keys MUST match the front-end
// <option value="…"> values in public/ai-studio.html (#renderStyle).
const STYLE_PROMPTS = {
  photorealistic:
    "photorealistic exterior architectural rendering, professional CGI visualization, " +
    "hyperrealistic physically-based materials, award-winning architecture, " +
    "architectural photography, ultra-detailed",
  illustration:
    "architectural illustration, hand-drawn concept-art rendering, clean confident linework, " +
    "subtle color washes, elegant presentation-board aesthetic, editorial quality",
  watercolor:
    "architectural watercolor painting, soft translucent washes, loose expressive brushwork, " +
    "visible paper texture, muted artistic palette, hand-painted concept sketch",
  technical:
    "technical architectural line drawing, precise ink linework, orthographic clarity, " +
    "construction-document style, clean hatching, crisp monochrome presentation",
  "night-scene":
    "dramatic night-time architectural rendering, glowing warm interior lighting, " +
    "illuminated facade, reflective wet surfaces, cinematic contrast, professional CGI visualization",
  aerial:
    "aerial bird's-eye architectural rendering, elevated drone perspective, full site context, " +
    "surrounding landscape, roads and greenery, professional CGI visualization, ultra-detailed",
};

// Lighting / ENVIRONMENT — keys match #renderEnv <option value="…">.
const ENV_PROMPTS = {
  "golden-hour":
    "golden hour warm lighting, amber and orange tones, long dramatic shadows, sunset glow",
  overcast:
    "soft overcast sky, even diffused lighting, muted palette, no harsh shadows, calm mood",
  day:
    "bright clear midday sunlight, deep blue sky, crisp well-defined shadows, vibrant colors",
  night:
    "night exterior, warm architectural lighting, softly glowing windows, " +
    "ambient city light, dramatic contrast",
  interior:
    "interior studio setting, controlled soft studio lighting, clean neutral backdrop, product-shot clarity",
  tropical:
    "lush tropical landscape setting, palm trees and greenery, warm equatorial sunlight, vivid natural colors",
};

// MATERIAL palette — keys match #renderMaterial <option value="…">.
const MATERIAL_PROMPTS = {
  "concrete-glass":
    "exposed board-formed concrete and floor-to-ceiling glass with steel detailing",
  "brick-timber":
    "warm clay brickwork and natural timber cladding, richly textured masonry",
  "steel-curtain":
    "structural steel frame with full glass curtain-wall facade, high-tech detailing",
  african:
    "contemporary African materiality, rammed-earth and laterite walls, " +
    "carved timber screens, warm earth tones",
  "minimalist-white":
    "minimalist pure white rendered walls, smooth plaster, clean unadorned surfaces",
};

// Styles that read as artistic media rather than photoreal CGI — these get a
// lighter negative prompt so the painterly / line-drawing look is not penalised.
const ARTISTIC_STYLES = new Set(["illustration", "watercolor", "technical"]);

// img2img denoise strength per style — lower keeps closer to the uploaded
// drawing (good for technical line work), higher allows a bolder reimagining.
const STYLE_STRENGTH = {
  technical: 0.55,
  illustration: 0.68,
  photorealistic: 0.75,
  "night-scene": 0.78,
  aerial: 0.80,
  watercolor: 0.82,
};

function buildPrompt(style, environment, material) {
  const s = STYLE_PROMPTS[style] || style || "photorealistic exterior architectural rendering";
  const e = ENV_PROMPTS[environment] || environment || "natural daylight";
  const m = MATERIAL_PROMPTS[material] || material || "";
  const parts = [s];
  if (m) parts.push(m);
  parts.push(e);
  parts.push("8K resolution, sharp focus, high dynamic range, highly detailed");
  return parts.join(", ");
}

function buildNegativePrompt(style) {
  if (ARTISTIC_STYLES.has(style)) {
    // Keep artefacts out but allow painterly / illustrative character.
    return "deformed, bad anatomy, distorted proportions, blurry, " +
           "watermark, signature, text, logo, duplicated, low quality";
  }
  return "deformed, ugly, bad anatomy, blurry, distorted, cartoon, " +
         "illustration, painting, watermark, text, logo, oversaturated, low quality";
}

/** @param {number} ms @return {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// 1. processRenderJob
// Trigger : onCreate   renderQueue/{jobId}
// Flow    : tier rate limit → Replicate submit → poll → write result
//           → gallery → usage tracking → render-complete email
// ═══════════════════════════════════════════════════════════════════════════
exports.processRenderJob = functions
  .runWith({ timeoutSeconds: 300, memory: "512MB" })
  .firestore.document("renderQueue/{jobId}")
  .onCreate(async (snap, context) => {
    const jobRef = snap.ref;
    const { uid, sourceURL, style, environment, material } = snap.data();
    const jobId = context.params.jobId;
    functions.logger.info("Render job received", { jobId, uid });

    // ── 1a. Load user profile ──────────────────────────────────────────────
    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const user     = userSnap.exists ? userSnap.data() : {};
    const tier     = user.tier || user.plan || "free";
    const dailyLimit = TIER_LIMITS[tier] || TIER_LIMITS.free;

    // ── 1b. Rate limiting ─────────────────────────────────────────────────
    const todayStr   = new Date().toDateString();
    const lastDate   = user.lastRenderDate || "";
    const dailyCount = lastDate === todayStr ? (user.dailyRenderCount || 0) : 0;

    if (dailyCount >= dailyLimit) {
      const upgradeMsg = tier === "free"
        ? "Upgrade to Pro (20 renders/day) or Enterprise (100 renders/day) for more."
        : `Your ${tier} plan allows ${dailyLimit} renders per day. Contact us to upgrade.`;
      await jobRef.update({
        status:    "error",
        error:     `Daily render limit reached (${dailyLimit}/day on ${tier} plan). ${upgradeMsg}`,
        failedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
      functions.logger.info("Rate limit hit", { uid, tier, dailyCount, dailyLimit });
      return null;
    }

    // ── 1c. Mark processing ───────────────────────────────────────────────
    await jobRef.update({
      status:    "processing",
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── 1d. Guard: Replicate unconfigured ────────────────────────────────
    if (!REPLICATE_TOKEN || REPLICATE_MODEL_VERSION.startsWith("TODO")) {
      await jobRef.update({
        status:   "error",
        error:    "AI render engine is not configured yet — please check back soon.",
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      functions.logger.warn("Replicate not configured", { jobId });
      return null;
    }

    try {
      // ── 1e. Submit to Replicate ──────────────────────────────────────────
      const prompt   = buildPrompt(style, environment, material);
      const negative = buildNegativePrompt(style);
      const strength = STYLE_STRENGTH[style] || 0.75;
      const { data: prediction } = await axios.post(
        "https://api.replicate.com/v1/predictions",
        {
          version: REPLICATE_MODEL_VERSION,
          input: {
            image:               sourceURL,
            prompt,
            negative_prompt:     negative,
            controlnet_conditioning_scale: 0.8,
            strength,
            num_inference_steps: 30,
            guidance_scale:      7.5,
          },
        },
        {
          headers: { "Authorization": `Token ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
          timeout: 15000,
        }
      );

      await jobRef.update({ predictionId: prediction.id });
      functions.logger.info("Prediction queued", { predictionId: prediction.id });

      // ── 1f. Poll for completion ──────────────────────────────────────────
      let outputURL = null;
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        await sleep(POLL_INTERVAL_MS);
        const { data: poll } = await axios.get(
          `https://api.replicate.com/v1/predictions/${prediction.id}`,
          { headers: { "Authorization": `Token ${REPLICATE_TOKEN}` }, timeout: 10000 }
        );
        if (poll.status === "succeeded") {
          outputURL = Array.isArray(poll.output) ? poll.output[0] : poll.output;
          break;
        }
        if (poll.status === "failed" || poll.status === "canceled") {
          throw new Error(poll.error || `Prediction ${poll.status}`);
        }
      }
      if (!outputURL) {
        throw new Error("Render timed out. Please try again.");
      }

      // ── 1g. Write result ─────────────────────────────────────────────────
      await jobRef.update({
        status:      "done",
        outputURL,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      functions.logger.info("Render complete", { jobId, outputURL: outputURL.slice(0, 60) });

      // ── 1h. Gallery entry ────────────────────────────────────────────────
      const displayName   = user.name || "Anonymous";
      const capitalStyle  = style ? style.charAt(0).toUpperCase() + style.slice(1) : "Architectural";
      const capitalEnv    = environment ? environment.charAt(0).toUpperCase() + environment.slice(1) : "Day";

      await db.collection("gallery").add({
        jobId, uid,
        authorName: displayName,
        sourceURL, imageURL: outputURL,
        style:       style       || "photorealistic",
        environment: environment || "day",
        material:    material     || "",
        title:       `${capitalStyle} · ${capitalEnv}`,
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
        featured: false, likes: 0, public: true,
      });

      // ── 1i. Usage tracking ───────────────────────────────────────────────
      const freshSnap  = await userRef.get();
      const freshUser  = freshSnap.data() || {};
      const newDailyCount = freshUser.lastRenderDate === todayStr
        ? (freshUser.dailyRenderCount || 0) + 1 : 1;

      await userRef.update({
        dailyRenderCount: newDailyCount,
        lastRenderDate:   todayStr,
        totalRenders:     admin.firestore.FieldValue.increment(1),
        lastRenderAt:     admin.firestore.FieldValue.serverTimestamp(),
      });

      // ── 1j. Write usage log ──────────────────────────────────────────────
      await db.collection("usage").add({
        uid, jobId, tier,
        event:     "render_complete",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ── 1k. Send render-complete email ───────────────────────────────────
      if (user.email) {
        try {
          const mailer = getMailer();
          await mailer.sendMail({
            from:    FROM_EMAIL,
            replyTo: REPLY_TO,
            to:      user.email,
            subject: "✅ Your architectural render is ready — Serene Arch Studio",
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
                <div style="background:#0a1628;padding:24px;text-align:center">
                  <h1 style="color:#d4af37;margin:0;font-size:22px">Serene Arch Studio</h1>
                  <p style="color:#8899aa;margin:4px 0 0">AI Architectural Visualisation</p>
                </div>
                <div style="padding:32px 24px">
                  <h2 style="color:#0a1628;margin-top:0">Your render is ready, ${displayName}!</h2>
                  <p>Your <strong>${capitalStyle} · ${capitalEnv}</strong> rendering has been completed.</p>
                  <div style="text-align:center;margin:24px 0">
                    <a href="${outputURL}"
                       style="display:inline-block;background:#d4af37;color:#0a1628;
                              padding:12px 28px;border-radius:6px;font-weight:bold;
                              text-decoration:none">View Your Render</a>
                  </div>
                  <p style="color:#666;font-size:13px">
                    Your render has also been saved to your gallery inside the studio.
                    You have used <strong>${newDailyCount}</strong> of your
                    <strong>${dailyLimit}</strong> daily renders (${tier} plan).
                  </p>
                  ${EMAIL_SIGNATURE}
                </div>
                <div style="background:#f4f4f4;padding:16px 24px;font-size:12px;color:#888;text-align:center">
                  Serene Creations Ltd · Kampala, Uganda ·
                  <a href="https://serenecreations.org" style="color:#d4af37">serenecreations.org</a>
                </div>
              </div>`,
          });
          functions.logger.info("Render-complete email sent", { email: user.email });
        } catch (mailErr) {
          functions.logger.warn("Render-complete email failed (non-fatal)", { error: mailErr.message });
        }
      }

    } catch (err) {
      functions.logger.error("Render job failed", { jobId, error: err.message });
      await jobRef.update({
        status:   "error",
        error:    err.message || "Render failed — please try again.",
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return null;
  });

// ═══════════════════════════════════════════════════════════════════════════
// 2. onUserCreated
// Trigger : onCreate   users/{uid}
// Fires WELCOME_HOOK + sends branded welcome email via Zoho SMTP
// ═══════════════════════════════════════════════════════════════════════════
exports.onUserCreated = functions.firestore
  .document("users/{uid}")
  .onCreate(async (snap, context) => {
    const user = snap.data();
    const uid  = context.params.uid;
    functions.logger.info("New user — firing welcome hook", { email: user.email });

    // ── Activepieces welcome webhook ─────────────────────────────────────
    try {
      await axios.post(
        WELCOME_HOOK,
        {
          uid,
          name:       user.name     || "",
          email:      user.email    || "",
          tier:       user.tier     || user.plan || "free",
          photoURL:   user.photoURL || null,
          signedUpAt: new Date().toISOString(),
          source:     "ai-architecture-studio",
        },
        { timeout: 8000 }
      );
      functions.logger.info("Welcome hook sent", { email: user.email });
    } catch (err) {
      functions.logger.warn("Welcome hook failed (non-fatal)", { error: err.message });
    }

    // ── Branded welcome email ─────────────────────────────────────────────
    if (user.email) {
      try {
        const displayName = user.name || "Architect";
        const mailer = getMailer();
        await mailer.sendMail({
          from:    FROM_EMAIL,
          replyTo: REPLY_TO,
          to:      user.email,
          subject: "Welcome to Serene Arch Studio 🏛️ — Your AI Studio is Ready",
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
              <div style="background:#0a1628;padding:32px 24px;text-align:center">
                <h1 style="color:#d4af37;margin:0 0 4px;font-size:26px">Serene Arch Studio</h1>
                <p style="color:#8899aa;margin:0">AI Architectural Visualisation</p>
              </div>
              <div style="padding:36px 24px">
                <h2 style="color:#0a1628;margin-top:0">Welcome, ${displayName}! 🎉</h2>
                <p>Your AI architecture studio is ready. Here's what you can do right now:</p>
                <ul style="padding-left:20px;line-height:1.8">
                  <li>Upload a floor plan or sketch</li>
                  <li>Choose a design style (Modernist, Biophilic, Industrial, and more)</li>
                  <li>Select a lighting environment</li>
                  <li>Get a photorealistic 8K rendering in minutes</li>
                </ul>
                <div style="background:#f8f4e8;border-left:4px solid #d4af37;padding:12px 16px;margin:24px 0;border-radius:0 6px 6px 0">
                  <strong>Your Free Plan includes:</strong> 3 renders per day<br>
                  <span style="color:#888;font-size:13px">Upgrade to Pro for 20/day or Enterprise for 100/day</span>
                </div>
                <div style="text-align:center;margin:32px 0">
                  <a href="https://serenecreations.org/studio"
                     style="display:inline-block;background:#d4af37;color:#0a1628;
                            padding:14px 36px;border-radius:6px;font-weight:bold;
                            text-decoration:none;font-size:16px">Open Your Studio →</a>
                </div>
              </div>
              <div style="padding:0 24px 24px">
                ${EMAIL_SIGNATURE}
              </div>
              <div style="background:#f4f4f4;padding:16px 24px;font-size:12px;color:#888;text-align:center">
                Serene Creations Ltd · Kampala, Uganda ·
                <a href="https://serenecreations.org" style="color:#d4af37">serenecreations.org</a><br>
                <span style="margin-top:4px;display:block">Reply to this email if you need help.</span>
              </div>
            </div>`,
        });
        functions.logger.info("Welcome email sent", { email: user.email });
      } catch (mailErr) {
        functions.logger.warn("Welcome email failed (non-fatal)", { error: mailErr.message });
      }
    }

    return null;
  });

// ═══════════════════════════════════════════════════════════════════════════
// 3. trackLead  (HTTPS — public endpoint)
// POST /trackLead  { email?, name?, source? }
// Fires LEAD_HOOK + stores lead in Firestore
// ═══════════════════════════════════════════════════════════════════════════
exports.trackLead = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST")   { res.status(405).json({ error: "Method Not Allowed" }); return; }

  const body = req.body || {};

  // Store lead in Firestore
  try {
    await db.collection("leads").add({
      email:     body.email  || "",
      name:      body.name   || "",
      source:    body.source || "get-started-button",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      platform:  "ai-architecture-studio",
      converted: false,
    });
  } catch (err) {
    functions.logger.warn("Lead Firestore write failed", { error: err.message });
  }

  // Fire Activepieces webhook
  try {
    await axios.post(
      LEAD_HOOK,
      {
        email:     body.email  || "",
        name:      body.name   || "",
        source:    body.source || "get-started-button",
        timestamp: new Date().toISOString(),
        platform:  "ai-architecture-studio",
      },
      { timeout: 8000 }
    );
    functions.logger.info("Lead tracked", { email: body.email });
  } catch (err) {
    functions.logger.warn("Lead hook failed (non-fatal)", { error: err.message });
  }

  // Auto-enroll into drip campaign if source maps to one
  if (body.email && SOURCE_CAMPAIGN_MAP[body.source]) {
    const campaignId = SOURCE_CAMPAIGN_MAP[body.source];
    try {
      const subRef = db.collection("campaignSubscriptions")
        .doc(`${body.email.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${campaignId}`);
      const existing = await subRef.get();
      if (!existing.exists || existing.data().completed) {
        await subRef.set({
          email:        body.email.toLowerCase(),
          name:         body.name || "",
          campaignId,
          stage:        0,
          nextSendAt:   admin.firestore.Timestamp.now(),
          source:       body.source,
          subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
          completed:    false,
        });
        functions.logger.info("trackLead: auto-enrolled in campaign", { email: body.email, campaignId });
      }
    } catch (enrollErr) {
      functions.logger.warn("trackLead: campaign enroll failed (non-fatal)", { error: enrollErr.message });
    }
  }

  res.status(200).json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. getUsageStats  (HTTPS — authenticated)
// GET /getUsageStats
// Returns the calling user's render stats (daily, total, tier, remaining)
// ═══════════════════════════════════════════════════════════════════════════
exports.getUsageStats = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  // Verify Firebase ID token
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing auth token" }); return;
  }
  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(authHeader.slice(7));
  } catch {
    res.status(401).json({ error: "Invalid auth token" }); return;
  }

  const uid      = decodedToken.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  const user     = userSnap.exists ? userSnap.data() : {};
  const tier     = user.tier || user.plan || "free";
  const limit    = TIER_LIMITS[tier] || TIER_LIMITS.free;
  const todayStr = new Date().toDateString();
  const daily    = user.lastRenderDate === todayStr ? (user.dailyRenderCount || 0) : 0;

  res.status(200).json({
    uid,
    tier,
    dailyLimit:      limit,
    rendersToday:    daily,
    rendersRemaining: Math.max(0, limit - daily),
    totalRenders:    user.totalRenders || 0,
    lastRenderAt:    user.lastRenderAt ? user.lastRenderAt.toDate().toISOString() : null,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. contactFormSubmit  (HTTPS — public endpoint)
// POST /contactFormSubmit  { name, email, phone?, subject?, message }
// Stores the contact in Firestore + sends a notification email to studio
// ═══════════════════════════════════════════════════════════════════════════
exports.contactFormSubmit = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST")   { res.status(405).json({ error: "Method Not Allowed" }); return; }

  const { name, email, phone, subject, message } = req.body || {};
  if (!email || !message) {
    res.status(400).json({ error: "email and message are required" }); return;
  }

  // Store in Firestore
  let contactId;
  try {
    const ref = await db.collection("contacts").add({
      name:       name    || "",
      email,
      phone:      phone   || "",
      subject:    subject || "General Enquiry",
      message,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      status:      "new",
    });
    contactId = ref.id;
  } catch (err) {
    functions.logger.error("Contact Firestore write failed", { error: err.message });
  }

  // Notify studio via email
  try {
    const mailer = getMailer();

    // Internal notification to studio
    await mailer.sendMail({
      from:    FROM_EMAIL,
      replyTo: email, // Reply goes to the enquirer
      to:      REPLY_TO,
      subject: `📩 New Contact Form Submission — ${subject || "General Enquiry"}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
          <div style="background:#0a1628;padding:20px 24px">
            <h1 style="color:#d4af37;margin:0;font-size:18px">New Contact Submission</h1>
          </div>
          <div style="padding:24px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:6px 0;font-weight:bold;width:100px">Name</td><td>${name || "Not provided"}</td></tr>
              <tr><td style="padding:6px 0;font-weight:bold">Email</td><td><a href="mailto:${email}">${email}</a></td></tr>
              <tr><td style="padding:6px 0;font-weight:bold">Phone</td><td>${phone || "Not provided"}</td></tr>
              <tr><td style="padding:6px 0;font-weight:bold">Subject</td><td>${subject || "General Enquiry"}</td></tr>
              <tr><td style="padding:6px 0;font-weight:bold">Message</td><td style="white-space:pre-wrap">${message}</td></tr>
            </table>
            ${contactId ? `<p style="color:#888;font-size:12px;margin-top:16px">Reference: #${contactId}</p>` : ""}
          </div>
        </div>`,
    });

    // Auto-reply to the enquirer
    await mailer.sendMail({
      from:    FROM_EMAIL,
      replyTo: REPLY_TO,
      to:      email,
      subject: "We received your message — Serene Arch Studio",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
          <div style="background:#0a1628;padding:32px 24px;text-align:center">
            <h1 style="color:#d4af37;margin:0 0 4px;font-size:24px">Serene Arch Studio</h1>
            <p style="color:#8899aa;margin:0">AI Architectural Visualisation</p>
          </div>
          <div style="padding:32px 24px">
            <h2 style="color:#0a1628;margin-top:0">Thank you, ${name || "there"}!</h2>
            <p>We've received your message and will get back to you within 24 hours.</p>
            <p style="background:#f8f4e8;border-left:4px solid #d4af37;padding:12px 16px;border-radius:0 6px 6px 0">
              <strong>Your message:</strong><br>
              <em style="color:#555">${message.slice(0, 200)}${message.length > 200 ? "…" : ""}</em>
            </p>
            <p>While you wait, why not try our AI rendering studio?</p>
            <div style="text-align:center;margin:24px 0">
              <a href="https://serenecreations.org/studio"
                 style="display:inline-block;background:#d4af37;color:#0a1628;
                        padding:12px 28px;border-radius:6px;font-weight:bold;text-decoration:none">
                Try the Studio →</a>
            </div>
            ${EMAIL_SIGNATURE}
          </div>
          <div style="background:#f4f4f4;padding:16px 24px;font-size:12px;color:#888;text-align:center">
            Serene Creations Ltd · Kampala, Uganda ·
            <a href="https://serenecreations.org" style="color:#d4af37">serenecreations.org</a>
          </div>
        </div>`,
    });

    functions.logger.info("Contact emails sent", { email, contactId });
  } catch (mailErr) {
    functions.logger.warn("Contact email failed (non-fatal)", { error: mailErr.message });
  }

  res.status(200).json({ success: true, contactId: contactId || null });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. adminStats  (HTTPS — admin-only)
// GET /adminStats  (requires auth + users/{uid}.role === "admin")
// Returns platform-wide metrics for the Serene admin dashboard
// ═══════════════════════════════════════════════════════════════════════════
exports.adminStats = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  // Verify token + admin role
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing auth token" }); return;
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
  } catch {
    res.status(401).json({ error: "Invalid auth token" }); return;
  }

  const callerSnap = await db.collection("users").doc(decoded.uid).get();
  if (!callerSnap.exists || callerSnap.data().role !== "admin") {
    res.status(403).json({ error: "Admin access required" }); return;
  }

  try {
    // Parallel reads for efficiency
    const [gallerySnap, leadsSnap, contactsSnap, usageSnap] = await Promise.all([
      db.collection("gallery").count().get(),
      db.collection("leads").count().get(),
      db.collection("contacts").count().get(),
      db.collection("usage").count().get(),
    ]);

    // Recent renders (last 10) for the activity feed
    const recentSnap = await db.collection("gallery")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    const recentRenders = recentSnap.docs.map((d) => ({
      jobId:       d.data().jobId,
      uid:         d.data().uid,
      authorName:  d.data().authorName,
      style:       d.data().style,
      environment: d.data().environment,
      imageURL:    d.data().imageURL,
      createdAt:   d.data().createdAt ? d.data().createdAt.toDate().toISOString() : null,
    }));

    res.status(200).json({
      totalRenders:   gallerySnap.data().count,
      totalLeads:     leadsSnap.data().count,
      totalContacts:  contactsSnap.data().count,
      totalUsageEvents: usageSnap.data().count,
      recentRenders,
      generatedAt:    new Date().toISOString(),
    });
  } catch (err) {
    functions.logger.error("adminStats error", { error: err.message });
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. scheduledCleanup
// Runs daily at 02:00 UTC — purges stale pending/error jobs older than 7 days
// and removes usage log entries older than 90 days
// ═══════════════════════════════════════════════════════════════════════════
exports.scheduledCleanup = functions
  .runWith({ timeoutSeconds: 540, memory: "256MB" })
  .pubsub.schedule("0 2 * * *")
  .timeZone("Africa/Kampala")
  .onRun(async () => {
    const now     = admin.firestore.Timestamp.now();
    const seven   = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const ninety  = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const sevenTs  = admin.firestore.Timestamp.fromDate(seven);
    const ninetyTs = admin.firestore.Timestamp.fromDate(ninety);

    let deletedJobs = 0, deletedUsage = 0;

    // Stale render jobs
    const staleSnap = await db.collection("renderQueue")
      .where("status", "in", ["pending", "error"])
      .where("createdAt", "<", sevenTs)
      .limit(500)
      .get();

    const batch1 = db.batch();
    staleSnap.docs.forEach((d) => { batch1.delete(d.ref); deletedJobs++; });
    if (deletedJobs > 0) await batch1.commit();

    // Old usage logs
    const oldUsageSnap = await db.collection("usage")
      .where("createdAt", "<", ninetyTs)
      .limit(500)
      .get();

    const batch2 = db.batch();
    oldUsageSnap.docs.forEach((d) => { batch2.delete(d.ref); deletedUsage++; });
    if (deletedUsage > 0) await batch2.commit();

    functions.logger.info("Scheduled cleanup complete", {
      deletedJobs, deletedUsage, ranAt: now.toDate().toISOString(),
    });

    return null;
  });

// ─────────────────────────────────────────────────────────────────────────────
// 8. stripeWebhook  — POST (raw body, Stripe signature verified)
//    Handles Stripe subscription events and updates user tier in Firestore.
//    Set secrets:
//      firebase functions:config:set \
//        stripe.secret="sk_live_..." \
//        stripe.webhook_secret="whsec_..."
// ─────────────────────────────────────────────────────────────────────────────
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).send("");

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!stripe) {
    functions.logger.error("stripeWebhook: Stripe not configured");
    return res.status(500).json({ error: "Stripe not configured" });
  }

  // Stripe requires raw body for signature verification
  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).json({ error: "Missing stripe-signature header" });

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    functions.logger.warn("stripeWebhook: Signature verification failed", { err: err.message });
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  functions.logger.info("stripeWebhook received", { type: event.type });

  try {
    switch (event.type) {

      case "checkout.session.completed": {
        const session = event.data.object;
        // uid is stored as client_reference_id or in metadata
        const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
        if (!uid) { functions.logger.warn("checkout.session.completed: no uid"); break; }

        const tier = (session.metadata && STRIPE_TIER_MAP[session.metadata.tier]) || "pro";
        await db.collection("users").doc(uid).set({ tier }, { merge: true });

        // Send upgrade email
        const userDoc = await db.collection("users").doc(uid).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        const email = userData.email || session.customer_email;
        if (email) {
          const transporter = getMailer();
          await transporter.sendMail({
            from: FROM_EMAIL,
            replyTo: REPLY_TO,
            to: email,
            subject: "Welcome to Serene Arch Studio — Your Plan is Active!",
            html: `
              <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
                <h2 style="color:#4A6741">Your ${tier.charAt(0).toUpperCase()+tier.slice(1)} Plan is Active 🎉</h2>
                <p>Hi${userData.displayName ? " " + userData.displayName : ""},</p>
                <p>Thank you for upgrading! Your <strong>${tier.toUpperCase()}</strong> plan is now active on
                   Serene Arch Studio. You now have up to <strong>${TIER_LIMITS[tier] || 20} AI renders per day</strong>.</p>
                <p><a href="https://studio.serenecreations.org"
                      style="background:#4A6741;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">
                   Go to Studio
                </a></p>
                <p style="color:#888;font-size:12px">
                  Questions? Reply to this email or contact us at info@serenecreations.org
                </p>
                ${EMAIL_SIGNATURE}
              </div>`,
          });
        }
        functions.logger.info("checkout.session.completed: tier updated", { uid, tier });
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const uid = sub.metadata && sub.metadata.uid;
        if (!uid) { functions.logger.warn("subscription.updated: no uid in metadata"); break; }

        // Derive tier from subscription status / metadata
        let tier = (sub.metadata && STRIPE_TIER_MAP[sub.metadata.tier]) || "free";
        if (sub.status !== "active" && sub.status !== "trialing") tier = "free";

        await db.collection("users").doc(uid).set({ tier, stripeSubId: sub.id }, { merge: true });
        functions.logger.info("subscription.updated: tier updated", { uid, tier, status: sub.status });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const uid = sub.metadata && sub.metadata.uid;
        if (!uid) { functions.logger.warn("subscription.deleted: no uid in metadata"); break; }

        await db.collection("users").doc(uid).set({ tier: "free" }, { merge: true });
        functions.logger.info("subscription.deleted: tier reset to free", { uid });
        break;
      }

      default:
        functions.logger.info(`stripeWebhook: unhandled event type ${event.type}`);
    }
  } catch (err) {
    functions.logger.error("stripeWebhook: handler error", { err: err.message });
    return res.status(500).json({ error: "Internal error processing webhook" });
  }

  return res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. approveRender  — POST { galleryId, action: "approve"|"reject" }
//    Admin-only: publishes or removes a gallery render from public view.
//    Sends a notification email to the render owner.
// ─────────────────────────────────────────────────────────────────────────────
exports.approveRender = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // Verify Firebase ID token
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }
  let adminUser;
  try {
    adminUser = await admin.auth().verifyIdToken(authHeader.replace("Bearer ", ""));
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  // Admin role check
  const adminDoc = await db.collection("users").doc(adminUser.uid).get();
  if (!adminDoc.exists || adminDoc.data().role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  const { galleryId, action } = req.body || {};
  if (!galleryId || !["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "galleryId and action ('approve'|'reject') required" });
  }

  const galleryRef = db.collection("gallery").doc(galleryId);
  const galleryDoc = await galleryRef.get();
  if (!galleryDoc.exists) {
    return res.status(404).json({ error: "Gallery item not found" });
  }

  const galleryData = galleryDoc.data();
  const isPublic = action === "approve";
  await galleryRef.update({
    public: isPublic,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewedBy: adminUser.uid,
  });

  // Notify render owner
  if (galleryData.ownerUid) {
    const ownerDoc = await db.collection("users").doc(galleryData.ownerUid).get();
    const ownerEmail = ownerDoc.exists ? ownerDoc.data().email : null;
    if (ownerEmail) {
      try {
        const transporter = getMailer();
        const actionLabel = isPublic ? "approved and published" : "not approved for the gallery";
        await transporter.sendMail({
          from: FROM_EMAIL,
          replyTo: REPLY_TO,
          to: ownerEmail,
          subject: `Your Render Has Been ${isPublic ? "Published" : "Reviewed"} — Serene Arch Studio`,
          html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
              <h2 style="color:#4A6741">Render ${isPublic ? "Published ✅" : "Review Update"}</h2>
              <p>Hi,</p>
              <p>Your render <strong>${galleryData.title || galleryId}</strong> has been <strong>${actionLabel}</strong>.</p>
              ${isPublic ? `<p><a href="https://studio.serenecreations.org/gallery/${galleryId}"
                style="background:#4A6741;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">
                View in Gallery</a></p>` : ""}
              <p style="color:#888;font-size:12px">Questions? Contact info@serenecreations.org</p>
              ${EMAIL_SIGNATURE}
            </div>`,
        });
      } catch (emailErr) {
        functions.logger.warn("approveRender: email failed", { emailErr: emailErr.message });
      }
    }
  }

  functions.logger.info("approveRender", { galleryId, action, adminUid: adminUser.uid });
  return res.json({ success: true, galleryId, public: isPublic });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. exportUsageCSV  — GET
//    Admin-only: exports usage collection as downloadable CSV.
//    Query params: ?limit=500&from=YYYY-MM-DD&to=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
exports.exportUsageCSV = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  // Verify Firebase ID token
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }
  let adminUser;
  try {
    adminUser = await admin.auth().verifyIdToken(authHeader.replace("Bearer ", ""));
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  // Admin role check
  const adminDoc = await db.collection("users").doc(adminUser.uid).get();
  if (!adminDoc.exists || adminDoc.data().role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  // Build query
  const limitParam = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  let query = db.collection("usage").orderBy("createdAt", "desc").limit(limitParam);

  if (req.query.from) {
    query = query.where("createdAt", ">=",
      admin.firestore.Timestamp.fromDate(new Date(req.query.from)));
  }
  if (req.query.to) {
    query = query.where("createdAt", "<=",
      admin.firestore.Timestamp.fromDate(new Date(req.query.to)));
  }

  const snap = await query.get();

  // Build CSV
  const CSV_HEADERS = ["id", "uid", "email", "model", "type", "status", "createdAt", "processingMs"];
  const escapeCSV = (val) => {
    if (val === null || val === undefined) return "";
    const s = String(val);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = [CSV_HEADERS.join(",")];
  snap.docs.forEach((doc) => {
    const d = doc.data();
    rows.push([
      doc.id,
      d.uid || "",
      d.email || "",
      d.model || "",
      d.type || "",
      d.status || "",
      d.createdAt ? d.createdAt.toDate().toISOString() : "",
      d.processingMs || "",
    ].map(escapeCSV).join(","));
  });

  const csvContent = rows.join("\n");
  const filename = `usage-export-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  functions.logger.info("exportUsageCSV", { rows: snap.size, requestedBy: adminUser.uid });
  return res.send(csvContent);
});

// ─────────────────────────────────────────────────────────────────────────────
// DRIP CAMPAIGN SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Campaign sequence definitions.
 * Each sequence has 4 stages. `delayDays` is how many days to wait BEFORE
 * sending that stage (stage 0 = send immediately on subscription).
 */
const CAMPAIGNS = {
  "costs-uganda": {
    name: "Building Costs in Uganda 2026",
    emails: [
      {
        delayDays: 0,
        subject: "What does it really cost to build a home in Uganda? (2026 guide)",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>One of the most common questions we get at Serene Creations is: <em>"How much will it cost to build my house?"</em> It seems simple, but the honest answer is — it depends on a lot of factors. Let me give you a realistic breakdown for Uganda in 2026.</p>
  <h3 style="color:#2c5f2e">Typical Cost Ranges Per Square Metre (2026)</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr style="background:#f5f5f0"><th style="padding:8px;text-align:left;border:1px solid #ddd">Finish Level</th><th style="padding:8px;text-align:right;border:1px solid #ddd">Cost (UGX / m²)</th><th style="padding:8px;text-align:right;border:1px solid #ddd">Cost (USD / m²)</th></tr>
    <tr><td style="padding:8px;border:1px solid #ddd">Basic / walling only</td><td style="padding:8px;text-align:right;border:1px solid #ddd">800,000 – 1,000,000</td><td style="padding:8px;text-align:right;border:1px solid #ddd">~$210 – $260</td></tr>
    <tr style="background:#f9f9f9"><td style="padding:8px;border:1px solid #ddd">Standard residential</td><td style="padding:8px;text-align:right;border:1px solid #ddd">1,200,000 – 1,800,000</td><td style="padding:8px;text-align:right;border:1px solid #ddd">~$315 – $475</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd">High quality / imported finishes</td><td style="padding:8px;text-align:right;border:1px solid #ddd">2,000,000 – 3,500,000</td><td style="padding:8px;text-align:right;border:1px solid #ddd">~$525 – $920</td></tr>
  </table>
  <p style="font-size:13px;color:#666;margin-top:4px">*Rates reflect Kampala and major urban areas. Rural builds may be 10–20% lower on materials but higher on transport.</p>
  <h3 style="color:#2c5f2e">What Drives the Cost Up?</h3>
  <ul>
    <li><strong>Floor tiles and kitchen fittings</strong> — imported brands can add 15–25% to the total</li>
    <li><strong>Roofing material</strong> — clay tiles cost 2–3× more than iron sheets but last far longer</li>
    <li><strong>Storey construction</strong> — adding a second floor typically costs 60–70% of what the ground floor cost (not 100%, because the slab already exists)</li>
    <li><strong>Site conditions</strong> — a sloping plot or black cotton soil means more earthworks and a deeper foundation</li>
    <li><strong>Timing</strong> — starting construction in the dry season (June–August or December–February) reduces weather delays and mud-related rework</li>
  </ul>
  <h3 style="color:#2c5f2e">A Simple Rule of Thumb</h3>
  <p>For a well-finished 3-bedroom bungalow (~150 m²), budget <strong>UGX 180–270 million</strong> for the structure alone, before land, professional fees, and contingency. Always add at least <strong>15% contingency</strong> — surprises are not a risk, they are a certainty.</p>
  <p>In the next email, I'll walk through the hidden costs most homeowners discover only halfway through construction.</p>
  <p>Meanwhile, if you'd like a <strong>free preliminary cost estimate</strong> for your specific project, just reply to this email with the number of rooms, your plot location, and any sketches or floor plans you have.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "The hidden costs of building in Uganda (most people learn these too late)",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Last time I shared the headline cost ranges. Today, let's talk about what most builders <em>don't</em> budget for — the costs that turn a UGX 200M project into a UGX 260M project.</p>
  <h3 style="color:#2c5f2e">1. Professional Fees (often skipped entirely)</h3>
  <p>Architectural drawings, structural engineering, and approval fees typically run <strong>8–12% of construction cost</strong>. Trying to save here is penny-wise, pound-foolish — a poorly designed structure costs far more to correct mid-build.</p>
  <h3 style="color:#2c5f2e">2. Site Preparation &amp; Foundation</h3>
  <p>If your plot has poor drainage, black cotton soil, or a slope greater than 1:10, expect to spend an extra <strong>UGX 15–40 million</strong> on earthworks, retaining walls, or a raft foundation before a single wall goes up.</p>
  <h3 style="color:#2c5f2e">3. Electrical &amp; Plumbing Rough-In</h3>
  <p>Many clients budget for the visible fixtures but not the pipes and conduits inside the walls. Full electrical and plumbing rough-in for a 3-bedroom house typically costs <strong>UGX 18–35 million</strong> — before a single switch plate or tap is installed.</p>
  <h3 style="color:#2c5f2e">4. Water &amp; Electricity Connection</h3>
  <p>NWSC connection fees, a borehole, or a rainwater harvesting tank; UMEME transformer contribution if you're on a new plot — budget <strong>UGX 5–20 million</strong> depending on location.</p>
  <h3 style="color:#2c5f2e">5. Security, Gate &amp; Perimeter Wall</h3>
  <p>A perimeter wall and gate rarely makes it into the initial BOQ but almost always gets built. For a standard 50×100ft plot: <strong>UGX 20–40 million</strong>.</p>
  <h3 style="color:#2c5f2e">The Honest Total</h3>
  <p>Add these up and a "200M house" realistically becomes a <strong>260–290M project</strong>. Knowing this upfront lets you pace construction in stages rather than stopping halfway.</p>
  <p>Next email: how to read a Bill of Quantities (BOQ) so you can hold your contractor accountable line by line.</p>
  <p>Questions? Just hit reply — I read every message personally.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "How to read a BOQ — and catch a contractor overcharging you",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>A Bill of Quantities (BOQ) is the single most important financial document in your construction project. It lists every item of work with its quantity, unit, rate, and total. If you don't understand it, you're handing your contractor a blank cheque.</p>
  <h3 style="color:#2c5f2e">What a BOQ Should Contain</h3>
  <p>A complete BOQ is divided into sections matching the construction sequence:</p>
  <ol>
    <li><strong>Preliminaries</strong> — site establishment, temporary facilities, insurance, contractor's overhead &amp; profit</li>
    <li><strong>Substructure / Foundation</strong> — excavation (m³), blinding concrete, foundation walls, floor slab</li>
    <li><strong>Superstructure / Walling</strong> — brick/block quantities in m², lintel beams, columns, ring beam</li>
    <li><strong>Roofing</strong> — timber trusses, battens, roofing material per m², gutters and downpipes</li>
    <li><strong>Finishes</strong> — floor tiles (m²), wall plaster (m²), ceiling (m²), paint</li>
    <li><strong>Joinery</strong> — doors (no.), windows (no.), hardware</li>
    <li><strong>Plumbing &amp; Drainage</strong> — fixtures, pipes, manholes, septic/biogas</li>
    <li><strong>Electrical</strong> — consumer unit, points count, conduit metres, light fittings</li>
    <li><strong>External Works</strong> — paving, gate, perimeter wall, landscaping</li>
  </ol>
  <h3 style="color:#2c5f2e">Red Flags to Watch For</h3>
  <ul>
    <li>Rates with no unit (e.g. "walling — lumpsum UGX 30M") — demand a breakdown</li>
    <li>Preliminaries exceeding 12% of construction cost — often inflated</li>
    <li>Missing sections (e.g. no electrical or plumbing) — hidden future extras</li>
    <li>Quantities that don't match the drawings — measure yourself or have your engineer check</li>
  </ul>
  <h3 style="color:#2c5f2e">A Simple Check</h3>
  <p>Total up the walling section. Divide by the number of m² of walling on your drawings. If the rate per m² is wildly different from market rates (UGX 120,000–180,000/m² for standard brickwork in Kampala), ask why.</p>
  <p>Next and final email in this series: how to get your own cost estimate from Serene Creations — and what information we'll need from you.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Ready to know exactly what your project will cost?",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Over the past few weeks I've walked you through construction costs in Uganda, the hidden expenses most builders miss, and how to read a BOQ. I hope it's been useful.</p>
  <p>Now I'd like to offer something more concrete: a <strong>preliminary cost estimate for your specific project</strong>, prepared by our team at no charge.</p>
  <h3 style="color:#2c5f2e">What You Get</h3>
  <ul>
    <li>A structured BOQ outline tailored to your house design and location</li>
    <li>Cost ranges for each major section based on 2026 market rates</li>
    <li>Honest flagging of any site or design features likely to add cost</li>
    <li>Phasing suggestions if you want to build in stages</li>
  </ul>
  <h3 style="color:#2c5f2e">What We Need From You</h3>
  <ol>
    <li>Number of bedrooms and storeys</li>
    <li>Approximate floor area, or the floor plan if you have it</li>
    <li>Plot location (district/town)</li>
    <li>Any finish-level preferences (basic, standard, high-end)</li>
  </ol>
  <p>Simply reply to this email with those details, or book a free 30-minute call at <a href="https://serenecreations.org/contact" style="color:#2c5f2e">serenecreations.org/contact</a>.</p>
  <p>We've helped homeowners and investors across Uganda plan builds that stayed on budget. We'd love to help you do the same.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "approvals-uganda": {
    name: "Building Approvals in Uganda",
    emails: [
      {
        delayDays: 0,
        subject: "How to get building plan approval in Uganda — the complete 2026 guide",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Building without approved plans is one of the most common mistakes Ugandan homeowners make — and one of the most expensive to fix. Authorities can order you to demolish an unapproved structure, refuse you a loan against it, or withhold your occupancy permit. Let me walk you through how approvals actually work.</p>
  <h3 style="color:#2c5f2e">Who Approves Your Plans?</h3>
  <ul>
    <li><strong>Kampala Capital City Authority (KCCA)</strong> — for plots within Kampala City</li>
    <li><strong>Municipal Councils</strong> (Entebbe, Jinja, Mbarara, Gulu etc.) — for municipality plots</li>
    <li><strong>District Local Governments</strong> — for peri-urban and rural areas</li>
    <li><strong>Physical Planning Committees</strong> — sit under the above; they review the technical drawings</li>
  </ul>
  <h3 style="color:#2c5f2e">The Approval Process (Typical Steps)</h3>
  <ol>
    <li>Engage a registered architect to prepare drawings</li>
    <li>Obtain land title or consent letter from the registered owner</li>
    <li>Submit drawings + application form + title copy to the relevant authority</li>
    <li>Pay the prescribed fees (based on project cost/area)</li>
    <li>Technical review — this can take <strong>3–8 weeks</strong> if your drawings are complete</li>
    <li>Receive comments/conditions or approval stamp</li>
    <li>Address any comments and resubmit if required</li>
    <li>Approved drawings stamped — keep originals on site during construction</li>
  </ol>
  <h3 style="color:#2c5f2e">Timeline Reality</h3>
  <p>In Kampala, expect <strong>4–12 weeks</strong> from submission to approval if your drawings are in order. In municipalities, <strong>6–16 weeks</strong>. Planning this into your project timeline prevents the common mistake of starting construction while waiting (and then having to change designs mid-build).</p>
  <p>Next email: exactly which drawings you must submit, and what each one shows.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "Which drawings are required for building approval in Uganda?",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>When you submit for building approval, the authority needs a complete set of drawings. Submitting an incomplete set is the biggest cause of delays. Here's exactly what's required:</p>
  <h3 style="color:#2c5f2e">Required Architectural Drawings</h3>
  <ul>
    <li><strong>Site plan / block plan</strong> — shows your plot boundaries, setbacks from roads and neighbours, and the building's footprint position. Scale typically 1:500 or 1:200.</li>
    <li><strong>Floor plan(s)</strong> — each level separately. Shows room layout, door/window positions, wall thickness. Scale 1:100 or 1:50.</li>
    <li><strong>Elevations</strong> — front, rear, and both sides. Shows the building's external appearance and heights.</li>
    <li><strong>Sections</strong> — at least one longitudinal and one cross-section through the building. Shows internal heights, roof pitch, floor-to-ceiling clearances.</li>
    <li><strong>Roof plan</strong> — shows ridge, valleys, drainage direction, eaves overhang.</li>
  </ul>
  <h3 style="color:#2c5f2e">Required Structural Drawings (for buildings over 1 storey, or large ground-floor spans)</h3>
  <ul>
    <li>Foundation plan and details (footing dimensions, reinforcement schedule)</li>
    <li>Column and beam schedule</li>
    <li>Slab reinforcement plan</li>
    <li>Structural engineer's calculations and stamp</li>
  </ul>
  <h3 style="color:#2c5f2e">What Makes a Drawing Set "Complete"</h3>
  <p>All sheets must carry: the architect's name and UARB registration number, the engineer's name and UIE/UIPE number, the plot number and block/zone, north point, scale bar, and revision history. Missing any of these → automatic rejection.</p>
  <p>Next email: the three most common mistakes that get plan approvals rejected or delayed — and how to avoid them.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "3 mistakes that get building plans rejected in Uganda (and how to avoid them)",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>After reviewing dozens of submissions with KCCA and municipal councils over the years, I've seen the same mistakes again and again. Here are the top three and what to do instead.</p>
  <h3 style="color:#2c5f2e">Mistake 1: Setback Violations</h3>
  <p>Every plot has prescribed setbacks — minimum distances the building must keep from property boundaries. In Kampala, typical setbacks are 6m from the road, 3m from side boundaries, and 4.5m from the rear. Building within these zones means the authority will ask you to redesign, or worse, demolish what's already built.</p>
  <p><strong>Fix:</strong> Confirm the setbacks applicable to your zone before designing. Your architect should do this as the first step.</p>
  <h3 style="color:#2c5f2e">Mistake 2: Plot Coverage Exceeded</h3>
  <p>Most residential zones allow a maximum of 30–40% of the plot area to be covered by buildings. A 50×100ft plot (464 m²) at 30% coverage means no more than 139 m² of footprint. Many clients want bigger buildings on smaller plots — this triggers a rejection or requires a variance application.</p>
  <p><strong>Fix:</strong> Calculate your allowable footprint before committing to a floor plan size. Going vertical (adding a storey) is often the solution.</p>
  <h3 style="color:#2c5f2e">Mistake 3: Using an Unregistered Draughtsperson</h3>
  <p>Plans must be signed and stamped by an architect registered with the Uganda Registration Board (URB) or an engineer registered with UIE/UIPE. Plans from an unregistered draughtsperson are automatically invalid, no matter how good the drawings are.</p>
  <p><strong>Fix:</strong> Always ask for your professional's registration number. You can verify registration on the URB website.</p>
  <p>Next and final email: how Serene Creations handles the entire approvals process for you — from drawing preparation to approval receipt.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Let us handle your building approvals — start to finish",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>The approvals process is often the most frustrating part of building — not because it's technically difficult, but because it requires coordination between your architect, the authority, and sometimes the structural engineer, often over many weeks.</p>
  <p>At Serene Creations, we manage this entire process for our clients so they can focus on the bigger picture.</p>
  <h3 style="color:#2c5f2e">What We Do</h3>
  <ul>
    <li>Prepare a complete architectural drawing set (plans, elevations, sections, site plan)</li>
    <li>Coordinate structural drawings and engineer's stamp where required</li>
    <li>Submit to the relevant authority on your behalf</li>
    <li>Track progress, respond to technical queries, and resubmit with corrections</li>
    <li>Deliver your stamped approved drawings ready for construction</li>
  </ul>
  <h3 style="color:#2c5f2e">Typical Turnaround</h3>
  <p>We target approved drawings within <strong>6–10 weeks</strong> of receiving your site information and design brief, assuming a complete land title. For clients with urgent timelines, we can often fast-track preparation.</p>
  <h3 style="color:#2c5f2e">Ready to Start?</h3>
  <p>Reply to this email or visit <a href="https://serenecreations.org/contact" style="color:#2c5f2e">serenecreations.org/contact</a> to book a free consultation. We'll assess your plot, confirm the applicable setbacks and coverage limits, and give you a clear brief on what your approval process will look like.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "smart-design-uganda": {
    name: "Smart & Sustainable Design for Uganda",
    emails: [
      {
        delayDays: 0,
        subject: "Design your Uganda home to stay cool without air conditioning",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Uganda's equatorial climate means high temperatures, high humidity, and intense sun — but it also means consistent trade winds and regular rainfall. Designing with rather than against this climate can make your home significantly more comfortable at zero ongoing energy cost.</p>
  <h3 style="color:#2c5f2e">1. Building Orientation</h3>
  <p>Orient your house so the long axis runs roughly east-west. This exposes the smallest face of the building to the direct morning and afternoon sun, reducing solar heat gain by up to 30%.</p>
  <h3 style="color:#2c5f2e">2. Wide Eaves and Verandahs</h3>
  <p>A 1.2–1.5m eave overhang shades windows from high midday sun while allowing low-angle morning and evening light in. A wraparound verandah buffers the building envelope from direct radiation — one of the most effective (and oldest) passive cooling strategies in the region.</p>
  <h3 style="color:#2c5f2e">3. Cross-Ventilation</h3>
  <p>Position windows and doors on opposite sides of rooms along the prevailing wind direction (generally south-westerly in Uganda). High-level openings (clerestory windows, roof vents) exhaust hot air by buoyancy while low-level openings draw in cooler air.</p>
  <h3 style="color:#2c5f2e">4. Ceiling Height</h3>
  <p>Every extra 300mm of ceiling height above the standard 2.4m creates a significant buffer of warm air above the living zone. Ceilings at 3.0–3.3m are noticeably cooler, especially under an iron-sheet roof.</p>
  <h3 style="color:#2c5f2e">5. Roof Colour and Material</h3>
  <p>A light-coloured or clay-tile roof reflects 30–40% more solar radiation than a standard dark iron sheet. Combined with roof insulation or a ceiling void, this can drop indoor temperatures by 4–6°C during peak afternoon heat.</p>
  <p>Next email: how to integrate rainwater harvesting and solar power into your build — and what it actually costs.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "Rainwater harvesting + solar power in Uganda: real costs and real returns",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Uganda receives 900–2,000mm of rainfall per year — enough to supply a family's water needs for much of the year from a properly designed catchment system. Meanwhile, with an average of 5–6 peak sun hours per day, a modest solar installation can eliminate your grid electricity bill for daytime use. Here's what's realistic.</p>
  <h3 style="color:#2c5f2e">Rainwater Harvesting</h3>
  <p>A 200 m² roof in Kampala (1,200mm annual rainfall) collects approximately <strong>200,000 litres per year</strong> — around 550 litres per day on average. Accounting for losses, a family of 5–6 can cover most domestic water needs (cooking, drinking with treatment, washing) from a 10,000–20,000 litre tank.</p>
  <p><strong>Typical costs:</strong></p>
  <ul>
    <li>Gutters and downpipes: UGX 2–4M</li>
    <li>First-flush diverter: UGX 300,000–600,000</li>
    <li>10,000L underground tank: UGX 8–15M (concrete) or UGX 4–7M (plastic)</li>
    <li>Pump and filtration for drinking water: UGX 2–4M</li>
  </ul>
  <h3 style="color:#2c5f2e">Solar Power</h3>
  <p>A basic solar system for lighting and phone charging (4 × 15W points + USB): <strong>UGX 3–6M</strong>. A full hybrid system powering lighting, fans, TV, fridge, and router (2–3 kWp, 200Ah battery bank): <strong>UGX 18–35M</strong>. Payback period on UMEME savings: typically <strong>4–7 years</strong>, with panels lasting 20–25 years.</p>
  <p><strong>Design tip:</strong> Integrate the solar cable conduit, battery room, and inverter location during the building phase — retrofitting costs 30–50% more and looks ugly.</p>
  <p>Next email: which local materials to specify for durability and cost savings — without compromising quality.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "Local building materials in Uganda: what to use and what to avoid",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;line-height:1.7;margin:0 auto;color:#222">
  <p>Hi ${name || "there"},</p>
  <p>Specifying local materials where appropriate can cut your construction cost by 15–25% and support local supply chains. But not all local options are equal. Here's a practical guide.</p>
  <h3 style="color:#2c5f2e">Walling</h3>
  <p><strong>Burnt clay bricks</strong> — Uganda's most widely used walling material. Good thermal mass, widely available, reasonable cost (UGX 700–900 per brick in Kampala). Quality varies significantly by kiln; specify that bricks must ring when struck and show no visible cracks. Average 3-bedroom house uses 30,000–45,000 bricks.</p>
  <p><strong>Interlocking compressed earth blocks (ICEB)</strong> — made from stabilised soil, no firing needed. Lower embodied energy, good thermal performance, no mortar needed for most courses. Gaining popularity in Wakiso, Mukono, Jinja districts. Typically 15–25% cheaper than burnt brick for the wall complete.</p>
  <p><strong>Concrete blocks</strong> — faster to lay than brick but more expensive per m² and have lower thermal performance. Best used for boundary walls and foundations rather than living spaces.</p>
  <h3 style="color:#2c5f2e">Roofing</h3>
  <p><strong>Local clay tiles</strong> (e.g. from Mubende or Luwero districts) — beautiful, long-lasting (50+ years), excellent thermal performance. Cost ~3× iron sheets but zero maintenance and no rust. Ideal for permanent family homes.</p>
  <p><strong>Corrugated iron sheets</strong> — ubiquitous and cheap (UGX 35,000–55,000 per sheet). Specify 0.4–0.5mm gauge minimum; thinner sheets dent, rust, and leak within 5–8 years.</p>
  <h3 style="color:#2c5f2e">What to Always Import</h3>
  <p>Electrical fittings, plumbing fittings, and structural steel: local substitutes for these are often below standard. It's a small fraction of total cost but a place where quality control really matters.</p>
  <p>Final email in this series: a free design consultation to put these principles to work for your specific project.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Let's design your home the smart way — free consultation",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Over the past few weeks I've shared passive cooling strategies, rainwater and solar integration, and local material guidance. All of this is most powerful when designed in from the start — retrofitting climate-smart features later costs 2–3× more and rarely works as well.</p>
  <p>Our design approach at Serene Creations puts these principles at the centre of every project, not as an expensive add-on, but as the default way we design for Uganda's climate.</p>
  <h3 style="color:#2c5f2e">What a Free Consultation Covers</h3>
  <ul>
    <li>Review of your plot orientation and prevailing wind direction</li>
    <li>Discussion of your brief — rooms, lifestyle, budget, timeline</li>
    <li>Preliminary thoughts on layout and material strategy</li>
    <li>Honest assessment of what's achievable within your budget</li>
  </ul>
  <h3 style="color:#2c5f2e">How to Book</h3>
  <p>Reply to this email with a brief description of your project, or reach us directly:</p>
  <ul>
    <li>📞 <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a></li>
    <li>🌐 <a href="https://serenecreations.org/contact" style="color:#2c5f2e">serenecreations.org/contact</a></li>
  </ul>
  <p>We work with clients across Uganda — Kampala, Entebbe, Wakiso, Mukono, Jinja, and beyond. If your site is remote, we can do an initial consultation by video call.</p>
  <p>Looking forward to hearing about your project.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },
};

/** Map from lead source slug → campaign id */
const SOURCE_CAMPAIGN_MAP = {
  "blog-costs-uganda":    "costs-uganda",
  "blog-approvals-uganda": "approvals-uganda",
  "blog-smart-design":    "smart-design-uganda",
  "widget-costs":         "costs-uganda",
  "widget-approvals":     "approvals-uganda",
  "studio-promo":         "costs-uganda",
};

// ─── 11. subscribeToCampaign ─────────────────────────────────────────────────
exports.subscribeToCampaign = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { email, name, campaignId, source } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email required" });
  }
  const resolvedCampaign = campaignId || SOURCE_CAMPAIGN_MAP[source] || "costs-uganda";
  if (!CAMPAIGNS[resolvedCampaign]) {
    return res.status(400).json({ error: `Unknown campaign: ${resolvedCampaign}` });
  }

  try {
    const subRef = db.collection("campaignSubscriptions")
      .doc(`${email.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${resolvedCampaign}`);
    const existing = await subRef.get();
    if (existing.exists && !existing.data().completed) {
      return res.status(200).json({ status: "already_subscribed" });
    }

    await subRef.set({
      email: email.toLowerCase(),
      name: name || "",
      campaignId: resolvedCampaign,
      stage: 0,
      nextSendAt: admin.firestore.Timestamp.now(),
      source: source || "direct",
      subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
      completed: false,
    });

    functions.logger.info("subscribeToCampaign", { email, campaign: resolvedCampaign, source });
    return res.status(200).json({ status: "subscribed", campaign: resolvedCampaign });
  } catch (err) {
    functions.logger.error("subscribeToCampaign error", { err: err.message });
    return res.status(500).json({ error: "Internal error" });
  }
});

// ─── 12. scheduledDripSend ──────────────────────────────────────────────────
exports.scheduledDripSend = functions
  .runWith({ timeoutSeconds: 300, memory: "256MB" })
  .pubsub.schedule("0 8 * * *")
  .timeZone("Africa/Kampala")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const snap = await db.collection("campaignSubscriptions")
      .where("completed", "==", false)
      .where("nextSendAt", "<=", now)
      .limit(200)
      .get();

    if (snap.empty) {
      functions.logger.info("scheduledDripSend: no pending subscriptions");
      return null;
    }

    const mailer = getMailer();
    let sent = 0;
    let errors = 0;

    await Promise.allSettled(snap.docs.map(async (doc) => {
      const sub = doc.data();
      const campaign = CAMPAIGNS[sub.campaignId];
      if (!campaign) {
        await doc.ref.update({ completed: true });
        return;
      }

      const stage = sub.stage || 0;
      const emailDef = campaign.emails[stage];
      if (!emailDef) {
        await doc.ref.update({ completed: true });
        return;
      }

      try {
        await mailer.sendMail({
          from: FROM_EMAIL,
          to: sub.email,
          replyTo: REPLY_TO,
          subject: emailDef.subject,
          html: emailDef.html(sub.name || ""),
        });
        sent++;
      } catch (mailErr) {
        functions.logger.error("dripSend mail error", { email: sub.email, err: mailErr.message });
        errors++;
        return; // don't advance stage on mail failure
      }

      const nextStage = stage + 1;
      const isLast = nextStage >= campaign.emails.length;

      if (isLast) {
        await doc.ref.update({ stage: nextStage, completed: true });
      } else {
        const nextEmail = campaign.emails[nextStage];
        const delayMs = (nextEmail.delayDays || 4) * 24 * 60 * 60 * 1000;
        const nextSendAt = admin.firestore.Timestamp.fromMillis(Date.now() + delayMs);
        await doc.ref.update({ stage: nextStage, nextSendAt, lastSentAt: now });
      }
    }));

    functions.logger.info("scheduledDripSend complete", { sent, errors, total: snap.size });
    return null;
  });
