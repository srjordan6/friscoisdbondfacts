// Gate for every /api/admin/* route.
// Requires a valid Cloudflare Access login (signed JWT) for an email listed in ADMIN_EMAILS.
// The signature, audience, issuer, and expiry are all checked here, so the admin API stays locked
// even if someone reaches it through the *.pages.dev address, where Access is not applied.
// Config (wrangler.toml [vars]): ACCESS_TEAM (e.g. yourteam.cloudflareaccess.com), ACCESS_AUD, ADMIN_EMAILS.

function deny(status, error) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function cookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : "";
}

let certCache = { at: 0, keys: [] };

async function accessEmail(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch { return null; }
  if (header.alg !== "RS256") return null;

  if (!certCache.keys.length || Date.now() - certCache.at > 3600_000) {
    const r = await fetch(`https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`);
    if (!r.ok) return null;
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now + 60) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM}`) return null;
  return String(payload.email || "").toLowerCase() || null;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD || !env.ADMIN_EMAILS) {
    return deny(503, "The admin area is not set up yet (Cloudflare Access settings are missing).");
  }
  let email = null;
  try { email = await accessEmail(request, env); } catch { email = null; }
  if (!email) return deny(401, "Please sign in through Cloudflare Access.");
  const allowed = String(env.ADMIN_EMAILS).toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(email)) return deny(403, "This account is not allowed to use the admin area.");
  context.data.adminEmail = email;
  return context.next();
}
