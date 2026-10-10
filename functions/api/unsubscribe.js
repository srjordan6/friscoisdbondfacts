// POST /api/unsubscribe: removes a subscriber from the update list.
// Accepts the subscriber's unsubscribe code either as ?t=<code> in the URL (used by the one-click
// List-Unsubscribe header that Gmail and Yahoo call, RFC 8058) or as JSON { token } from the
// /unsubscribe page. GET requests never unsubscribe anyone, so link scanners cannot trigger it.
// Per the privacy policy, only the email address and the fact of unsubscribing are kept.

const TOKEN_RE = /^[a-f0-9]{48}$/;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  let token = (url.searchParams.get("t") || "").trim().toLowerCase();
  if (!token && (request.headers.get("content-type") || "").includes("application/json")) {
    try { token = String((await request.json()).token || "").trim().toLowerCase(); } catch {}
  }
  if (!TOKEN_RE.test(token)) {
    return reply({ ok: false, error: "This unsubscribe link is not valid. Email info@friscoisdbondfacts.com and we will remove you." }, 400);
  }
  try {
    const row = await env.DB.prepare("SELECT id, unsubscribed_at FROM signups WHERE unsub_token = ?1").bind(token).first();
    if (!row) {
      return reply({ ok: false, error: "We could not find this subscription. It may already be removed. Email info@friscoisdbondfacts.com if you still get updates." }, 404);
    }
    if (!row.unsubscribed_at) {
      await env.DB.prepare(
        "UPDATE signups SET unsubscribed_at = datetime('now'), first_name = NULL, zip = NULL, source = NULL, token_hash = NULL WHERE id = ?1"
      ).bind(row.id).run();
    }
    return reply({ ok: true });
  } catch (e) {
    console.log("unsubscribe error", String(e).slice(0, 300));
    return reply({ ok: false, error: "Something went wrong. Please try again, or email info@friscoisdbondfacts.com." }, 500);
  }
}

export async function onRequest() {
  return reply({ ok: false, error: "Use POST." }, 405);
}
