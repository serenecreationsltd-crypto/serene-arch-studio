// Email doctor: read-only check of why automated emails from info@serenecreations.org fail.
//  1. DNS: MX, SPF, DMARC and Zoho DKIM records for serenecreations.org.
//  2. Zoho SMTP: login test on smtp.zoho.com:465 and smtppro.zoho.com:465, then ONE test
//     email from info@ to info@ (nobody else) to capture Zoho's exact answer.
//  3. Zoho IMAP (if enabled): last 7 days of the info@ inbox, only bounce / Zoho notices,
//     with Zoho's error lines; plus a per-day count of the Sent folder.
// Output goes to workflow annotations. This repo is public, so every email address other
// than info@serenecreations.org is blanked out, and nothing secret is printed.
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import dns from 'node:dns/promises';

const USER = 'info@serenecreations.org';
const DOMAIN = 'serenecreations.org';
const PASS = process.env.SMTP_PASSWORD || '';
const out = [];
const note = (title, text) => out.push({ title, text: String(text) });

const redact = (s) => String(s || '')
  .replace(/[A-Z0-9._%+=-]+@([A-Z0-9-]+\.)+([A-Z]{2,})/gi, (m, _d, tld) =>
    m.toLowerCase() === USER ? m : `<address>.${tld.toLowerCase()}`)
  .replace(new RegExp(PASS ? PASS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\b\\B', 'g'), '<secret>');
const T = (p, ms, label) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`${label}: timed out after ${ms / 1000}s`)), ms))]);

function emitAll() {
  if (!out.length) note('Email doctor', 'No results.');
  for (const { title, text } of out) {
    const body = redact(text).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 3800);
    console.log(`::notice title=${title.replace(/[:,]/g, ' ')}::${body}`);
  }
}
const watchdog = setTimeout(() => { note('Watchdog', 'Stopped after 6 minutes.'); emitAll(); process.exit(0); }, 6 * 60 * 1000);

async function checkDns() {
  const lines = [];
  const txt = async (name) => (await dns.resolveTxt(name).catch(() => [])).map((r) => r.join(''));
  const mx = await dns.resolveMx(DOMAIN).catch((e) => e.code);
  lines.push('MX: ' + (Array.isArray(mx) ? mx.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`).join(', ') : mx));
  const spf = (await txt(DOMAIN)).filter((t) => /^v=spf1/i.test(t));
  lines.push('SPF: ' + (spf.length ? spf.join(' | ') : 'MISSING') + (spf.length > 1 ? '  <-- more than one SPF record (invalid)' : ''));
  const dmarc = await txt('_dmarc.' + DOMAIN);
  lines.push('DMARC: ' + (dmarc.length ? dmarc.join(' | ') : 'MISSING'));
  for (const sel of ['zmail', 'zoho', 'default', 'resend']) {
    const k = await txt(`${sel}._domainkey.${DOMAIN}`);
    if (k.length) lines.push(`DKIM (${sel}): present`);
  }
  if (!lines.some((l) => l.startsWith('DKIM'))) lines.push('DKIM: no record found for selectors zmail, zoho, default, resend');
  note('DNS', lines.join('\n'));
}

async function checkSmtp() {
  if (!PASS) { note('SMTP', 'The GitHub secret SMTP_PASSWORD is empty, so the Zoho login could not be tested.'); return; }
  const results = [];
  let sender = null;
  for (const host of ['smtp.zoho.com', 'smtppro.zoho.com']) {
    const t = nodemailer.createTransport({ host, port: 465, secure: true, auth: { user: USER, pass: PASS },
      connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000 });
    try {
      await T(t.verify(), 40000, host);
      results.push(`${host}:465 login: OK`);
      if (!sender) sender = t;
    } catch (e) {
      results.push(`${host}:465 login FAILED: ${e.responseCode || ''} ${e.code || ''} ${e.response || e.message}`);
    }
  }
  if (sender) {
    try {
      const info = await T(sender.sendMail({
        from: `Serene Creations <${USER}>`, to: USER, replyTo: USER,
        subject: 'Email doctor test (automatic, safe to delete)',
        text: 'Automatic delivery test from the Email doctor GitHub workflow. No action needed.',
      }), 60000, 'send');
      results.push(`Test email info@ -> info@: ACCEPTED by Zoho (${info.response})`);
    } catch (e) {
      results.push(`Test email info@ -> info@: REFUSED by Zoho: ${e.responseCode || ''} ${e.response || e.message}`);
    }
  }
  note('SMTP', results.join('\n'));
}

async function checkImap() {
  if (!PASS) return;
  const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
  try {
    await T(client.connect(), 40000, 'IMAP connect');
  } catch (e) {
    note('IMAP', `Could not open the info@ mailbox: ${e.responseText || e.message}. (IMAP may be switched off in Zoho Mail settings; this does not affect sending.)`);
    return;
  }
  const since = new Date(Date.now() - 7 * 864e5);
  try {
    // Sent folder: how many emails went out per day.
    const boxes = await client.list();
    const sentBox = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^sent/i.test(b.name));
    if (sentBox) {
      const lock = await client.getMailboxLock(sentBox.path);
      try {
        const perDay = {};
        for await (const m of client.fetch({ since }, { envelope: true })) {
          const d = (m.envelope.date || new Date()).toISOString().slice(0, 10);
          perDay[d] = (perDay[d] || 0) + 1;
        }
        note('Sent folder (last 7 days)', Object.keys(perDay).sort().map((d) => `${d}: ${perDay[d]}`).join('\n') || 'Empty: nothing sent in 7 days is stored in Sent.');
      } finally { lock.release(); }
    }

    // Inbox: bounces and Zoho notices.
    const lock = await client.getMailboxLock('INBOX');
    const hits = [];
    const reasons = {};
    try {
      const re = /undeliver|delivery (status|failure|has failed|incomplete)|returned|failure notice|blocked|suspend|unusual|limit|bounce|could not be delivered|not delivered/i;
      for await (const m of client.fetch({ since }, { envelope: true, source: { maxLength: 40000 } })) {
        const from = (m.envelope.from || []).map((a) => a.address || '').join(',');
        const subj = m.envelope.subject || '';
        if (!(/mailer-daemon|postmaster|zoho/i.test(from) || re.test(subj))) continue;
        const src = m.source ? m.source.toString('utf8') : '';
        const errs = [...src.matchAll(/^.*\b[45]\d\d[ -][45]\.\d{1,3}\.\d{1,3}\b.*$|^.*(?:Diagnostic-Code|Reason|Remote-MTA|Status):.*$/gim)]
          .map((x) => x[0].trim()).filter((x, i, a) => a.indexOf(x) === i).slice(0, 4);
        for (const e of errs) {
          const k = redact(e).replace(/\s+/g, ' ').slice(0, 160);
          reasons[k] = (reasons[k] || 0) + 1;
        }
        hits.push(`${(m.envelope.date || new Date()).toISOString().slice(0, 16).replace('T', ' ')} | ${from.replace(/@.*/, '@…')} | ${subj.slice(0, 90)}`);
      }
    } finally { lock.release(); }
    note('Inbox notices (last 7 days)', hits.length ? `${hits.length} bounce/Zoho notices:\n` + hits.slice(-25).join('\n') : 'No bounce or Zoho notices in the last 7 days.');
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (top.length) note('Error lines in those notices', top.map(([k, n]) => `${n} x ${k}`).join('\n'));
  } catch (e) {
    note('IMAP', 'Mailbox read failed: ' + (e.responseText || e.message));
  } finally {
    await client.logout().catch(() => {});
  }
}

for (const [name, fn] of [['DNS', checkDns], ['SMTP', checkSmtp], ['IMAP', checkImap]]) {
  try { await T(fn(), 150000, name); } catch (e) { note(name, 'Check failed: ' + e.message); }
}
clearTimeout(watchdog);
emitAll();
