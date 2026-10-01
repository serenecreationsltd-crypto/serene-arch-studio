/**
 * Serene Creations – Embeddable Widget v1.0
 * Drop one tag into serenecreations.org and get:
 *   1. "AI Architecture Studio" navigation tab
 *   2. Full consultation popup (8 services, dual-submit)
 *   3. Floating "Free Consultation" trigger button
 *
 * Usage:
 *   <script src="https://serene-arch-studio.web.app/serene-widget.js" defer></script>
 */
(function (root) {
  'use strict';

  /* ── CONSTANTS ─────────────────────────────────────────── */
  var STUDIO_URL       = 'https://serene-arch-studio.web.app/ai-studio.html';
  var CONTACT_ENDPOINT = 'https://us-central1-serene-arch-studio.cloudfunctions.net/contactFormSubmit';
  var LEAD_HOOK        = 'https://cloud.activepieces.com/api/v1/webhooks/gaqpTTBjcrwCpNPukckrm';

  var SERVICES = [
    { icon: '🏠', label: 'House Plans' },
    { icon: '🏢', label: 'Commercial Designs' },
    { icon: '🎨', label: '3D Renders' },
    { icon: '📐', label: 'Structural Drawings' },
    { icon: '🌿', label: 'Landscape Design' },
    { icon: '🏗️', label: 'Project Management' },
    { icon: '📏', label: 'Land Surveys & Plots' },
    { icon: '🤖', label: 'AI Architecture Studio' },
  ];

  /* ── CSS ────────────────────────────────────────────────── */
  var CSS = [
    /* nav tab */
    '.scw-nav-item a{color:inherit;text-decoration:none;transition:color .2s}',
    '.scw-nav-item a:hover{color:#2d6b45}',
    /* floating button */
    '#scw-trigger{position:fixed;bottom:28px;right:28px;z-index:99998;',
    'background:#2d6b45;color:#fff;border:none;border-radius:50px;',
    'padding:14px 24px;font:600 14px/1 system-ui,sans-serif;',
    'cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.28);',
    'transition:background .2s,transform .2s}',
    '#scw-trigger:hover{background:#1a4528;transform:translateY(-2px)}',
    /* overlay */
    '#scw-overlay{display:none;position:fixed;inset:0;z-index:99999;',
    'background:rgba(0,0,0,.6);backdrop-filter:blur(4px);align-items:center;justify-content:center}',
    '#scw-overlay.open{display:flex}',
    /* modal */
    '#scw-modal{background:#fff;border-radius:16px;width:min(92vw,680px);',
    'max-height:90vh;overflow-y:auto;padding:36px 40px;position:relative;',
    'box-shadow:0 24px 60px rgba(0,0,0,.28)}',
    '#scw-modal h2{margin:0 0 6px;font-size:1.5rem;color:#1a4528}',
    '#scw-modal .scw-sub{color:#555;margin:0 0 24px;font-size:.9rem}',
    /* services grid */
    '#scw-services{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:24px}',
    '.scw-svc{border:2px solid #dff0e5;border-radius:10px;padding:12px 10px;',
    'text-align:center;cursor:pointer;font-size:.82rem;font-weight:600;',
    'color:#256039;background:#f8fdf9;transition:border-color .15s,background .15s}',
    '.scw-svc:hover{border-color:#2d6b45;background:#dff0e5}',
    '.scw-svc.selected{border-color:#2d6b45;background:#2d6b45;color:#fff}',
    '.scw-svc .scw-icon{font-size:1.3rem;display:block;margin-bottom:5px}',
    /* form */
    '.scw-form-group{margin-bottom:16px}',
    '.scw-form-group label{display:block;font-weight:600;font-size:.85rem;color:#1a4528;margin-bottom:5px}',
    '.scw-form-group input,.scw-form-group textarea{width:100%;box-sizing:border-box;',
    'border:1.5px solid #cce4d6;border-radius:8px;padding:10px 12px;font-size:.9rem;',
    'outline:none;transition:border-color .2s;font-family:inherit}',
    '.scw-form-group input:focus,.scw-form-group textarea:focus{border-color:#2d6b45}',
    '.scw-form-group textarea{resize:vertical;min-height:90px}',
    '#scw-status{font-size:.85rem;color:#c0392b;margin-top:8px;min-height:20px}',
    /* buttons */
    '.scw-btn-green{background:#2d6b45;color:#fff;border:none;border-radius:8px;',
    'padding:13px 28px;font:700 .95rem/1 system-ui,sans-serif;cursor:pointer;',
    'width:100%;margin-top:6px;transition:background .2s}',
    '.scw-btn-green:hover{background:#1a4528}',
    '.scw-btn-green:disabled{background:#aaa;cursor:not-allowed}',
    '#scw-close{position:absolute;top:16px;right:20px;background:none;border:none;',
    'font-size:1.6rem;cursor:pointer;color:#666;line-height:1}',
    '#scw-close:hover{color:#1a4528}',
    /* success panel */
    '#scw-success{display:none;text-align:center;padding:30px 0}',
    '#scw-success.show{display:block}',
    '#scw-success .scw-tick{font-size:3rem;margin-bottom:12px}',
    '#scw-success h3{color:#1a4528;margin:0 0 8px}',
    '#scw-success p{color:#555;margin:0 0 20px;font-size:.9rem}',
    '.scw-btn-outline{background:none;border:2px solid #2d6b45;color:#2d6b45;',
    'border-radius:8px;padding:11px 24px;font:700 .9rem/1 system-ui,sans-serif;',
    'cursor:pointer;transition:background .2s,color .2s}',
    '.scw-btn-outline:hover{background:#2d6b45;color:#fff}',
  ].join('');

  /* ── POPUP HTML ─────────────────────────────────────────── */
  function buildPopupHTML() {
    var svcsHTML = SERVICES.map(function (s) {
      return '<button type="button" class="scw-svc" onclick="scwSelectSvc(this)" data-label="' +
        s.label + '"><span class="scw-icon">' + s.icon + '</span>' + s.label + '</button>';
    }).join('');

    return [
      '<div id="scw-overlay" role="dialog" aria-modal="true" aria-label="Free Consultation" onclick="scwOverlayClose(event)">',
      '<div id="scw-modal">',
      '  <button id="scw-close" onclick="scwClose()" aria-label="Close">&times;</button>',
      '  <div id="scw-form-panel">',
      '    <h2>Free Consultation</h2>',
      '    <p class="scw-sub">Tell us about your project — we\'ll reach out within 24 hours.</p>',
      '    <div id="scw-services">' + svcsHTML + '</div>',
      '    <form id="scw-form" onsubmit="scwSubmit(event)" novalidate>',
      '      <div class="scw-form-group"><label>Full Name *</label>',
      '        <input type="text" id="scw-name" placeholder="Your name" required></div>',
      '      <div class="scw-form-group"><label>Phone Number *</label>',
      '        <input type="tel" id="scw-phone" placeholder="+256 700 000 000" required></div>',
      '      <div class="scw-form-group"><label>Email Address</label>',
      '        <input type="email" id="scw-email" placeholder="you@example.com"></div>',
      '      <div class="scw-form-group"><label>Project Details</label>',
      '        <textarea id="scw-desc" placeholder="Size, location, budget, timeline…"></textarea></div>',
      '      <div id="scw-status"></div>',
      '      <button type="submit" id="scw-submit" class="scw-btn-green">Send Enquiry →</button>',
      '    </form>',
      '  </div>',
      '  <div id="scw-success">',
      '    <div class="scw-tick">✅</div>',
      '    <h3>Thank you! We\'ll be in touch.</h3>',
      '    <p>Our team will contact you within 24 hours to discuss your project.</p>',
      '    <button class="scw-btn-outline" onclick="scwClose()">Close</button>',
      '  </div>',
      '</div>',
      '</div>',
    ].join('');
  }

  /* ── FLOATING BUTTON HTML ───────────────────────────────── */
  function buildTriggerHTML() {
    return '<button id="scw-trigger" onclick="scwOpen()" aria-label="Open Free Consultation">💬 Free Consultation</button>';
  }

  /* ── NAV TAB INJECTION ──────────────────────────────────── */
  function injectNavTab() {
    var selectors = [
      'nav ul',
      '.navbar ul',
      '.nav ul',
      'header ul',
      '#menu ul',
      '#navigation ul',
      '[role="navigation"] ul',
      '.menu ul',
      '.main-menu ul',
    ];

    var target = null;
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) { target = el; break; }
    }

    if (!target) {
      // Fallback: append tab after any <nav> or <header>
      var nav = document.querySelector('nav') || document.querySelector('header');
      if (nav) {
        var ul = document.createElement('ul');
        ul.className = 'scw-nav-inject';
        ul.style.cssText = 'list-style:none;margin:0;padding:0;display:inline-flex;gap:16px';
        nav.appendChild(ul);
        target = ul;
      }
    }

    if (!target) return; // truly no nav found — floating button is still present

    var li = document.createElement('li');
    li.className = 'scw-nav-item';
    li.innerHTML = '<a href="' + STUDIO_URL + '" target="_blank" rel="noopener">🤖 AI Studio</a>';
    target.appendChild(li);
  }

  /* ── GLOBALS ────────────────────────────────────────────── */
  var selectedService = '';

  root.scwOpen = function () {
    var overlay = document.getElementById('scw-overlay');
    if (overlay) overlay.classList.add('open');
  };

  root.scwClose = function () {
    var overlay = document.getElementById('scw-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    // reset
    selectedService = '';
    document.querySelectorAll('.scw-svc').forEach(function (b) { b.classList.remove('selected'); });
    var form   = document.getElementById('scw-form');
    var status = document.getElementById('scw-status');
    var succ   = document.getElementById('scw-success');
    var panel  = document.getElementById('scw-form-panel');
    if (form)   form.reset();
    if (status) status.textContent = '';
    if (succ)   succ.classList.remove('show');
    if (panel)  panel.style.display = '';
  };

  root.scwOverlayClose = function (e) {
    if (e.target && e.target.id === 'scw-overlay') root.scwClose();
  };

  root.scwSelectSvc = function (btn) {
    document.querySelectorAll('.scw-svc').forEach(function (b) { b.classList.remove('selected'); });
    btn.classList.add('selected');
    selectedService = btn.getAttribute('data-label') || '';
  };

  root.scwSubmit = function (e) {
    e.preventDefault();
    var name   = (document.getElementById('scw-name')  || {}).value || '';
    var phone  = (document.getElementById('scw-phone') || {}).value || '';
    var email  = (document.getElementById('scw-email') || {}).value || '';
    var desc   = (document.getElementById('scw-desc')  || {}).value || '';
    var status = document.getElementById('scw-status');
    var btn    = document.getElementById('scw-submit');

    if (!name.trim())  { if (status) status.textContent = 'Please enter your name.';  return; }
    if (!phone.trim()) { if (status) status.textContent = 'Please enter your phone number.'; return; }

    if (btn)    { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (status) { status.textContent = ''; }

    var payload = {
      name:    name.trim(),
      phone:   phone.trim(),
      email:   email.trim(),
      message: (selectedService ? 'Service: ' + selectedService + '\n' : '') + desc.trim(),
      source:  'serenecreations.org – widget',
    };

    Promise.all([
      fetch(CONTACT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () { return { ok: true }; }), // fire-and-forget if CORS issues
      fetch(LEAD_HOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () { return { ok: true }; }),
    ]).then(function () {
      var panel = document.getElementById('scw-form-panel');
      var succ  = document.getElementById('scw-success');
      if (panel) panel.style.display = 'none';
      if (succ)  succ.classList.add('show');
    }).catch(function () {
      if (status) status.textContent = 'Something went wrong. Please try calling us directly.';
      if (btn)    { btn.disabled = false; btn.textContent = 'Send Enquiry →'; }
    });
  };

  /* ── WIRE EXISTING BUTTONS ──────────────────────────────── */
  function wireExistingButtons() {
    var patterns = [
      'a[href*="contact"]',
      'a[href*="quote"]',
      'a[href*="consultation"]',
      'button[class*="cta"]',
      'button[class*="quote"]',
      'button[class*="consult"]',
      '.cta-button',
      '.btn-quote',
      '.get-quote',
    ];
    patterns.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        // Don't hijack off-site links or mailto
        var href = el.getAttribute('href') || '';
        if (href.startsWith('mailto:') || href.startsWith('tel:')) return;
        if (href && href.startsWith('http') && href.indexOf(location.hostname) === -1) return;
        el.addEventListener('click', function (ev) {
          ev.preventDefault();
          root.scwOpen();
        });
      });
    });
  }

  /* ── INIT ───────────────────────────────────────────────── */
  function init() {
    // Inject CSS
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Inject popup
    var popupDiv = document.createElement('div');
    popupDiv.innerHTML = buildPopupHTML();
    document.body.appendChild(popupDiv.firstChild);

    // Inject floating trigger
    var btnDiv = document.createElement('div');
    btnDiv.innerHTML = buildTriggerHTML();
    document.body.appendChild(btnDiv.firstChild);

    // Nav tab
    injectNavTab();

    // Wire existing CTA buttons
    wireExistingButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
