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

const T = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))]);
const results = [];
let emitted = false;
const emitAll = () => { if (emitted) return; emitted = true; for (const r of results) note(r.tag, r); };
// Watchdog: never let a frozen page hang the job; report whatever we have.
setTimeout(() => { for (const r of results) if (!r.done) r.stage = 'WATCHDOG at ' + r.stage; emitAll(); process.exit(0); }, 11 * 60 * 1000).unref();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const url of URLS) {
  for (const view of VIEWS) {
    const host = new URL(url).host;
    const result = { tag: `${host} ${view.name}`, url, view: view.name, stage: 'start', done: false, timeline: [] };
    results.push(result);
    const t0 = Date.now();
    const step = name => { result.stage = name; result.timeline.push(`${name}@${Math.round((Date.now() - t0) / 1000)}s`); };
    const ctx = await browser.newContext(view.opts);
    // Record main-thread long tasks (anything >50 ms blocks clicks).
    await ctx.addInitScript(() => {
      window.__lt = { n: 0, total: 0, max: 0 };
      try { new PerformanceObserver(l => { for (const e of l.getEntries()) { __lt.n++; __lt.total += e.duration; __lt.max = Math.max(__lt.max, e.duration); } }).observe({ type: 'longtask', buffered: true }); } catch {}
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    const errors = [], failed = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 160)));
    page.on('requestfailed', r => failed.push(r.url().slice(0, 100) + ' ' + (r.failure()?.errorText || '')));
    const ping = async label => {
      const a = Date.now();
      try { await T(page.evaluate(() => 1), 8000, 'ping'); result[label] = `responds in ${Date.now() - a} ms`; }
      catch { result[label] = 'NOT RESPONDING (main thread blocked >8 s)'; }
    };
    try {
      step('goto');
      const res = await T(page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }), 50000, 'goto');
      result.status = res?.status();
      step('settle');
      await page.waitForTimeout(6000);
      await ping('responsiveAfterLoad');
      step('inspect');
      const frames = [];
      for (const f of page.frames()) {
        try { const i = await T(f.evaluate(inspect), 10000, 'inspect'); if (i.counts.sasOverlay || i.counts.sasTrigger || i.counts.lcWrap || f === page.mainFrame()) frames.push({ url: f.url().slice(0, 100), ...i, _f: f }); }
        catch (e) { (result.frameErrors ||= []).push(f.url().slice(0, 60) + ' ' + e.message.slice(0, 60)); }
      }
      result.frames = frames.map(({ _f, ...rest }) => rest);
      result.iframes = await T(page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => ({ src: (f.src || '(srcdoc)').slice(0, 90), h: f.offsetHeight, w: f.offsetWidth }))), 10000, 'iframes').catch(e => e.message);
      result.longTasks = await T(page.evaluate(() => window.__lt), 8000, 'lt').catch(e => e.message);
      step('shot1');
      await T(page.screenshot({ path: `popup-shots/${view.name}-${host}-1-loaded.png`, timeout: 15000 }), 20000, 'shot1').catch(e => { result.shot1 = e.message; });

      step('click');
      const holder = frames.find(f => f.counts.sasTrigger || f.counts.sasOverlay) || frames[0];
      const f = holder?._f || page.mainFrame();
      let clicked = 'none';
      try {
        if (await T(f.isVisible('#sas-trigger'), 8000, 'vis')) { await T(f.click('#sas-trigger', { timeout: 8000 }), 10000, 'click'); clicked = '#sas-trigger'; }
        else {
          const c = f.getByText(/free consultation/i).first();
          if (await T(c.isVisible(), 8000, 'vis2')) { await T(c.click({ timeout: 8000 }), 10000, 'click2'); clicked = 'text:Free Consultation'; }
        }
      } catch (e) { clicked += ' (click error: ' + e.message.split('\n')[0].slice(0, 120) + ')'; }
      result.clicked = clicked;
      await page.waitForTimeout(1500);
      step('afterClick');
      result.afterClick = await T(f.evaluate(() => {
        const o = document.getElementById('sas-overlay');
        if (!o) return { overlay: 'missing' };
        const r = o.getBoundingClientRect(), cs = getComputedStyle(o);
        const cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
        const top = document.elementFromPoint(cx, cy);
        return { hasOpenClass: o.classList.contains('open'), display: cs.display, rect: [r.x, r.y, r.width, r.height].map(Math.round),
          viewport: [innerWidth, innerHeight], centreElement: top ? `${top.tagName.toLowerCase()}#${top.id}.${String(top.className).slice(0, 40)}` : null,
          centreIsInsidePopup: !!(top && o.contains(top)) };
      }), 10000, 'afterClick').catch(e => e.message);
      step('shot2');
      await T(page.screenshot({ path: `popup-shots/${view.name}-${host}-2-after-click.png`, timeout: 15000 }), 20000, 'shot2').catch(e => { result.shot2 = e.message; });

      step('lc-wait');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(13000);
      result.lcAfterWait = await T(page.evaluate(() => {
        const w = document.getElementById('lc-wrap');
        return w ? { open: w.classList.contains('open'), transform: getComputedStyle(w).transform } : 'missing';
      }), 8000, 'lc').catch(e => e.message);
      await ping('responsiveAtEnd');
      step('done');
      result.done = true;
    } catch (e) {
      result.error = e.message.split('\n')[0].slice(0, 200);
    }
    result.errors = errors.slice(0, 8);
    result.failedRequests = failed.slice(0, 6);
    await T(ctx.close(), 10000, 'close').catch(() => {});
  }
}
emitAll();
await T(browser.close(), 10000, 'browser-close').catch(() => {});
process.exit(0);
