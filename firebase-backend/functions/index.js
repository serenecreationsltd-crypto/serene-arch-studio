"use strict";

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG  —  set all secrets before deploying:
//
//   firebase functions:config:set \
//     replicate.token="r8_YOUR_TOKEN" \
//     replicate.model_version="HASH" \
//     smtp.password="j2ecJ7seT2Nu" \
//     stripe.secret="sk_live_YOUR_STRIPE_SECRET_KEY" \
//     stripe.webhook_secret="whsec_YOUR_STRIPE_WEBHOOK_SECRET"
//
// ═══════════════════════════════════════════════════════════════════════════
const cfg = functions.config();
const REPLICATE_TOKEN         = (cfg.replicate && cfg.replicate.token)         || "";
const REPLICATE_MODEL_VERSION = (cfg.replicate && cfg.replicate.model_version) ||
                                "TODO_REPLACE_WITH_REPLICATE_VERSION_HASH";

// Stripe — subscription tier management
const STRIPE_SECRET         = (cfg.stripe && cfg.stripe.secret)         || "";
const STRIPE_WEBHOOK_SECRET = (cfg.stripe && cfg.stripe.webhook_secret) || "";
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

/** Build a configured Zoho SMTP transporter. */
function getMailer() {
  const pass = (cfg.smtp && cfg.smtp.password) || "";
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
const STYLE_PROMPTS = {
  modernist:
    "ultra-modern minimalist architecture, clean geometric lines, " +
    "glass curtain walls, steel structure, open floor plan",
  biophilic:
    "biophilic architecture, organic curved shapes, natural materials, " +
    "living green walls, exposed timber, stone cladding",
  industrial:
    "industrial architecture, exposed raw concrete, structural steel beams, " +
    "warehouse conversion, polished concrete floors",
  mediterranean:
    "Mediterranean architecture, white lime-render walls, terracotta clay tiles, " +
    "arched doorways, blue accents, shaded courtyard",
  "afro-contemporary":
    "contemporary African architecture, warm earth tones, rammed earth walls, " +
    "geometric carved timber screens, vernacular materials",
};

const ENV_PROMPTS = {
  day:
    "bright midday sunlight, clear blue sky, crisp well-defined shadows, vibrant colors",
  "golden-hour":
    "golden hour warm lighting, amber and orange tones, long dramatic shadows, sunset glow",
  night:
    "night exterior, warm architectural lighting, softly glowing windows, " +
    "city ambient light, dramatic contrast",
  overcast:
    "soft overcast sky, even diffused lighting, muted palette, " +
    "no harsh shadows, photographic grey mood",
};

function buildPrompt(style, environment) {
  const s = STYLE_PROMPTS[style] || style || "modern architecture";
  const e = ENV_PROMPTS[environment] || environment || "daylight";
  return (
    `Photorealistic exterior architectural rendering, ${s}, ${e}, ` +
    "8K resolution, professional CGI visualization, award-winning architecture, " +
    "hyperrealistic materials, sharp focus, high dynamic range, " +
    "architectural photography"
  );
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
    const { uid, sourceURL, style, environment } = snap.data();
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
      const prompt = buildPrompt(style, environment);
      const { data: prediction } = await axios.post(
        "https://api.replicate.com/v1/predictions",
        {
          version: REPLICATE_MODEL_VERSION,
          input: {
            image:     sourceURL,
            prompt,
            negative_prompt:
              "deformed, ugly, bad anatomy, blurry, distorted, " +
              "cartoon, watermark, text, logo, oversaturated",
            controlnet_conditioning_scale: 0.8,
            strength:            0.75,
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
        style:       style       || "modernist",
        environment: environment || "day",
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
