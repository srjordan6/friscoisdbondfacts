// Admin actions for sending updates. Every request has already passed _middleware.js
// (Cloudflare Access login for an allowed email). Routes:
//   GET  /api/admin/stats                       list counts and recent campaigns
//   POST /api/admin/preview   {subject, body}   rendered HTML preview
//   POST /api/admin/test      {subject, body}   sends one copy to the signed-in admin
//   POST /api/admin/create    {subject, body}   saves a campaign, returns its id and recipient count
//   POST /api/admin/send      {campaign_id}     sends the next batch; call until remaining is 0

const SITE = "https://friscoisdbondfacts.com";
const FROM = { address: "updates@friscoisdbondfacts.com", name: "Frisco ISD Bond Facts" };
const BATCH = 25;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Plain text to email HTML. Blank lines separate paragraphs, lines starting with "- " become a list,
// **text** becomes bold, and web addresses become links. Everything is escaped first.
function inline(s) {
  let h = esc(s);
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" style="color:#2C6E85">$1</a>');
  return h;
}

function bodyToHtml(body) {
  return String(body).replace(/\r\n/g, "\n").trim().split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*-\s+/.test(l))) {
      return '<ul style="margin:0 0 16px;padding-left:22px">' +
        lines.map((l) => `<li style="margin:0 0 6px;font-size:16px;line-height:1.55">${inline(l.replace(/^\s*-\s+/, ""))}</li>`).join("") + "</ul>";
    }
    return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6">${lines.map(inline).join("<br>")}</p>`;
  }).join("\n");
}

function render(subject, body, firstName, unsubToken) {
  const hi = firstName ? `Hi ${esc(firstName)},` : "Hi,";
  const unsubPage = unsubToken ? `${SITE}/unsubscribe#${unsubToken}` : `mailto:info@friscoisdbondfacts.com?subject=Unsubscribe`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#F4F3EF;font-family:Arial,Helvetica,sans-serif;color:#101A27">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F3EF;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;overflow:hidden">
<tr><td style="background:#101A27;padding:20px 28px"><a href="${SITE}" style="color:#F2F1EC;font-weight:bold;font-size:15px;letter-spacing:.06em;text-transform:uppercase;text-decoration:none">Frisco ISD Bond Facts</a></td></tr>
<tr><td style="padding:28px 28px 12px">
<p style="margin:0 0 16px;font-size:16px;line-height:1.6">${hi}</p>
${bodyToHtml(body)}
<p style="margin:8px 0 0"><a href="${SITE}" style="display:inline-block;background:#EB7256;color:#101A27;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:99px">See the numbers</a></p>
</td></tr>
<tr><td style="padding:18px 28px 22px;border-top:1px solid #D9DDD9;font-size:12px;line-height:1.6;color:#5B6874">
You are getting this because you signed up and confirmed at friscoisdbondfacts.com.
<a href="${unsubPage}" style="color:#2C6E85">Unsubscribe</a> anytime.<br>
Political advertising paid for by Stephen Jordan, Frisco, Texas. Questions or corrections: <a href="mailto:info@friscoisdbondfacts.com" style="color:#2C6E85">info@friscoisdbondfacts.com</a>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${firstName ? `Hi ${firstName},` : "Hi,"}

${String(body).replace(/\*\*(.+?)\*\*/g, "$1").trim()}

See the numbers: ${SITE}

---
You are getting this because you signed up and confirmed at friscoisdbondfacts.com.
Unsubscribe: ${unsubPage}
Political advertising paid for by Stephen Jordan, Frisco, Texas.
Questions or corrections: info@friscoisdbondfacts.com`;
  return { html, text };
}

async function sendOne(env, to, firstName, unsubToken, subject, body) {
  const { html, text } = render(subject, body, firstName, unsubToken);
  const headers = {};
  if (unsubToken) {
    headers["List-Unsubscribe"] = `<${SITE}/api/unsubscribe?t=${unsubToken}>, <mailto:info@friscoisdbondfacts.com?subject=Unsubscribe>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_EMAIL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: firstName ? { address: to, name: firstName } : to,
      subject,
      html,
      text,
      headers,
    }),
  });
  if (r.ok) return { ok: true };
  const detail = (await r.text().catch(() => "")).slice(0, 300);
  return { ok: false, error: `HTTP ${r.status} ${detail}` };
}

function readDraft(data) {
  const subject = String(data.subject || "").trim();
  const body = String(data.body || "").trim();
  if (!subject || subject.length > 150) return { error: "Subject is required (150 characters or fewer)." };
  if (!body || body.length > 20000) return { error: "Message is required (20,000 characters or fewer)." };
  return { subject, body };
}

const CONFIRMED = "confirmed_at IS NOT NULL AND unsubscribed_at IS NULL AND unsub_token IS NOT NULL";

export async function onRequestGet({ params, env }) {
  if (params.action !== "stats") return reply({ ok: false, error: "Not found." }, 404);
  const c = await env.DB.prepare(
    `SELECT SUM(CASE WHEN ${CONFIRMED} THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN confirmed_at IS NULL THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubscribed FROM signups`
  ).first();
  const campaigns = (await env.DB.prepare(
    `SELECT c.id, c.subject, c.created_at, c.finished_at,
            (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id = c.id AND d.status = 'sent') AS sent,
            (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id = c.id AND d.status = 'failed') AS failed
       FROM campaigns c ORDER BY c.id DESC LIMIT 10`
  ).all()).results;
  return reply({ ok: true, counts: { confirmed: c.confirmed || 0, pending: c.pending || 0, unsubscribed: c.unsubscribed || 0 }, campaigns });
}

export async function onRequestPost({ params, request, env, data: ctx }) {
  let data = {};
  try { data = await request.json(); } catch { return reply({ ok: false, error: "Could not read the request." }, 400); }
  const action = params.action;

  if (action === "preview") {
    const d = readDraft(data);
    if (d.error) return reply({ ok: false, error: d.error }, 400);
    return reply({ ok: true, html: render(d.subject, d.body, "Stephen", "0".repeat(48)).html });
  }

  if (!env.CF_EMAIL_TOKEN || !env.CF_ACCOUNT_ID) return reply({ ok: false, error: "Email sending is not configured." }, 503);

  if (action === "test") {
    const d = readDraft(data);
    if (d.error) return reply({ ok: false, error: d.error }, 400);
    const me = await env.DB.prepare(
      `SELECT first_name, unsub_token FROM signups WHERE email = ?1 AND ${CONFIRMED}`
    ).bind(ctx.adminEmail).first();
    const res = await sendOne(env, ctx.adminEmail, me ? me.first_name : "", me ? me.unsub_token : "", "[TEST] " + d.subject, d.body);
    if (!res.ok) console.log("test send failed", res.error);
    return res.ok ? reply({ ok: true, to: ctx.adminEmail }) : reply({ ok: false, error: "Test send failed: " + res.error }, 502);
  }

  if (action === "create") {
    const d = readDraft(data);
    if (d.error) return reply({ ok: false, error: d.error }, 400);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM signups WHERE ${CONFIRMED}`).first();
    // Same subject and message as an unfinished or recent campaign: resume it instead of starting over,
    // so a reload or double click can never email anyone twice.
    const existing = await env.DB.prepare(
      "SELECT id FROM campaigns WHERE subject = ?1 AND body = ?2 AND (finished_at IS NULL OR finished_at > datetime('now', '-1 day')) ORDER BY id DESC LIMIT 1"
    ).bind(d.subject, d.body).first();
    if (existing) return reply({ ok: true, campaign_id: existing.id, recipients: n.n, resumed: true });
    const r = await env.DB.prepare("INSERT INTO campaigns (subject, body, created_by) VALUES (?1, ?2, ?3)")
      .bind(d.subject, d.body, ctx.adminEmail).run();
    return reply({ ok: true, campaign_id: r.meta.last_row_id, recipients: n.n });
  }

  if (action === "send") {
    const id = Number(data.campaign_id);
    if (!Number.isInteger(id) || id < 1) return reply({ ok: false, error: "Missing campaign." }, 400);
    const camp = await env.DB.prepare("SELECT id, subject, body, finished_at FROM campaigns WHERE id = ?1").bind(id).first();
    if (!camp) return reply({ ok: false, error: "Campaign not found." }, 404);
    if (camp.finished_at) return reply({ ok: true, sent: 0, failed: 0, remaining: 0, done: true });
    await env.DB.prepare("UPDATE campaigns SET started_at = COALESCE(started_at, datetime('now')) WHERE id = ?1").bind(id).run();

    // Next batch: confirmed, still subscribed, and not already attempted for this campaign.
    const batch = (await env.DB.prepare(
      `SELECT s.id, s.email, s.first_name, s.unsub_token FROM signups s
        WHERE ${CONFIRMED.replace(/(confirmed_at|unsubscribed_at|unsub_token)/g, "s.$1")}
          AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.campaign_id = ?1 AND d.signup_id = s.id)
        ORDER BY s.id LIMIT ${BATCH}`
    ).bind(id).all()).results;

    let sent = 0, failed = 0;
    for (const s of batch) {
      // Reserve the slot first, so a retried request can never send the same person twice.
      const claim = await env.DB.prepare(
        "INSERT OR IGNORE INTO deliveries (campaign_id, signup_id, status) VALUES (?1, ?2, 'sending')"
      ).bind(id, s.id).run();
      if (!claim.meta.changes) continue;
      const res = await sendOne(env, s.email, s.first_name, s.unsub_token, camp.subject, camp.body);
      await env.DB.prepare("UPDATE deliveries SET status = ?3, error = ?4, sent_at = datetime('now') WHERE campaign_id = ?1 AND signup_id = ?2")
        .bind(id, s.id, res.ok ? "sent" : "failed", res.ok ? null : res.error).run();
      if (res.ok) sent++; else failed++;
    }

    const left = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signups s WHERE ${CONFIRMED.replace(/(confirmed_at|unsubscribed_at|unsub_token)/g, "s.$1")}
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.campaign_id = ?1 AND d.signup_id = s.id)`
    ).bind(id).first();
    if (!left.n) await env.DB.prepare("UPDATE campaigns SET finished_at = datetime('now') WHERE id = ?1").bind(id).run();
    return reply({ ok: true, sent, failed, remaining: left.n, done: !left.n });
  }

  return reply({ ok: false, error: "Not found." }, 404);
}
