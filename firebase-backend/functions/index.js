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
 * Unsubscribe footer appended to every drip email.
 * @param {string} unsubUrl - Unique unsubscribe link for this subscription doc.
 */
const UNSUB_FOOTER = (unsubUrl) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:32px auto 0;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#999;line-height:1.6">
  You're receiving this because you opted in to receive building insights from
  <strong>Serene Creations</strong>. We'll never share your email.<br>
  <a href="${unsubUrl}" style="color:#999;text-decoration:underline">Unsubscribe</a>
  &nbsp;·&nbsp;
  <a href="https://serenecreations.org" style="color:#999;text-decoration:underline">serenecreations.org</a>
</div>`;

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

  "build-planning-uganda": {
    name: "Build Planning Starter Series",
    emails: [
      {
        delayDays: 0,
        subject: "Thinking of building in Uganda? Here's where to start",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Whether you've been dreaming about building your own home for years or just started exploring the idea, the first challenge is always the same: where do you begin?</p>
  <p>Over the next few weeks I'll walk you through the key phases of planning a build in Uganda — from working out your budget and brief, to choosing a contractor and breaking ground. Each email is short and practical, based on what we've learned helping homeowners across Uganda.</p>
  <h3 style="color:#2c5f2e">Phase 1: Define Your Brief</h3>
  <p>Before any drawings, before any contractor quotes, before any site visits — you need a written brief. It doesn't have to be long. Answer these questions:</p>
  <ol>
    <li><strong>Who will live in the house?</strong> Number of adults, children, any elderly or special-needs occupants.</li>
    <li><strong>How many bedrooms and bathrooms?</strong> Be specific — "3 beds, 2 baths, plus a study" is more useful than "a 3-bedroom house".</li>
    <li><strong>What's your absolute budget limit?</strong> Not "I'd like to spend X" but the maximum you can mobilise including contingency.</li>
    <li><strong>What's your timeline?</strong> Are you aiming to move in within 12 months, 2 years, or longer?</li>
    <li><strong>Do you have a plot?</strong> If yes, note the size, location, and whether you have a title deed.</li>
  </ol>
  <p>Writing these answers down forces clarity and surfaces conflicts early — much better to discover that your brief and your budget don't match at this stage than six months in.</p>
  <p>Next email: how to turn your brief into a realistic budget estimate before engaging anyone.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "How to budget your Uganda build before you talk to anyone",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Most people go to architects or contractors first and get a quote — then discover the number is far higher than expected. Starting with a realistic self-generated budget prevents that shock and puts you in a much stronger position when you do engage professionals.</p>
  <h3 style="color:#2c5f2e">A Simple Budget Framework (2026 Uganda)</h3>
  <p>Work out your approximate floor area first: number of bedrooms × 20–25 m² per bedroom, plus shared spaces (living, dining, kitchen at 40–60 m² total). A 3-bedroom home typically runs <strong>120–160 m²</strong>.</p>
  <p>Then apply a cost-per-m² estimate based on your target finish:</p>
  <ul>
    <li><strong>Basic:</strong> UGX 900,000–1,100,000 / m²</li>
    <li><strong>Standard:</strong> UGX 1,200,000–1,800,000 / m²</li>
    <li><strong>High-end:</strong> UGX 2,000,000–3,500,000 / m²</li>
  </ul>
  <p>For a standard 140 m² 3-bedroom house: <strong>UGX 168M – 252M</strong>. Add:</p>
  <ul>
    <li>Professional fees (architect + engineer): ~10% → +UGX 17–25M</li>
    <li>Approval fees and land survey: UGX 3–8M</li>
    <li>Contingency (non-negotiable): 15% of construction cost</li>
    <li>External works (gate, perimeter, paving): UGX 20–40M</li>
    <li>Water + electrical connection: UGX 5–15M</li>
  </ul>
  <p><strong>Realistic total for a quality 3-bedroom home in Kampala / Wakiso: UGX 220–320M.</strong> If your budget is lower, either reduce the spec, reduce the floor area, or plan to build in phases.</p>
  <p>Next email: how to choose the right architect and what to look for beyond price.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "How to choose an architect for your Uganda build",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>The architect you choose sets the direction of everything: the quality of your drawings, the efficiency of your layout, the accuracy of your BOQ, and how smooth your approvals process will be. Here's how to evaluate candidates seriously.</p>
  <h3 style="color:#2c5f2e">Verify Registration First</h3>
  <p>Your architect must be registered with the <strong>Uganda Registration Board (URB)</strong> — this is a legal requirement for plan submissions. Ask for their registration number and verify it on the URB website before signing anything. An unregistered draughtsperson, however talented, cannot get your plans approved.</p>
  <h3 style="color:#2c5f2e">Look at Built Work, Not Renders</h3>
  <p>Ask to see completed buildings — not just 3D renders. Visit a project they've done if possible. Renders can look beautiful regardless of whether the actual construction worked well. A completed building tells you whether the design was practical, the details were resolved, and the client relationship was managed.</p>
  <h3 style="color:#2c5f2e">Ask These Questions</h3>
  <ul>
    <li>"Who specifically will be doing my drawings — you or a junior?" Get a name.</li>
    <li>"Have you worked with plots/projects similar to mine?" A firm that mostly does commercial work may not understand residential priorities.</li>
    <li>"How do you handle plan approval submissions?" They should know the process in your specific jurisdiction.</li>
    <li>"What does your fee cover, and what will I pay extra for?" Get this in writing.</li>
  </ul>
  <h3 style="color:#2c5f2e">On Fees</h3>
  <p>Architectural fees in Uganda typically run <strong>5–8% of construction cost</strong> for a full service (schematic design, working drawings, approvals, site supervision). Very low fees usually mean junior staff, incomplete drawings, or no site visits. The architect is the cheapest professional on your project relative to the problems they prevent.</p>
  <p>Next email: understanding the building approval process — and how to plan your project timeline around it.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Build approvals in Uganda: how to plan your timeline",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>One of the most common mistakes in Uganda construction projects is starting on site while waiting for approvals — or not realising that approvals take significant time to budget into the project schedule. Here's a realistic look at the timeline.</p>
  <h3 style="color:#2c5f2e">The Approval Sequence</h3>
  <ol>
    <li><strong>Design phase</strong> — 4–8 weeks for a 3-bedroom house (longer for multi-storey or complex briefs)</li>
    <li><strong>Drawing preparation</strong> — 2–4 weeks for a complete set ready for submission</li>
    <li><strong>Submission and technical review</strong> — 4–12 weeks depending on the authority and completeness of your drawings</li>
    <li><strong>Comments/resubmission</strong> — add 2–4 weeks if corrections are required</li>
    <li><strong>Approval in hand</strong> — you can now begin construction legally</li>
  </ol>
  <p>Total from starting design to breaking ground: realistically <strong>3–6 months</strong>. Projects that try to cut this short by starting construction before approval risk stop-work orders, fines, and in extreme cases, demolition of unapproved structures.</p>
  <h3 style="color:#2c5f2e">Use the Waiting Time Productively</h3>
  <p>While your plans are under review, you can: source materials and get current price quotes, interview and pre-qualify contractors, prepare your contract and payment schedule, and sort out your financing. Good planning during the approval wait period saves weeks during construction.</p>
  <h3 style="color:#2c5f2e">A Realistic Project Calendar</h3>
  <p>Month 1–2: Finalise brief, engage architect, begin design<br>
  Month 3–4: Complete drawings, submit for approval<br>
  Month 4–6: Approval process; pre-qualify contractors in parallel<br>
  Month 6: Break ground<br>
  Month 6–18: Construction (depending on scope and financing pace)</p>
  <p>Final email next: how Serene Creations can guide you through this whole journey — and what we offer at each stage.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 21,
        subject: "Ready to move from planning to building? Let's talk",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Over the past few weeks I've walked you through defining your brief, building a realistic budget, choosing an architect, and understanding the approvals timeline. That's the foundation of a well-planned project.</p>
  <p>At Serene Creations, we work with homeowners and investors at exactly this stage — when the idea is clear but the path to execution still needs a guide.</p>
  <h3 style="color:#2c5f2e">What We Offer</h3>
  <ul>
    <li><strong>Architectural design</strong> — from schematic concept through to approved working drawings</li>
    <li><strong>BOQ and cost estimation</strong> — detailed, current-rate bills of quantities for contractor tendering</li>
    <li><strong>Building approvals management</strong> — submission, tracking, and response to authority queries</li>
    <li><strong>Construction supervision</strong> — periodic or full-time site supervision to protect your investment</li>
    <li><strong>AI Architecture Studio</strong> — explore design possibilities for your plot before committing to a full design brief</li>
  </ul>
  <h3 style="color:#2c5f2e">Free First Consultation</h3>
  <p>We offer a free 30-minute consultation — in person in Kampala or by video call for clients elsewhere. Bring your brief notes, any plot documents you have, and your budget figure. We'll tell you honestly what's achievable and what the right next step looks like.</p>
  <p>
    📞 <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a><br>
    🌐 <a href="https://serenecreations.org/contact" style="color:#2c5f2e">serenecreations.org/contact</a><br>
    ✉️ <a href="mailto:info@serenecreations.org" style="color:#2c5f2e">info@serenecreations.org</a>
  </p>
  <p>Looking forward to hearing about your project.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "boq-follow-up": {
    name: "BOQ & Cost Estimation Deep Dive",
    emails: [
      {
        delayDays: 0,
        subject: "Your BOQ question — here's exactly what we need to prepare yours",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>You reached out about construction costs — and the most useful thing we can give you isn't a general range, it's a <strong>Bill of Quantities (BOQ) specific to your project</strong>. Here's what that looks like and what we need from you to prepare one.</p>
  <h3 style="color:#2c5f2e">What a BOQ Gives You</h3>
  <p>A BOQ breaks your project into every line item — foundations, walling, roofing, finishes, M&amp;E — each with quantities, units, and current market rates. It lets you:</p>
  <ul>
    <li>Compare contractor quotes on a like-for-like basis</li>
    <li>Identify which items are priced fairly and which are inflated</li>
    <li>Plan phased construction by knowing exactly what each stage costs</li>
    <li>Track expenditure against a clear baseline throughout the build</li>
  </ul>
  <h3 style="color:#2c5f2e">What We Need from You</h3>
  <ol>
    <li><strong>Floor plan</strong> — even a rough sketch or downloaded plan is useful as a starting point</li>
    <li><strong>Number of bedrooms, bathrooms, and storeys</strong></li>
    <li><strong>Plot location</strong> — district/town (affects transport and labour costs)</li>
    <li><strong>Target finish level</strong> — basic, standard, or high-end finishes</li>
    <li><strong>Any specific requirements</strong> — solar, borehole, large compound, staff quarters etc.</li>
  </ol>
  <p>Reply to this email with these details and we'll prepare a preliminary cost estimate within 3 business days — at no charge.</p>
  <p>Next email: why two contractors can quote you 40% differently for the exact same house.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "Why two contractors quote 40% differently for the same house",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>One of the most confusing experiences in Uganda construction is getting two quotes for the same house and finding a 30–50% difference. Both contractors have looked at the same drawings. So why the gap?</p>
  <h3 style="color:#2c5f2e">Reason 1: Different Scope Assumptions</h3>
  <p>The cheap quote almost always excludes items the expensive one includes: electrical rough-in, plumbing drainage, external works, or the perimeter wall. It's not dishonesty — it's ambiguity in the brief. Without a BOQ defining the exact scope, each contractor prices what they think you mean.</p>
  <h3 style="color:#2c5f2e">Reason 2: Different Quality Assumptions</h3>
  <p>One contractor prices Italian tiles; another prices local. One includes 0.47mm roofing iron; another quotes 0.30mm (which buckles and leaks within a few years). Same line item, wildly different cost and lifespan.</p>
  <h3 style="color:#2c5f2e">Reason 3: Different Overhead Structures</h3>
  <p>A large established contractor has insurance, payroll, equipment costs, and a site manager on salary. A smaller contractor has lower overhead but potentially less supervision. This is a legitimate difference — neither is wrong, but you need to know which you're hiring.</p>
  <h3 style="color:#2c5f2e">Reason 4: Loss-Leader Pricing</h3>
  <p>Some contractors deliberately under-price to win the contract, then recover margin through variations once you're committed. The tell: a quote with very few line items and no BOQ attachment.</p>
  <h3 style="color:#2c5f2e">The Fix</h3>
  <p>Issue a detailed BOQ to every contractor you invite to tender. Require them to price each line item at the specified quantity and spec. Now the comparison is apples to apples.</p>
  <p>Next email: the 9 items every contractor's quote must include — and how to check each one.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "BOQ checklist: 9 items every contractor's quote must include",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Before you accept any contractor's quote, run it through this checklist. A quote missing these items will almost certainly generate expensive variations later.</p>
  <ol>
    <li>
      <strong>Preliminaries with a capped percentage</strong><br>
      Site establishment, temporary toilet, security, builder's risk insurance. Should be stated as a lump sum or % of construction cost — reject "TBC" here.
    </li>
    <li>
      <strong>Foundation to DPC (damp-proof course)</strong><br>
      Excavation in m³, blinding concrete, foundation strip/raft, foundation wall, DPC. Each separately priced.
    </li>
    <li>
      <strong>Walling in m² with brick/block spec</strong><br>
      Should state brick type, mortar mix, and a rate per m². If it says "walling — lump sum", reject it.
    </li>
    <li>
      <strong>Structural concrete (columns, beams, ring beam, slab)</strong><br>
      With concrete grade (C20 minimum for structural) and reinforcement schedule.
    </li>
    <li>
      <strong>Roofing — trusses, battens, covering material, gutters</strong><br>
      Iron sheet gauge or tile type specified. Gutter and downpipe material and size.
    </li>
    <li>
      <strong>Finishes — floor, walls, ceiling</strong><br>
      Tile size, brand category, and adhesive. Paint coats and primer. Ceiling board type.
    </li>
    <li>
      <strong>Joinery — doors and windows with hardware</strong><br>
      Number of each type. Door frame material. Window frame material, glazing type.
    </li>
    <li>
      <strong>Plumbing and drainage</strong><br>
      Fixture schedule, pipe material (CPVC/PPR vs. PVC), septic or biogas tank.
    </li>
    <li>
      <strong>Electrical</strong><br>
      Number of points, consumer unit rating, conduit material, earthing arrangement.
    </li>
  </ol>
  <p>If a quote covers all 9 in detail, you're dealing with a professional. If it doesn't, ask for the missing items before comparing it with anything.</p>
  <p>Next email: how to get your own project-specific BOQ from Serene Creations — and what we'll need to prepare it.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Ready for a BOQ built around your specific project?",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Over the past two weeks I've walked you through what a BOQ is, why contractor quotes vary so dramatically, and what every quote must include. Now let me show you what a proper BOQ looks like for your actual project.</p>
  <h3 style="color:#2c5f2e">Our BOQ Service</h3>
  <p>We prepare Bills of Quantities for homeowners and developers who want to enter the tender process with a robust, independently prepared cost document — not one prepared by the contractor they're about to hire.</p>
  <ul>
    <li>Based on your approved drawings or design brief</li>
    <li>Priced at current 2026 Uganda market rates</li>
    <li>Detailed enough to issue to 3–5 contractors for competitive tender</li>
    <li>Annotated to flag items with high price variability so you know where to negotiate</li>
  </ul>
  <h3 style="color:#2c5f2e">What It Costs</h3>
  <p>BOQ preparation fees typically run <strong>1–2% of estimated construction cost</strong>, depending on project complexity. For a 3-bedroom house at UGX 200M construction value, that's UGX 2–4M — a fraction of what a single poorly-priced variation can cost you.</p>
  <h3 style="color:#2c5f2e">Get Started</h3>
  <p>Reply with your floor plan (even a rough sketch), plot location, and target finish level. We'll come back to you with a scope confirmation and fee proposal within 2 business days.</p>
  <p>Alternatively, book a call at <a href="https://serenecreations.org/contact" style="color:#2c5f2e">serenecreations.org/contact</a> and we can discuss your project in detail.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "house-design-nurture": {
    name: "House Plan & Design Nurture",
    emails: [
      {
        delayDays: 0,
        subject: "3 things that make a house plan actually work for Uganda living",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>A good-looking floor plan on paper and a house that works well to live in are not the same thing. Over the years we've seen hundreds of Uganda homes — and certain principles consistently separate the comfortable, functional ones from the frustrating ones.</p>
  <h3 style="color:#2c5f2e">1. The Kitchen Should Connect to the Outdoor Kitchen</h3>
  <p>Many Ugandan households prepare heavy meals outdoors — grilling, frying, or cooking with wood. A floor plan that ignores this results in a beautiful indoor kitchen that nobody uses for serious cooking. The best layouts provide a covered outdoor cooking area directly accessible from the indoor kitchen, with a shared prep counter and storage.</p>
  <h3 style="color:#2c5f2e">2. A Separate Sitting Room Changes How You Live</h3>
  <p>Open-plan living looks impressive in renders. But in a family home in Uganda, it means your living room becomes the waiting room, the children's study, and the TV room simultaneously. A dedicated parlour or reception room — separate from the family sitting area — lets you receive guests without disrupting the household.</p>
  <h3 style="color:#2c5f2e">3. Every Bedroom Needs Cross-Ventilation</h3>
  <p>A room with a window on only one wall is a room that will be hot in March and April. Every bedroom should have openings on at least two walls — a window and a high-level louvre is enough. This simple decision makes a 5°C difference in sleeping temperature without any mechanical cooling.</p>
  <p>Next email: open plan vs. rooms — which layout model actually works better in Ugandan homes?</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "Open plan vs. rooms: which works better in a Ugandan home?",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Open-plan living has dominated international design trends for 20 years. It works beautifully in the climates and lifestyles it was designed for. The question is whether it works for yours.</p>
  <h3 style="color:#2c5f2e">The Case for Open Plan</h3>
  <p>A combined kitchen, dining, and living space feels generous even in a modest footprint. Light travels further. The family stays connected. It's easier to supervise children. For a couple or small family, it's often the right choice — and it photographs exceptionally well.</p>
  <h3 style="color:#2c5f2e">The Case for Separate Rooms</h3>
  <p>In a large or extended family household, open plan creates noise and privacy conflicts. The cooking smells, the TV, the children, and the guests all compete in the same space. Separate rooms let different family members use different spaces simultaneously without conflict. A properly ventilated closed kitchen doesn't get hotter than an open-plan one — it just smells better from the sitting room.</p>
  <h3 style="color:#2c5f2e">A Middle Ground That Works Well</h3>
  <p>The most successful layouts we've done for Uganda family homes combine: a <em>separate kitchen</em> (noise and odour control), a <em>semi-open dining and family room</em> (daily family use), and a <em>separate formal sitting room</em> (guests). This gives you connection where you want it and separation where you need it.</p>
  <h3 style="color:#2c5f2e">Questions to Ask Yourself</h3>
  <ul>
    <li>How often do you receive formal guests (relatives, visitors)?</li>
    <li>Do you cook with charcoal or wood regularly?</li>
    <li>How many people will live in the house at peak occupancy?</li>
    <li>Do children study at home in the evenings?</li>
  </ul>
  <p>Next email: the most common floor plan mistakes in Uganda homes — and how to spot them before you build.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "The 5 most common floor plan mistakes in Uganda homes",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>We've reviewed a lot of floor plans. Some are excellent. Many repeat the same mistakes — mistakes that seem minor on paper but become daily frustrations once you're living in the house. Here are the five most common.</p>
  <h3 style="color:#2c5f2e">1. The Bathroom You Can't Reach Without Walking Through a Bedroom</h3>
  <p>In a properly designed house, at least one bathroom should be accessible from the main living areas without passing through any bedroom. Building a family home where guests must walk through your bedroom to reach the toilet is a layout that can never be fixed without demolition.</p>
  <h3 style="color:#2c5f2e">2. The Corridor That Goes Nowhere</h3>
  <p>Long corridors that end at a single bedroom add floor area without adding function. Every metre of corridor costs as much as every metre of bedroom — make sure corridors distribute traffic to at least two or three destinations.</p>
  <h3 style="color:#2c5f2e">3. Bedroom Windows Facing the Road</h3>
  <p>For security, privacy, and noise, bedrooms should be positioned away from the main road boundary. Locate the living areas and kitchen toward the front access, bedrooms toward the rear or side.</p>
  <h3 style="color:#2c5f2e">4. A Kitchen with No Work Triangle</h3>
  <p>The refrigerator, cooker, and sink form the three points of a kitchen work triangle. If any two of these are more than 2.5m apart, or separated by a walking path, the kitchen is inefficient. This costs nothing to fix in the design phase and everything to fix after construction.</p>
  <h3 style="color:#2c5f2e">5. Only One Entry Door</h3>
  <p>In a family home, a secondary service entrance — separate from the main front door — allows deliveries, domestic staff access, and kitchen traffic to bypass the formal entrance. It doesn't need to be large; a 900mm door off the kitchen or utility area is enough.</p>
  <p>Next email: see what we can design for your specific plot — a free design consultation with no strings attached.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "See what's possible for your plot — free design consultation",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Over the past couple of weeks I've shared what makes Uganda homes work, the open plan question, and the most common layout mistakes. All of this is most useful when applied to your specific brief and your specific plot.</p>
  <p>At Serene Creations, we start every design engagement with a free consultation — not a sales pitch, a genuine professional conversation about your project.</p>
  <h3 style="color:#2c5f2e">What the Consultation Covers</h3>
  <ul>
    <li>Your brief — rooms, lifestyle, family size, priorities</li>
    <li>Your plot — size, orientation, access, any constraints</li>
    <li>Your budget — what's achievable at your investment level</li>
    <li>Design principles we'd apply for comfort, ventilation, and flow</li>
    <li>Honest timeline from brief to approved drawings to breaking ground</li>
  </ul>
  <h3 style="color:#2c5f2e">AI Architecture Preview</h3>
  <p>Before committing to a full design, you can use our <strong>AI Architecture Studio</strong> to explore design possibilities for your plot — generate visualisations in seconds, try different styles and layouts, and arrive at a brief you're confident in before a single drawing is commissioned.</p>
  <p>Try it at <a href="https://serenecreations.org" style="color:#2c5f2e">serenecreations.org</a>, or reach us directly to book a consultation:</p>
  <ul>
    <li>📞 <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a></li>
    <li>✉️ <a href="mailto:info@serenecreations.org" style="color:#2c5f2e">info@serenecreations.org</a></li>
  </ul>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "construction-ready": {
    name: "Construction Readiness Series",
    emails: [
      {
        delayDays: 0,
        subject: "About to break ground? Run through this checklist first",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>You're close to starting — exciting. But the weeks just before breaking ground are also when the most expensive mistakes get made. Here's the checklist we use with every client before the first shovel goes in.</p>
  <h3 style="color:#2c5f2e">Legal & Documentation</h3>
  <ul>
    <li>✅ Approved drawings in hand (stamped by the relevant authority)</li>
    <li>✅ Signed contract with contractor — not just a verbal agreement</li>
    <li>✅ Land title or lease confirmed (no encumbrances or disputes)</li>
    <li>✅ Structural engineer's certificate signed off</li>
  </ul>
  <h3 style="color:#2c5f2e">Financial</h3>
  <ul>
    <li>✅ Full construction budget confirmed including 15% contingency</li>
    <li>✅ Payment schedule agreed and tied to construction milestones, not dates</li>
    <li>✅ First phase funding confirmed and accessible (not "in principle")</li>
    <li>✅ BOQ issued to contractor so variations have a documented baseline</li>
  </ul>
  <h3 style="color:#2c5f2e">Site</h3>
  <ul>
    <li>✅ Site pegged and surveyed (plot boundaries confirmed)</li>
    <li>✅ Access route for material delivery confirmed</li>
    <li>✅ Water source for construction confirmed (borehole, tanks, NWSC)</li>
    <li>✅ Temporary site office and security arrangement agreed</li>
  </ul>
  <h3 style="color:#2c5f2e">People</h3>
  <ul>
    <li>✅ Site supervisor (yours, not just the contractor's foreman) identified</li>
    <li>✅ Architect's site visit schedule agreed in writing</li>
    <li>✅ Your own contact list: contractor's direct number, site foreman, engineer</li>
  </ul>
  <p>Missing even one of these has derailed projects we've seen. The good news: all of them are fixable before you start, and none are hard to fix at this stage.</p>
  <p>Next email: how to choose a contractor in Uganda — beyond accepting the cheapest quote.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "How to choose a contractor in Uganda — beyond the cheapest quote",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>The contractor decision is the single most consequential choice in your project. Choose well and you get quality work, honest reporting, and a building you're proud of. Choose poorly and no amount of good design or careful budgeting will save you.</p>
  <h3 style="color:#2c5f2e">Visit Their Current Site</h3>
  <p>Don't just look at photos — visit a site they're actively working on. Is it organised? Is the scaffolding solid? Are workers wearing safety boots? Is the foreman present and clearly in charge? A chaotic site produces a chaotic building.</p>
  <h3 style="color:#2c5f2e">Talk to a Previous Client</h3>
  <p>Ask for three recent client references and call all three. Ask specifically: "Did they finish on time? Did the final cost match the quote? Would you hire them again?" One enthusiastic reference can be coached; three honest ones can't.</p>
  <h3 style="color:#2c5f2e">Check Their Subcontractor Network</h3>
  <p>Most general contractors subcontract electrical and plumbing. Ask who their subcontractors are and whether they're registered. A good general contractor has long-term relationships with competent subs; a weak one will find whoever is cheap and available when the time comes.</p>
  <h3 style="color:#2c5f2e">Understand Their Payment Expectations</h3>
  <p>Legitimate contractors expect milestone-based payments — foundation complete, walling complete, roof on, finishes complete. Be very cautious of any contractor who asks for 50% or more upfront before work begins. That's the structure of a scam, not a contract.</p>
  <h3 style="color:#2c5f2e">The Cheapest Quote</h3>
  <p>The lowest quote is almost never the best value. It's either missing scope, underpricing labour (meaning workers won't be paid on time and will abandon the site), or loss-leader pricing designed to generate variations. Budget to the mid-range of serious tenders, not the bottom.</p>
  <p>Next email: the specific contract clauses that protect your money and your timeline.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "The contract clauses that protect your money on a Uganda build",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>A construction contract doesn't need to be long. But it needs certain clauses. Without them, you have no legal basis for action when things go wrong — and they always go at least a little wrong. Here's what to insist on.</p>
  <h3 style="color:#2c5f2e">1. Scope of Works with BOQ Reference</h3>
  <p>The contract must specifically reference the approved drawings and BOQ as the defined scope. "Build a 3-bedroom house" is not a scope — it's an invitation to dispute everything.</p>
  <h3 style="color:#2c5f2e">2. Milestone-Based Payment Schedule</h3>
  <p>Payments tied to measurable milestones: foundation at DPC level (20%), walling at lintel level (20%), roof complete (15%), plastering and screed complete (15%), finishes complete (20%), practical completion and snag sign-off (10%). Adjust percentages to your project; the principle is the same.</p>
  <h3 style="color:#2c5f2e">3. Variation Order Procedure</h3>
  <p>Any change to the original scope must be documented as a Variation Order (VO), priced before the work starts, and signed by both parties. No signed VO = no obligation to pay for the extra. This single clause prevents most construction disputes.</p>
  <h3 style="color:#2c5f2e">4. Defects Liability Period</h3>
  <p>A 12-month defects liability period after practical completion, during which the contractor must fix any defects at their own cost. Withhold 5–10% of the final payment until the defects period expires without outstanding issues.</p>
  <h3 style="color:#2c5f2e">5. Dispute Resolution</h3>
  <p>Specify arbitration in Uganda before litigation. Nominate an arbitrator (e.g. the Uganda Institution of Professional Engineers UIPE, or a named arbitrator you both agree on). Courts are slow; arbitration is faster and cheaper.</p>
  <p>Next email: one conversation that could save you millions — how Serene Creations can support your build from here.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Starting construction soon? Let's connect before you do",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>I've shared a pre-construction checklist, how to evaluate contractors, and the contract clauses that protect you. All of this is useful background — but the most valuable thing we can offer right now is a direct conversation about your specific situation.</p>
  <h3 style="color:#2c5f2e">Where We Can Help</h3>
  <ul>
    <li><strong>Construction drawings review</strong> — if you have existing plans, we can assess whether they're complete enough to build from and flag any missing details that will generate costly variations</li>
    <li><strong>BOQ and tender management</strong> — prepare your BOQ and manage the contractor tender process, ensuring you're comparing like-for-like</li>
    <li><strong>Site supervision</strong> — periodic or full-time site visits to monitor quality, progress, and adherence to specification</li>
    <li><strong>Contract review</strong> — check the contractor's proposed agreement before you sign</li>
  </ul>
  <h3 style="color:#2c5f2e">The Value of Independent Oversight</h3>
  <p>Your contractor, however excellent, has a natural incentive to maximise their margin. An independent professional working for you alone — reviewing invoices, checking work against drawings, approving payment milestones — typically saves clients 10–20% of construction cost in prevented overruns and quality failures. That's rarely a bad return on supervision fees.</p>
  <p>Reply to this email or call <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a> to speak directly with our team.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "rental-property": {
    name: "Rental Property Development in Uganda",
    emails: [
      {
        delayDays: 0,
        subject: "Rental property in Uganda: what yields are actually realistic in 2026?",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Rental property in Uganda can be an excellent long-term investment — but the numbers matter. Let me give you a realistic picture of what yields look like in 2026, and what drives them up or down.</p>
  <h3 style="color:#2c5f2e">Typical Gross Yields by Property Type</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr style="background:#f5f5f0"><th style="padding:8px;text-align:left;border:1px solid #ddd">Property Type</th><th style="padding:8px;text-align:right;border:1px solid #ddd">Gross Yield</th><th style="padding:8px;text-align:right;border:1px solid #ddd">Key Market</th></tr>
    <tr><td style="padding:8px;border:1px solid #ddd">Self-contained units (1 bed)</td><td style="padding:8px;text-align:right;border:1px solid #ddd">10–16%</td><td style="padding:8px;text-align:right;border:1px solid #ddd">Kampala suburbs</td></tr>
    <tr style="background:#f9f9f9"><td style="padding:8px;border:1px solid #ddd">2–3 bed apartments</td><td style="padding:8px;text-align:right;border:1px solid #ddd">8–13%</td><td style="padding:8px;text-align:right;border:1px solid #ddd">Ntinda, Najjera, Kyanja</td></tr>
    <tr><td style="padding:8px;border:1px solid #ddd">Standalone 3-bed house</td><td style="padding:8px;text-align:right;border:1px solid #ddd">5–9%</td><td style="padding:8px;text-align:right;border:1px solid #ddd">Wakiso, Entebbe</td></tr>
    <tr style="background:#f9f9f9"><td style="padding:8px;border:1px solid #ddd">Commercial ground floor + residential above</td><td style="padding:8px;text-align:right;border:1px solid #ddd">12–18%</td><td style="padding:8px;text-align:right;border:1px solid #ddd">High-traffic corridors</td></tr>
  </table>
  <p style="font-size:13px;color:#666;margin-top:4px">*Gross yield = annual rent ÷ total development cost. Net yield after management, maintenance, and void periods is typically 20–30% lower.</p>
  <h3 style="color:#2c5f2e">What Drives Yield Up</h3>
  <ul>
    <li><strong>Self-contained units</strong> — each unit pays its own utilities; lower tenant friction and faster re-letting</li>
    <li><strong>Proximity to employment nodes</strong> — proximity to Kampala CBD, hospitals, universities drives tenant demand</li>
    <li><strong>Low maintenance specification</strong> — tiled floors, simple fixtures, no carpets or wallpaper</li>
    <li><strong>Security and parking</strong> — a perimeter wall, gate, and adequate parking are now baseline expectations for most tenants</li>
  </ul>
  <p>Next email: how to design rental units for maximum occupancy and minimum maintenance cost.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "How to design Uganda rental units that tenants stay in longer",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Rental yield depends on two things: rental income and occupancy rate. Design decisions at the building stage directly affect both. Here's how to optimise your rental development before construction begins.</p>
  <h3 style="color:#2c5f2e">Unit Mix: Smaller Units, Higher Total Return</h3>
  <p>On a 50×100ft plot, four self-contained one-bedroom units generate more total rent than one large four-bedroom house — even at a lower rent per unit. Smaller units have a larger tenant pool, shorter re-letting periods, and lower individual tenant risk. For pure investment returns, resist the temptation to build the large house.</p>
  <h3 style="color:#2c5f2e">Design Every Unit for Practical Use</h3>
  <ul>
    <li><strong>Separate kitchen</strong> — open-plan is unsuitable for rental tenants cooking with charcoal or heavy spices</li>
    <li><strong>Dedicated storage</strong> — even a 1m deep closet per bedroom dramatically reduces tenant dissatisfaction</li>
    <li><strong>Own meter per unit</strong> — pre-paid electricity meters eliminate utility disputes between tenants and landlord; pay once during construction, save years of arguments</li>
    <li><strong>Private outdoor space</strong> — even a 2×2m balcony or yard per unit gives tenants somewhere to dry clothes and cook; units without this have higher turnover</li>
  </ul>
  <h3 style="color:#2c5f2e">Materials: Choose for Longevity, Not Cheapness</h3>
  <p>The cost difference between standard and cheap materials at construction time is 5–15%. The cost difference in maintenance over 10 years is enormous. For rental property specifically: hardwood window frames (not softwood), ceramic or porcelain floor tiles (not vinyl), glazed wall tiles in kitchens and bathrooms, and durable paints on external walls. These choices pay for themselves within 3–5 years of reduced maintenance.</p>
  <h3 style="color:#2c5f2e">Security as a Differentiator</h3>
  <p>In middle-income rental markets, tenants will pay 15–25% more for a compound with controlled access, CCTV at the gate, and adequate lighting. This costs far less to build properly from the start than to retrofit.</p>
  <p>Next email: financing your Uganda rental development — what options exist beyond cash.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "Financing your Uganda rental development: what's actually available",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Most rental property in Uganda is financed from personal savings — and that's often the right choice, given interest rates. But there are alternatives worth understanding, especially if you're building at scale or want to accelerate.</p>
  <h3 style="color:#2c5f2e">Option 1: Phased Self-Finance</h3>
  <p>Build one or two units first, rent them, use rental income to fund the next phase. This is slower but zero-risk. A 4-unit development built in two phases over 3 years is better than a 4-unit development half-finished because funds ran out.</p>
  <h3 style="color:#2c5f2e">Option 2: Bank Mortgage (Construction Loan)</h3>
  <p>Several Ugandan banks offer construction financing against land title — Stanbic, dfcu, Equity, Absa, and others. Rates currently run <strong>18–24% per annum</strong> in UGX. At those rates, a rental project only makes financial sense if your gross yield substantially exceeds your borrowing cost. Run the numbers honestly before committing.</p>
  <h3 style="color:#2c5f2e">Option 3: Diaspora Remittance Strategy</h3>
  <p>For Ugandan diaspora investors, combining remittance savings with a smaller local bank loan (to cover the portion you can demonstrate rental income against) is a common structure. The key is to build only to the extent you can service debt from confirmed rent, not projected rent.</p>
  <h3 style="color:#2c5f2e">Option 4: Joint Venture</h3>
  <p>If you have land but limited construction capital, a joint venture with an investor or a build-to-rent developer can work — you contribute the land, they contribute the construction cost, you share the rental income and eventual sale proceeds. These require careful legal structuring; never do one without a registered advocate reviewing the agreement.</p>
  <p>Next email: a free investor consultation — how Serene Creations can help you plan and execute your rental development.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Ready to plan your Uganda rental development? Let's talk numbers",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Over the past two weeks I've shared realistic yield benchmarks, design principles for higher occupancy, and financing options for rental development. The next step is applying all of this to your specific land, budget, and investment goals.</p>
  <h3 style="color:#2c5f2e">What a Free Investor Consultation Covers</h3>
  <ul>
    <li>Plot assessment — site size, zoning, and allowable development density</li>
    <li>Unit mix recommendation based on your location and target market</li>
    <li>Preliminary development cost estimate</li>
    <li>Projected rental income and indicative yields</li>
    <li>Phasing options if you want to build in stages</li>
  </ul>
  <h3 style="color:#2c5f2e">What We Need from You</h3>
  <ul>
    <li>Your plot size and location</li>
    <li>Land title status</li>
    <li>Your total investment budget (construction only, excluding land)</li>
    <li>Target tenant type — students, families, professionals, expatriates?</li>
  </ul>
  <p>We work with rental developers at every scale — from a first 4-unit block to multi-building mixed-use developments. Every project starts with the same honest conversation about what the numbers actually look like.</p>
  <p>Reply to this email, call <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a>, or book a consultation at <a href="https://serenecreations.org/contact" style="color:#2c5f2e">serenecreations.org/contact</a>.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "land-buyer": {
    name: "Land Buyer Preparation Series",
    emails: [
      {
        delayDays: 0,
        subject: "Bought land in Uganda? Here's what to check before you build",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Owning land is the first step toward building. But several due diligence steps between purchase and construction can save you from expensive surprises — or worse, building on land with legal complications. Here's the checklist.</p>
  <h3 style="color:#2c5f2e">1. Confirm the Title is Clean</h3>
  <p>Have your advocate conduct a search at the Ministry of Lands (or the relevant Zonal Land Office) to confirm:</p>
  <ul>
    <li>The title is genuine and not a forgery</li>
    <li>There are no caveats, encumbrances, or mortgages registered against it</li>
    <li>The registered owner matches who sold it to you</li>
    <li>The plot boundaries on the title match what you were shown on the ground</li>
  </ul>
  <h3 style="color:#2c5f2e">2. Confirm the Zoning</h3>
  <p>Check the Physical Development Plan for your area. Your plot may be zoned residential, commercial, agricultural, or mixed-use — and that determines what you can build, how tall, and how much of the plot you can cover. An architect or town planner can pull this for you from the relevant authority.</p>
  <h3 style="color:#2c5f2e">3. Peg and Survey the Boundaries</h3>
  <p>Before any construction begins, have a licensed surveyor peg the exact corners of your plot. This prevents boundary disputes with neighbours and ensures your building setbacks are calculated from the correct boundary, not an assumed one. Survey certificate copies should be lodged with your building approval.</p>
  <h3 style="color:#2c5f2e">4. Check Service Availability</h3>
  <p>Confirm proximity and cost of: NWSC water connection, UMEME electricity (is there a transformer nearby, or will you pay a large contribution?), road access (gravel or tarmac, and who maintains it?). These affect both construction logistics and long-term livability.</p>
  <p>Next email: how to read a Uganda land title — and the most common fraud types to watch for.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "How to read a Uganda land title — and the fraud types that catch people out",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Uganda has multiple land tenure types, and understanding what you have — and what it means — is essential before you build. Here's a plain-language guide.</p>
  <h3 style="color:#2c5f2e">The Four Tenure Types</h3>
  <ul>
    <li><strong>Freehold</strong> — outright ownership in perpetuity. The strongest title. Can be mortgaged, subdivided, and passed to heirs without restriction.</li>
    <li><strong>Mailo</strong> — a Buganda-specific tenure where the registered owner holds the land but lawful occupants (kibanja holders) have use rights. Complex — always involve an advocate before building if there's a kibanja occupant.</li>
    <li><strong>Leasehold</strong> — a registered long lease, typically 49 or 99 years from the Uganda Land Commission or local authority. Renewable. Common in Kampala and towns. Confirm the unexpired term before buying or building — a lease with less than 20 years remaining significantly limits your financing options.</li>
    <li><strong>Customary</strong> — communal tenure, unregistered. Not suitable as a mortgage security. If you're buying customary land, convert it to freehold or leasehold before building a permanent structure.</li>
  </ul>
  <h3 style="color:#2c5f2e">Common Fraud Patterns</h3>
  <ul>
    <li><strong>Forged titles</strong> — photocopied or reprinted titles with altered details. Always do an official Ministry of Lands search; do not rely on a copy shown by the seller.</li>
    <li><strong>Sold by the wrong person</strong> — the seller presents power of attorney that is forged or expired. Verify any power of attorney independently.</li>
    <li><strong>Double-sold plots</strong> — the same plot sold to two buyers. Whoever registers first wins. Register your transfer immediately after completion.</li>
    <li><strong>Boundary misrepresentation</strong> — you are shown a neighbouring (larger or better-located) plot, then the transaction is executed for a different plot number.</li>
  </ul>
  <p>None of these are obscure risks — they're reported regularly. An advocate and a Ministry search cost very little relative to the land price. Use both every time.</p>
  <p>Next email: soil survey and site assessment — why it matters before you design.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "Soil survey and site assessment: what to check before you design",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>Most homeowners in Uganda skip the soil survey. It feels like an unnecessary cost — until they're halfway through foundation construction and discover black cotton soil, a high water table, or old fill that can't support a standard strip foundation. Here's what a proper site assessment covers and why it matters.</p>
  <h3 style="color:#2c5f2e">What Soil Survey Includes</h3>
  <ul>
    <li><strong>Trial pits</strong> — hand-dug or machine-excavated pits at 3–5 positions across the plot to expose the soil profile at foundation depth</li>
    <li><strong>Soil identification</strong> — black cotton soil (expansive clay), murram, laterite, made ground (fill), or rock. Each requires a different foundation approach.</li>
    <li><strong>Water table depth</strong> — if groundwater is within 1–1.5m of surface, you need a waterproofed or elevated foundation strategy</li>
    <li><strong>Bearing capacity estimate</strong> — the load the soil can carry per m², which directly determines your foundation type and dimensions</li>
  </ul>
  <h3 style="color:#2c5f2e">What Poor Soil Means for Your Budget</h3>
  <p>A standard strip foundation works on good bearing soil. On poor or expansive soil you may need: a raft (floating slab) foundation, driven or bored piles, or extensive soil replacement. Each adds UGX 15–50M to foundation cost. Knowing this before you design means your architect can optimise the structural scheme for the soil condition rather than discovering the problem after the foundation work has begun.</p>
  <h3 style="color:#2c5f2e">The Slope and Drainage Assessment</h3>
  <p>A site visit by your engineer before design should also document: natural drainage paths (where does rain runoff go?), slope direction and gradient, any existing trees with deep roots near the proposed building line, and flood risk from neighbouring plots or roads.</p>
  <p>A soil investigation for a standard residential plot typically costs <strong>UGX 1.5–3.5M</strong>. It's money you cannot afford not to spend.</p>
  <p>Next email: your land is ready — here's how to move forward into design and approvals with Serene Creations.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Your land is ready — let's design your home",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>I've walked you through land title due diligence, fraud prevention, and site assessment. If you've worked through that checklist and your land is confirmed clear, you're ready for the design phase — the part where your vision starts to become a real building.</p>
  <h3 style="color:#2c5f2e">The Design Journey from Here</h3>
  <ol>
    <li><strong>Design brief</strong> — we document your requirements, lifestyle, and priorities in detail</li>
    <li><strong>Concept design</strong> — floor plan options, with 3D visualisations so you can feel the spaces before anything is built</li>
    <li><strong>Design development</strong> — refine the chosen concept into a fully resolved scheme</li>
    <li><strong>Working drawings</strong> — the complete set required for building approval and construction</li>
    <li><strong>Approvals submission</strong> — we manage the submission and follow-up</li>
    <li><strong>BOQ preparation</strong> — detailed bill of quantities for contractor tendering</li>
  </ol>
  <h3 style="color:#2c5f2e">AI Architecture Studio</h3>
  <p>Before committing to a full design engagement, explore what's possible on your plot with our AI Architecture Studio at <a href="https://serenecreations.org" style="color:#2c5f2e">serenecreations.org</a>. Generate design visualisations in seconds, try different styles and configurations, and arrive at your brief with confidence.</p>
  <h3 style="color:#2c5f2e">Free Initial Consultation</h3>
  <p>Book a free 30-minute consultation with our team — bring your title document, any survey records, and your brief notes. We'll give you an honest assessment of what's achievable, a clear timeline, and a fee proposal.</p>
  <ul>
    <li>📞 <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a></li>
    <li>🌐 <a href="https://serenecreations.org/contact" style="color:#2c5f2e">serenecreations.org/contact</a></li>
  </ul>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "re-engage": {
    name: "Dormant Lead Re-engagement",
    emails: [
      {
        delayDays: 0,
        subject: "Still thinking about building? Here's what's changed in Uganda construction",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>It's been a while since we were in touch. Building projects get put on hold — that's completely normal. Sometimes finances need time to accumulate. Sometimes the right plot takes time to find. Sometimes life just intervenes.</p>
  <p>If you're still thinking about building — or starting to think about it again — I wanted to share a few things that have changed recently that might affect your planning.</p>
  <h3 style="color:#2c5f2e">Construction Costs in 2026</h3>
  <p>Material costs have stabilised after significant increases in 2023–2024. Cement prices have moderated; steel is broadly flat. Labour costs in Kampala and Wakiso have continued to rise. Overall, a well-managed project in 2026 can be executed at broadly similar costs to 2024 in real terms — the crisis-level premiums have largely passed.</p>
  <h3 style="color:#2c5f2e">What's New at Serene Creations</h3>
  <ul>
    <li>Our <strong>AI Architecture Studio</strong> is now live — explore design possibilities for your plot before committing to a full design brief</li>
    <li>We've expanded our <strong>site supervision</strong> service to peri-urban areas (Mukono, Masaka road corridor, Entebbe road)</li>
    <li>We now offer <strong>phased project planning</strong> — detailed guidance on how to build in stages as your finances allow, without compromising the final result</li>
  </ul>
  <p>No ask today — just an update in case your plans are moving again. Reply to this email if you'd like to pick up the conversation.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "The real cost of waiting to build in Uganda",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>I don't want to pressure you — but I do want to share an honest calculation that often changes how people think about timing their project.</p>
  <h3 style="color:#2c5f2e">The Inflation Argument</h3>
  <p>Construction costs in Uganda have averaged roughly <strong>8–12% annual increase</strong> in UGX terms over the past decade (materials, labour, and professional fees combined). That means a project costing UGX 250M today may cost UGX 275–280M in 12 months if you wait. The money you've saved doesn't necessarily grow at the same rate.</p>
  <h3 style="color:#2c5f2e">The Rent-vs-Build Calculation</h3>
  <p>If you're currently renting while saving to build, consider: every month of rent is a month of permanent housing cost you'll never recover. A family paying UGX 1.5M/month in rent over 5 years spends UGX 90M — money that could have been building equity in their own property instead.</p>
  <h3 style="color:#2c5f2e">Phased Building as an Alternative to Waiting</h3>
  <p>You don't have to wait until you have the full construction budget. A well-planned phased build — structure complete first, finishes later — lets you start now at a lower initial cost, move in at shell stage, and complete finishes as funds become available. We've helped dozens of clients do exactly this.</p>
  <p>The question is never just "can I afford to build?" — it's also "what does waiting actually cost?"</p>
  <p>Happy to run the numbers with you. Just reply or call <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a>.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "Where are you in your building journey? We'd love to hear",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>No new information today — just a genuine check-in. We've shared a lot over the past few emails and I don't want to keep sending material if your situation has changed or if what we're sending isn't useful right now.</p>
  <p>If you're open to it, a one-line reply would be genuinely helpful:</p>
  <ul>
    <li>"Still planning but not ready yet" — and we'll keep the updates light and infrequent</li>
    <li>"My project is on hold until [timeframe]" — and we'll check back then</li>
    <li>"I'm actually ready to move forward" — and we'll get on a call this week</li>
    <li>"Not planning to build anymore" — and we'll stop sending and wish you well</li>
  </ul>
  <p>There's no wrong answer. We'd just rather have a real conversation than send emails into the void.</p>
  <p>Either way, if you ever want to talk about your project — even just to think through the numbers or options — we're available. No obligation, no pressure.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "A final note — and an open invitation",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>This is the last email in this series from me. I won't keep sending if there's been no response — that's not how we want to show up in your inbox.</p>
  <p>But I do want to leave one thing on the table: <strong>the invitation is always open</strong>.</p>
  <p>Whether your project is 3 months away or 3 years away, we're here when you're ready. Building a home or an investment property is a significant undertaking, and having a professional you trust on your side from the beginning makes a real difference to the outcome.</p>
  <h3 style="color:#2c5f2e">What We Offer</h3>
  <ul>
    <li>Free initial consultation — no commitment required</li>
    <li>Preliminary cost estimation — get a realistic number before you commit to anything</li>
    <li>AI Architecture Studio — explore design options for your plot at no cost</li>
    <li>Full design and approvals service when you're ready</li>
  </ul>
  <p>
    📞 <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a><br>
    🌐 <a href="https://serenecreations.org" style="color:#2c5f2e">serenecreations.org</a><br>
    ✉️ <a href="mailto:info@serenecreations.org" style="color:#2c5f2e">info@serenecreations.org</a>
  </p>
  <p>Wishing you the best with your plans, whenever you're ready to move them forward.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
    ],
  },

  "past-client": {
    name: "Past Client Referral & Return Business",
    emails: [
      {
        delayDays: 0,
        subject: "Thank you for building with us — and a small favour",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>It's been some time since we worked together, and I hope you and your family are well and enjoying your home.</p>
  <p>I wanted to reach out for two reasons. First, simply to say thank you — clients who trust us with a project as personal as their home are the reason Serene Creations exists, and we don't take that lightly.</p>
  <p>Second, a small favour to ask: <strong>do you know someone who is thinking about building in Uganda?</strong> A friend planning a home, a family member looking at rental units, a colleague who's been talking about buying land?</p>
  <p>The most valuable thing you can do for someone going into construction is connect them with professionals they can trust before they make decisions that are hard to undo. If you're happy with the work we did together, a simple introduction would mean a lot to us — and could make a real difference for them.</p>
  <p>All they need to do is reply to this email, call <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a>, or mention your name when they get in touch and we'll give them the same attention we gave you.</p>
  <p>Thank you again.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 3,
        subject: "How to refer a friend to Serene Creations (and why it helps them)",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>A quick follow-up to my last message. The single most common feedback we get from clients who referred someone is: "I wish I'd connected them sooner."</p>
  <p>The reason: the decisions made in the first few weeks of a building project — before any contractor is engaged, before any drawings are commissioned, even before a plot is purchased — have the biggest impact on the final outcome. And most people make those early decisions without professional input.</p>
  <h3 style="color:#2c5f2e">What Your Referral Gets</h3>
  <p>Anyone you send to us will receive a <strong>free initial consultation</strong> — a genuine professional conversation about their project, their budget, and what's realistically achievable. No sales pressure. No commitment required. Just honest guidance from people who know Uganda construction well.</p>
  <h3 style="color:#2c5f2e">The Easiest Way to Refer</h3>
  <p>Forward this email to them, or share our contact details:</p>
  <ul>
    <li>📞 <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a></li>
    <li>🌐 <a href="https://serenecreations.org" style="color:#2c5f2e">serenecreations.org</a></li>
  </ul>
  <p>Ask them to mention your name — it ensures we know to give them particular care.</p>
  <p>Thank you for thinking of us.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 7,
        subject: "What's new at Serene Creations — things that might interest you",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>In case it's useful, here's a brief update on what we've been working on since we last spoke.</p>
  <h3 style="color:#2c5f2e">AI Architecture Studio</h3>
  <p>We've launched an AI-powered design tool at <a href="https://serenecreations.org" style="color:#2c5f2e">serenecreations.org</a> that lets anyone explore architectural possibilities for their plot — generate visualisations instantly, try different styles and configurations, and use the results to refine a design brief. It's free to use and takes minutes, not weeks.</p>
  <h3 style="color:#2c5f2e">Site Supervision Services</h3>
  <p>We've expanded our site supervision offering to cover more of the greater Kampala area including Mukono, Masaka road, and Entebbe road corridor. If you or anyone you know is building in those areas and needs independent oversight, we can help.</p>
  <h3 style="color:#2c5f2e">Rental Development Planning</h3>
  <p>We now offer a dedicated investor consultation for those considering rental property — unit mix optimisation, yield modelling, and phased development planning.</p>
  <p>If any of these are relevant to your next project — an extension, a staff quarter, a rental block — we'd love to work with you again.</p>
  ${EMAIL_SIGNATURE}
</div>`,
      },
      {
        delayDays: 14,
        subject: "Thinking about extending, developing, or building again?",
        html: (name) => `
<div style="font-family:Georgia,serif;max-width:620px;margin:0 auto;color:#222;line-height:1.7">
  <p>Hi ${name || "there"},</p>
  <p>As time passes after a build, many of our clients start thinking about the next phase — an extension to the existing house, staff quarters or a guard's house on the plot, rental units on the remaining land, or a completely separate new project.</p>
  <p>If any of that sounds like where your thinking is going, we'd love to be part of it again.</p>
  <h3 style="color:#2c5f2e">For Existing Clients, We Offer</h3>
  <ul>
    <li><strong>Extension and renovation drawings</strong> — working from our knowledge of your existing building, which saves time and ensures the extension is designed to match</li>
    <li><strong>Post-occupancy review</strong> — a site visit to review the completed building and document any defects or snags still outstanding under your contractor's defects liability period</li>
    <li><strong>New project on the same plot</strong> — additional units, staff housing, or income-generating improvements</li>
  </ul>
  <h3 style="color:#2c5f2e">Pick Up the Conversation</h3>
  <p>Reply to this email with whatever you're considering — even if it's just an early idea — or call us directly:</p>
  <ul>
    <li>📞 <a href="tel:+256783691337" style="color:#2c5f2e">+256 783 691337</a></li>
    <li>✉️ <a href="mailto:info@serenecreations.org" style="color:#2c5f2e">info@serenecreations.org</a></li>
  </ul>
  <p>It's always good to work with people we already know.</p>
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
  // Original sequences
  "blog-costs-uganda":       "costs-uganda",
  "blog-approvals-uganda":   "approvals-uganda",
  "blog-smart-design":       "smart-design-uganda",
  "blog-build-planning":     "build-planning-uganda",
  "widget-costs":            "costs-uganda",
  "widget-approvals":        "approvals-uganda",
  "widget-build-planning":   "build-planning-uganda",
  "studio-promo":            "costs-uganda",

  // BOQ & Cost Follow-Up
  "blog-boq":                "boq-follow-up",
  "blog-bill-of-quantities": "boq-follow-up",
  "widget-boq":              "boq-follow-up",
  "form-boq":                "boq-follow-up",

  // House Plan & Design Nurture
  "blog-house-design":       "house-design-nurture",
  "blog-floor-plans":        "house-design-nurture",
  "widget-design":           "house-design-nurture",
  "form-design":             "house-design-nurture",

  // Construction Readiness
  "blog-construction":       "construction-ready",
  "blog-contractors":        "construction-ready",
  "widget-construction":     "construction-ready",
  "form-construction":       "construction-ready",

  // Rental Property Development
  "blog-rental":             "rental-property",
  "blog-investment":         "rental-property",
  "widget-rental":           "rental-property",
  "form-rental":             "rental-property",

  // Land Buyer Preparation
  "blog-land":               "land-buyer",
  "blog-land-title":         "land-buyer",
  "widget-land":             "land-buyer",
  "form-land":               "land-buyer",

  // Dormant Lead Re-engagement (triggered programmatically, not by source)
  "re-engage-dormant":       "re-engage",

  // Past Client Referral (triggered programmatically after project completion)
  "past-client-followup":    "past-client",
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

      // Skip unsubscribed contacts
      if (sub.unsubscribed) {
        await doc.ref.update({ completed: true });
        return;
      }

      const stage = sub.stage || 0;
      const emailDef = campaign.emails[stage];
      if (!emailDef) {
        await doc.ref.update({ completed: true });
        return;
      }

      const token = Buffer.from(doc.id).toString("base64url");
      const unsubUrl = `https://us-central1-serene-arch-studio.cloudfunctions.net/unsubscribeEmail?token=${encodeURIComponent(token)}`;

      try {
        await mailer.sendMail({
          from: FROM_EMAIL,
          to: sub.email,
          replyTo: REPLY_TO,
          subject: emailDef.subject,
          html: emailDef.html(sub.name || "") + UNSUB_FOOTER(unsubUrl),
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

// ─── 13. unsubscribeEmail ────────────────────────────────────────────────────
exports.unsubscribeEmail = functions.https.onRequest(async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("Invalid unsubscribe link.");
  try {
    const docId = Buffer.from(token, "base64url").toString("utf8");
    const ref = db.collection("campaignSubscriptions").doc(docId);
    await ref.update({
      unsubscribed: true,
      unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
      completed: true,
    });
    return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Unsubscribed — Serene Creations</title>
  <style>
    body { font-family: Georgia, serif; max-width: 580px; margin: 80px auto; padding: 0 24px;
           color: #222; text-align: center; }
    h2  { color: #2c5f2e; font-size: 1.6rem; margin-bottom: 12px; }
    p   { line-height: 1.7; color: #555; }
    a   { color: #2c5f2e; }
  </style>
</head>
<body>
  <h2>You've been unsubscribed</h2>
  <p>You won't receive any more emails from this series.</p>
  <p>If this was a mistake, reply to any of our emails or write to us at
     <a href="mailto:info@serenecreations.org">info@serenecreations.org</a> and we'll
     re-add you.</p>
  <p><a href="https://serenecreations.org">Return to serenecreations.org</a></p>
</body>
</html>`);
  } catch (err) {
    functions.logger.error("unsubscribeEmail error", { err: err.message });
    return res.status(500).send(
      "Something went wrong. Please contact info@serenecreations.org to unsubscribe manually."
    );
  }
});

// ─── 14. chatbaseWebhook ─────────────────────────────────────────────────────
// Receives POST from Chatbase conversation webhooks.
// Extracts email + name from the conversation, resolves campaign from topic,
// and enrolls the lead via subscribeToCampaign logic.
//
// Chatbase webhook payload shape (subset we use):
//   { conversation: { id, messages: [{ role, content }] },
//     customer: { email, name } }          ← populated if user typed email
//
// Configure in Chatbase dashboard → Integrations → Webhooks → POST to:
//   https://us-central1-serene-arch-studio.cloudfunctions.net/chatbaseWebhook
// ─────────────────────────────────────────────────────────────────────────────

const CHATBASE_TOPIC_MAP = {
  "cost":          "costs-uganda",
  "price":         "costs-uganda",
  "budget":        "costs-uganda",
  "quote":         "costs-uganda",
  "boq":           "boq-follow-up",
  "quantities":    "boq-follow-up",
  "bill":          "boq-follow-up",
  "design":        "house-design-nurture",
  "plan":          "house-design-nurture",
  "floor":         "house-design-nurture",
  "architect":     "house-design-nurture",
  "construction":  "construction-ready",
  "build":         "construction-ready",
  "contractor":    "construction-ready",
  "approval":      "approvals-uganda",
  "permit":        "approvals-uganda",
  "council":       "approvals-uganda",
  "rental":        "rental-property",
  "investment":    "rental-property",
  "tenant":        "rental-property",
  "land":          "land-buyer",
  "plot":          "land-buyer",
  "title":         "land-buyer",
};

function resolveCampaignFromText(text) {
  const lower = (text || "").toLowerCase();
  for (const [keyword, campaign] of Object.entries(CHATBASE_TOPIC_MAP)) {
    if (lower.includes(keyword)) return campaign;
  }
  return "costs-uganda"; // default
}

exports.chatbaseWebhook = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Chatbase-Signature");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body || {};

    // Extract customer info — Chatbase puts it under different shapes depending on version
    const customer = body.customer || body.user || {};
    const conversation = body.conversation || body.chat || {};
    const messages = Array.isArray(conversation.messages)
      ? conversation.messages
      : (Array.isArray(body.messages) ? body.messages : []);

    // Try to extract email — from customer object first, then scan message text
    let email = customer.email || null;
    let name  = customer.name  || customer.displayName || null;

    if (!email) {
      const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
      for (const msg of messages) {
        const content = (msg.content || msg.text || "");
        const match = content.match(emailRe);
        if (match) { email = match[0]; break; }
      }
    }

    if (!email) {
      functions.logger.info("chatbaseWebhook: no email found, skipping", { body });
      return res.status(200).json({ status: "no_email" });
    }

    // Resolve campaign from conversation content
    const allText = messages.map(m => m.content || m.text || "").join(" ");
    const campaignId = resolveCampaignFromText(allText);

    // Check for duplicate subscription
    const existing = await db.collection("campaignSubscriptions")
      .where("email", "==", email.toLowerCase().trim())
      .where("campaignId", "==", campaignId)
      .limit(1).get();

    if (!existing.empty) {
      functions.logger.info("chatbaseWebhook: already subscribed", { email, campaignId });
      return res.status(200).json({ status: "already_subscribed", campaignId });
    }

    // Enroll
    await db.collection("campaignSubscriptions").add({
      email:      email.toLowerCase().trim(),
      name:       name || "",
      campaignId,
      source:     "chatbase",
      enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
      nextEmailIndex: 0,
      unsubscribed: false,
    });

    // Also fire the lead hook so ActivePieces sees it
    const LEAD_HOOK_URL = "https://cloud.activepieces.com/api/v1/webhooks/gaqpTTBjcrwCpNPukckrm";
    axios.post(LEAD_HOOK_URL, {
      email, name, source: "chatbase", campaign: campaignId,
      conversationId: conversation.id || body.conversationId || "",
    }).catch(err => functions.logger.warn("chatbaseWebhook: lead hook failed", { err: err.message }));

    functions.logger.info("chatbaseWebhook: enrolled", { email, campaignId });
    return res.status(200).json({ status: "enrolled", campaignId });

  } catch (err) {
    functions.logger.error("chatbaseWebhook error", { err: err.message });
    return res.status(500).json({ error: "Internal error" });
  }
});
