// POST /api/signup: records a pending signup and emails a confirmation link (double opt-in).
// Fields: first_name (required), email (required), zip (optional), source (optional),
// website (honeypot, must be empty), turnstile (Cloudflare Turnstile token).
// Nobody counts as subscribed until they confirm at /confirm (see functions/api/confirm.js).

const EMAIL_RE = /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const TX_ZIP_RE = /^(7[5-9]\d{3}|885\d{2})(-\d{4})?$/;
const NAME_RE = /^[\p{L}][\p{L}\p{M}' .-]{0,39}$/u;
const SITE = "https://friscoisdbondfacts.com";
const FROM = { address: "updates@friscoisdbondfacts.com", name: "Frisco ISD Bond Facts" };
const RESEND_AFTER_MIN = 10;   // do not send another confirmation within 10 minutes
const PENDING_DAYS = 7;        // unconfirmed signups are deleted after 7 days

// Throwaway inboxes and reserved test domains.
const BLOCKED_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "test.com", "test.org", "email.com", "domain.com",
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com", "grr.la",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org", "tempmail.net", "tempmailo.com",
  "yopmail.com", "yopmail.net", "trashmail.com", "trashmail.de", "getnada.com", "nada.email", "dispostable.com",
  "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mailnesia.com", "emailondeck.com", "mohmal.com",
  "burnermail.io", "mintemail.com", "mytemp.email", "tempr.email", "discard.email", "spamgourmet.com",
  "mailcatch.com", "inboxkitten.com", "tmail.ws", "moakt.com", "emailfake.com", "fakemail.net", "33mail.com",
]);

const SENT_MSG = "Almost done. Check your inbox for a confirmation email and click the link to join the list.";

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// True if the domain has a mail server (MX), or an address record mail can fall back to.
async function domainTakesMail(domain) {
  const ask = async (type) => {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
      { headers: { accept: "application/dns-json" } });
    return r.json();
  };
  try {
    const mx = await ask("MX");
    if (mx.Status === 3) return false; // domain does not exist
    const answers = (mx.Answer || []).filter((a) => a.type === 15);
    if (answers.length) return !answers.every((a) => /^0\s+\.?$/.test(String(a.data).trim())); // null MX refuses mail
    const a = await ask("A");
    return (a.Answer || []).some((x) => x.type === 1);
  } catch {
    return true; // if the lookup itself fails, do not block a real person
  }
}

async function sendConfirmation(env, to, firstName, token) {
  const link = `${SITE}/confirm#${token}`;
  const name = esc(firstName);
  const html = `<!doctype html><html><body style="margin:0;background:#F4F3EF;font-family:Arial,Helvetica,sans-serif;color:#101A27">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F3EF;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:10px;overflow:hidden">
<tr><td style="background:#101A27;padding:20px 28px;color:#F2F1EC;font-weight:bold;font-size:15px;letter-spacing:.06em;text-transform:uppercase">Frisco ISD Bond Facts</td></tr>
<tr><td style="padding:28px">
<p style="font-size:17px;margin:0 0 14px">Hi ${name},</p>
<p style="font-size:16px;line-height:1.5;margin:0 0 22px">Please confirm your email address so we can send you one short note whenever new Frisco ISD documents or bond numbers are posted.</p>
<p style="margin:0 0 22px"><a href="${link}" style="display:inline-block;background:#EB7256;color:#101A27;text-decoration:none;font-weight:bold;font-size:16px;padding:13px 24px;border-radius:99px">Confirm my email</a></p>
<p style="font-size:14px;line-height:1.5;color:#5B6874;margin:0 0 10px">This link works for 3 days. If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${link}</span></p>
<p style="font-size:14px;line-height:1.5;color:#5B6874;margin:0">Did not sign up? Ignore this email and nothing happens. We never sell or share your address.</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #D9DDD9;font-size:12px;color:#5B6874">Political advertising paid for by Stephen Jordan, Frisco, Texas. Questions: <a href="mailto:info@friscoisdbondfacts.com" style="color:#2C6E85">info@friscoisdbondfacts.com</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = `Hi ${firstName},

Please confirm your email address so we can send you one short note whenever new Frisco ISD documents or bond numbers are posted.

Confirm here (works for 3 days):
${link}

Did not sign up? Ignore this email and nothing happens. We never sell or share your address.

Political advertising paid for by Stephen Jordan, Frisco, Texas.
Questions: info@friscoisdbondfacts.com`;

  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_EMAIL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: { address: to, name: firstName },
      subject: "Confirm your email for Frisco ISD Bond Facts",
      html,
      text,
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.log("email send failed", r.status, detail.slice(0, 300));
    return false;
  }
  return true;
}

export async function onRequestPost({ request, env }) {
  let data = {};
  const type = request.headers.get("content-type") || "";
  try {
    if (type.includes("application/json")) data = await request.json();
    else data = Object.fromEntries(await request.formData());
  } catch {
    return reply({ ok: false, error: "Could not read the form." }, 400);
  }

  // Honeypot: real people never fill this hidden field.
  if (String(data.website || "").trim() !== "") return reply({ ok: true, message: SENT_MSG });

  const firstName = String(data.first_name || "").trim().replace(/\s+/g, " ");
  const email = String(data.email || "").trim().toLowerCase();
  const zip = String(data.zip || "").trim().slice(0, 10);
  const source = String(data.source || "site").trim().slice(0, 40);
  const local = email.split("@")[0] || "";
  const domain = email.split("@")[1] || "";

  if (!firstName) return reply({ ok: false, error: "Please enter your first name." }, 400);
  if (!NAME_RE.test(firstName)) return reply({ ok: false, error: "Please enter just your first name, using letters." }, 400);
  if (!EMAIL_RE.test(email) || email.length > 254 || local.length > 64) {
    return reply({ ok: false, error: "Please enter a valid email address." }, 400);
  }
  if (BLOCKED_DOMAINS.has(domain)) return reply({ ok: false, error: "Please use a permanent email address." }, 400);
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) return reply({ ok: false, error: "ZIP code should be 5 digits." }, 400);
  if (zip && !TX_ZIP_RE.test(zip)) return reply({ ok: false, error: "Please enter a Texas ZIP code, or leave it blank." }, 400);

  // Cloudflare Turnstile human check.
  if (env.TURNSTILE_SECRET) {
    const token = String(data["cf-turnstile-response"] || data.turnstile || "");
    if (!token) return reply({ ok: false, error: "Please complete the quick human check, then try again." }, 403);
    try {
      const body = new FormData();
      body.append("secret", env.TURNSTILE_SECRET);
      body.append("response", token);
      const ip = request.headers.get("CF-Connecting-IP");
      if (ip) body.append("remoteip", ip);
      const out = await (await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body })).json();
      if (!out.success) return reply({ ok: false, error: "The human check expired. Please try again." }, 403);
    } catch {
      return reply({ ok: false, error: "Something went wrong. Please try again." }, 500);
    }
  }

  if (!(await domainTakesMail(domain))) {
    return reply({ ok: false, error: "That email domain can't receive mail. Please check the address." }, 400);
  }

  if (!env.CF_EMAIL_TOKEN || !env.CF_ACCOUNT_ID) {
    return reply({ ok: false, error: "Signups are paused for a moment. Please try again later." }, 503);
  }

  try {
    // Housekeeping: drop signups that were never confirmed.
    await env.DB.prepare(
      `DELETE FROM signups WHERE confirmed_at IS NULL AND created_at < datetime('now', '-${PENDING_DAYS} days')`
    ).run();

    const row = await env.DB.prepare(
      "SELECT confirmed_at, unsubscribed_at, token_sent_at FROM signups WHERE email = ?1"
    ).bind(email).first();

    // Already confirmed and still subscribed: refresh details quietly, send nothing.
    // The reply is identical either way, so the form never reveals who is on the list.
    if (row && row.confirmed_at && !row.unsubscribed_at) {
      await env.DB.prepare(
        "UPDATE signups SET first_name = ?2, zip = COALESCE(NULLIF(?3, ''), zip) WHERE email = ?1"
      ).bind(email, firstName, zip).run();
      return reply({ ok: true, message: SENT_MSG });
    }

    // A confirmation went out recently: do not send another one yet.
    if (row && row.token_sent_at) {
      const recent = await env.DB.prepare(
        `SELECT 1 AS r FROM signups WHERE email = ?1 AND token_sent_at > datetime('now', '-${RESEND_AFTER_MIN} minutes')`
      ).bind(email).first();
      if (recent) return reply({ ok: true, message: SENT_MSG });
    }

    const token = newToken();
    const hash = await sha256Hex(token);
    await env.DB.prepare(
      "INSERT INTO signups (email, zip, source, first_name, token_hash, token_sent_at) " +
      "VALUES (?1, NULLIF(?2, ''), ?3, ?4, ?5, datetime('now')) " +
      "ON CONFLICT(email) DO UPDATE SET first_name = excluded.first_name, " +
      "zip = COALESCE(excluded.zip, signups.zip), source = excluded.source, " +
      "token_hash = excluded.token_hash, token_sent_at = excluded.token_sent_at"
    ).bind(email, zip, source, firstName, hash).run();

    const sent = await sendConfirmation(env, email, firstName, token);
    if (!sent) {
      await env.DB.prepare("UPDATE signups SET token_sent_at = NULL WHERE email = ?1").bind(email).run();
      return reply({ ok: false, error: "We couldn't send the confirmation email. Please try again in a few minutes." }, 502);
    }
  } catch (e) {
    console.log("signup error", String(e).slice(0, 300));
    return reply({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
  return reply({ ok: true, message: SENT_MSG });
}

export async function onRequest() {
  return reply({ ok: false, error: "Use POST." }, 405);
}
