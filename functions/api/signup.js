// POST /api/signup: stores an email (and optional ZIP) for bond updates.
// Fields: email (required), zip (optional), source (optional), website (honeypot, must be empty).

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

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

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return reply({ ok: false, error: "Please enter a valid email address." }, 400);
  }
  if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) {
    return reply({ ok: false, error: "ZIP code should be 5 digits." }, 400);
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
