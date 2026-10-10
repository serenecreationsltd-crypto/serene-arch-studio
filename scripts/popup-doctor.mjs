// Read-only browser check of the website popups (Free Consultation modal and
// BOQ slide-in). Loads each page in desktop and phone sizes, records errors,
// finds what could be hiding or trapping the popup, clicks the trigger, and
// reports the result as GitHub annotations. Submits no forms.
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'fs';

const URLS = (process.env.POPUP_URLS || 'https://www.serenecreations.org/,https://serene-arch-studio.web.app/').split(',');
const VIEWS = [
  { name: 'desktop', opts: { viewport: { width: 1366, height: 900 } } },
  { name: 'phone', opts: { ...devices['iPhone 13'] } },
];
mkdirSync('popup-shots', { recursive: true });

const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = s => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const note = (title, obj) => console.log(`::notice title=${escProp(title)}::${esc(JSON.stringify(obj))}`);

// Runs inside the page/frame: describes the popup elements and anything that traps a position:fixed box.
const inspect = () => {
  const describe = el => {
    if (!el) return null;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const traps = [];
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const c = getComputedStyle(p), f = [];
      if (c.transform !== 'none') f.push('transform');
      if (c.filter !== 'none') f.push('filter');
      if (c.backdropFilter && c.backdropFilter !== 'none') f.push('backdrop-filter');
      if (c.perspective !== 'none') f.push('perspective');
      if (/paint|layout|strict|content/.test(c.contain || '')) f.push('contain:' + c.contain);
      if (/transform|filter/.test(c.willChange || '')) f.push('will-change:' + c.willChange);
      if (c.overflow !== 'visible') f.push('overflow:' + c.overflow);
      if (c.display === 'none') f.push('display:none');
      if (c.visibility === 'hidden') f.push('visibility:hidden');
      if (+c.opacity === 0) f.push('opacity:0');
      if (c.zIndex !== 'auto' && c.position !== 'static') f.push('z:' + c.zIndex);
      if (f.length) traps.push(`${p.tagName.toLowerCase()}${p.id ? '#' + p.id : ''}${p.className && typeof p.className === 'string' ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} [${f.join(' ')}]`);
    }
    return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, position: cs.position, z: cs.zIndex,
      rect: [r.x, r.y, r.width, r.height].map(Math.round), ancestors: traps.slice(0, 8) };
  };
  const all = s => document.querySelectorAll(s).length;
  return {
    inFrame: window !== window.top,
    counts: { sasOverlay: all('#sas-overlay'), sasTrigger: all('#sas-trigger'), lcWrap: all('#lc-wrap'), onclickAttrs: all('[onclick]') },
    fns: { openPopup: typeof window.openPopup, sasClose: typeof window.sasClose, sasSubmit: typeof window.sasSubmit },
    scriptsMentioningPopup: [...document.scripts].filter(s => /sasClose|sasSubmit|openPopup|lc-wrap/.test(s.textContent)).length,
    trigger: describe(document.getElementById('sas-trigger')),
    overlay: describe(document.getElementById('sas-overlay')),
    lcWrap: describe(document.getElementById('lc-wrap')),
    candidates: [...document.querySelectorAll('a,button')].filter(e => /free consultation|get quote|consultation/i.test(e.textContent))
      .slice(0, 6).map(e => ({ tag: e.tagName, id: e.id, text: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 40),
        href: e.getAttribute('href'), onclick: (e.getAttribute('onclick') || '').slice(0, 70), shown: !!(e.offsetWidth || e.offsetHeight) })),
  };
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const url of URLS) {
  for (const view of VIEWS) {
    const ctx = await browser.newContext(view.opts);
    const page = await ctx.newPage();
    const errors = [], failed = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 160)));
    page.on('requestfailed', r => failed.push(r.url().slice(0, 100) + ' ' + (r.failure()?.errorText || '')));
    const tag = `${new URL(url).host} ${view.name}`;
    const result = { url, view: view.name };
    try {
      const res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      result.status = res?.status();
      await page.waitForTimeout(4000);
      // Find the frame (main page or an embed iframe) that holds the popup.
      const frames = [];
      for (const f of page.frames()) {
        try { const i = await f.evaluate(inspect); if (i.counts.sasOverlay || i.counts.sasTrigger || i.counts.lcWrap || f === page.mainFrame()) frames.push({ url: f.url().slice(0, 100), ...i, _f: f }); } catch {}
      }
      result.frames = frames.map(({ _f, ...rest }) => rest);
      result.iframes = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => ({ src: (f.src || '(srcdoc)').slice(0, 90), h: f.offsetHeight, w: f.offsetWidth })));
      await page.screenshot({ path: `popup-shots/${view.name}-${new URL(url).host}-1-loaded.png` });

      // Click the floating trigger (or the first visible "Free Consultation" control) and see whether the overlay shows.
      const holder = frames.find(f => f.counts.sasTrigger || f.counts.sasOverlay) || frames[0];
      const f = holder?._f || page.mainFrame();
      let clicked = 'none';
      try {
        if (await f.isVisible('#sas-trigger')) { await f.click('#sas-trigger', { timeout: 5000 }); clicked = '#sas-trigger'; }
        else {
          const c = f.getByText(/free consultation/i).first();
          if (await c.isVisible()) { await c.click({ timeout: 5000 }); clicked = 'text:Free Consultation'; }
        }
      } catch (e) { clicked += ' (click error: ' + e.message.split('\n')[0].slice(0, 120) + ')'; }
      await page.waitForTimeout(1200);
      result.clicked = clicked;
      result.afterClick = await f.evaluate(() => {
        const o = document.getElementById('sas-overlay');
        if (!o) return { overlay: 'missing' };
        const r = o.getBoundingClientRect(), cs = getComputedStyle(o);
        const cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
        const top = document.elementFromPoint(cx, cy);
        return { hasOpenClass: o.classList.contains('open'), display: cs.display, rect: [r.x, r.y, r.width, r.height].map(Math.round),
          viewport: [innerWidth, innerHeight], centreElement: top ? `${top.tagName.toLowerCase()}#${top.id}.${String(top.className).slice(0, 40)}` : null,
          centreIsInsidePopup: !!(top && o.contains(top)) };
      });
      await page.screenshot({ path: `popup-shots/${view.name}-${new URL(url).host}-2-after-click.png` });

      // BOQ slide-in: appears after 12 s or 45 % scroll.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(13000);
      result.lcAfterWait = await page.evaluate(() => {
        const w = document.getElementById('lc-wrap');
        return w ? { open: w.classList.contains('open'), transform: getComputedStyle(w).transform } : 'missing';
      });
    } catch (e) {
      result.error = e.message.split('\n')[0].slice(0, 200);
    }
    result.errors = errors.slice(0, 8);
    result.failedRequests = failed.slice(0, 6);
    note(tag, result);
    await ctx.close();
  }
}
await browser.close();
