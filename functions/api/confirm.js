// POST /api/confirm: finishes a signup. Body: { token }.
// The confirmation link carries the token in the URL fragment (#...), which browsers never send to
// servers, and the /confirm page asks for a button tap. Email security scanners that pre-open links
// therefore cannot confirm anyone by accident.

const LINK_HOURS = 72;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }) {
  let token = "";
  try { token = String((await request.json()).token || "").trim(); } catch {}
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) {
    return reply({ ok: false, error: "This confirmation link is not valid. Please sign up again." }, 400);
  }
  try {
    const hash = await sha256Hex(token);
    const row = await env.DB.prepare(
      `SELECT id, first_name FROM signups WHERE token_hash = ?1 AND token_sent_at > datetime('now', '-${LINK_HOURS} hours')`
    ).bind(hash).first();
    if (!row) {
      return reply({ ok: false, error: "This link has expired or was already used. Please sign up again to get a new one." }, 410);
    }
    await env.DB.prepare(
      "UPDATE signups SET confirmed_at = datetime('now'), unsubscribed_at = NULL, token_hash = NULL, " +
      "unsub_token = COALESCE(unsub_token, lower(hex(randomblob(24)))) WHERE id = ?1"
    ).bind(row.id).run();
    return reply({ ok: true, first_name: row.first_name || "" });
  } catch (e) {
    console.log("confirm error", String(e).slice(0, 300));
    return reply({ ok: false, error: "Something went wrong. Please try the link again." }, 500);
  }
}

export async function onRequest() {
  return reply({ ok: false, error: "Use POST." }, 405);
}
