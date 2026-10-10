// POST /api/signup: stores an email (and optional ZIP) for bond updates.
// Fields: email (required), zip (optional), source (optional), website (honeypot, must be empty).

const EMAIL_RE = /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const TX_ZIP_RE = /^(7[5-9]\d{3}|885\d{2})(-\d{4})?$/;

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

// True if the domain has a mail server (MX), or an address record mail can fall back to.
async function domainTakesMail(domain) {
  const ask = async (type) => {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
      { headers: { accept: "application/dns-json" } });
    const j = await r.json();
    return j;
  };
  try {
    const mx = await ask("MX");
    if (mx.Status === 3) return false; // domain does not exist
    const answers = (mx.Answer || []).filter((a) => a.type === 15);
    if (answers.length) {
      // A "null MX" (priority 0, target ".") means the domain refuses mail.
      return !answers.every((a) => /^0\s+\.?$/.test(String(a.data).trim()));
    }
    const a = await ask("A");
    return (a.Answer || []).some((x) => x.type === 1);
  } catch {
    return true; // if the lookup itself fails, do not block a real person
  }
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  let data = {};
  const type = request.headers.get("content-type") || "";
  try {
    if (type.includes("application/json")) {
      data = await request.json();
    } else {
      const form = await request.formData();
      data = Object.fromEntries(form);
    }
  } catch {
    return reply({ ok: false, error: "Could not read the form." }, 400);
  }

  // Honeypot: real people never fill this hidden field.
  if (String(data.website || "").trim() !== "") return reply({ ok: true });

  const email = String(data.email || "").trim().toLowerCase();
  const zip = String(data.zip || "").trim().slice(0, 10);
  const source = String(data.source || "site").trim().slice(0, 40);

  const local = email.split("@")[0] || "";
  const domain = email.split("@")[1] || "";
  if (!EMAIL_RE.test(email) || email.length > 254 || local.length > 64) {
    return reply({ ok: false, error: "Please enter a valid email address." }, 400);
  }
  if (BLOCKED_DOMAINS.has(domain)) {
    return reply({ ok: false, error: "Please use a permanent email address." }, 400);
  }
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) {
    return reply({ ok: false, error: "ZIP code should be 5 digits." }, 400);
  }
  if (zip && !TX_ZIP_RE.test(zip)) {
    return reply({ ok: false, error: "Please enter a Texas ZIP code, or leave it blank." }, 400);
  }

  // Cloudflare Turnstile human check. Enforced once the TURNSTILE_SECRET secret is set in Pages.
  if (env.TURNSTILE_SECRET) {
    const token = String(data["cf-turnstile-response"] || data.turnstile || "");
    if (!token) return reply({ ok: false, error: "Please complete the quick human check, then try again." }, 403);
    try {
      const body = new FormData();
      body.append("secret", env.TURNSTILE_SECRET);
      body.append("response", token);
      const ip = request.headers.get("CF-Connecting-IP");
      if (ip) body.append("remoteip", ip);
      const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
      const out = await v.json();
      if (!out.success) return reply({ ok: false, error: "The human check expired. Please try again." }, 403);
    } catch {
      return reply({ ok: false, error: "Something went wrong. Please try again." }, 500);
    }
  }

  // The email's domain must be able to receive mail.
  if (!(await domainTakesMail(domain))) {
    return reply({ ok: false, error: "That email domain can't receive mail. Please check the address." }, 400);
  }

  try {
    await env.DB.prepare(
      "INSERT INTO signups (email, zip, source) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(email) DO UPDATE SET unsubscribed_at = NULL, zip = COALESCE(NULLIF(excluded.zip, ''), signups.zip)"
    ).bind(email, zip || null, source).run();
  } catch (e) {
    return reply({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
  return reply({ ok: true });
}

export async function onRequest() {
  return reply({ ok: false, error: "Use POST." }, 405);
}
