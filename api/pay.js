// Payments with Stripe (no npm package, plain REST calls).
// Switched OFF until STRIPE_SECRET_KEY is set in Vercel: the site then shows "coming soon".
// Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (from the webhook you create in Stripe, pointing to
// https://tournee.site/api/pay?hook=1 with the events checkout.session.completed,
// customer.subscription.created, customer.subscription.updated, customer.subscription.deleted).
//
// GET  /api/pay                          -> { enabled }
// POST /api/pay {action:"checkout", product:"pack3"|"pack5"|"plus"}  (signed in) -> { url } to Stripe Checkout
// POST /api/pay {action:"portal"}        (signed in, Tournée+) -> { url } to manage or cancel the subscription
// POST /api/pay?hook=1                   Stripe webhook: adds extra plans or turns Tournée+ on and off

const crypto = require("crypto");
const quota = require("./_quota");
const { kv } = quota;

const SITE = "https://tournee.site";
const PRODUCTS = {
  pack3: { mode: "payment", amount: 50, plans: 3, name: { fr: "3 plans Tournée", en: "3 Tournée plans", es: "3 planes Tournée" } },
  pack5: { mode: "payment", amount: 100, plans: 5, name: { fr: "5 plans Tournée", en: "5 Tournée plans", es: "5 planes Tournée" } },
  plus: { mode: "subscription", amount: 999, name: { fr: "Tournée+ (plans illimités)", en: "Tournée+ (unlimited plans)", es: "Tournée+ (planes ilimitados)" } },
};

// Stripe expects form encoding with bracket keys
function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  }
  return out.join("&");
}
async function stripe(path, params, method = "POST") {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? form(params || {}) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("stripe " + r.status + " " + (d.error?.message || ""));
  return d;
}

// the signature is checked on the exact bytes Stripe sent, so read the stream (never touch req.body here:
// on Vercel reading req.body parses the JSON and the original text is lost)
async function rawBody(req) {
  const chunks = []; for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}
function verify(raw, header, secret) {
  const parts = Object.fromEntries(String(header || "").split(",").map(p => p.split("=")).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header || "").split(",").filter(p => p.trim().startsWith("v1=")).map(p => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

async function getUser(uid) { const [raw] = await kv([["GET", `u:${uid}`]]); try { return raw ? JSON.parse(raw) : null; } catch { return null; } }
const saveUser = u => kv([["SET", `u:${u.uid}`, JSON.stringify(u)]]);
const periodEnd = sub => 1000 * Number(sub.current_period_end || sub.items?.data?.[0]?.current_period_end || 0);

async function onEvent(ev) {
  const o = ev.data?.object || {};
  if (ev.type === "checkout.session.completed") {
    const uid = o.client_reference_id || o.metadata?.uid, product = o.metadata?.product;
    const u = uid && await getUser(uid); if (!u) return;
    if (o.customer && u.stripeCustomer !== o.customer) { u.stripeCustomer = o.customer; await saveUser(u); }
    if (PRODUCTS[product]?.plans && o.payment_status === "paid") await kv([["INCRBY", `cr:${uid}`, PRODUCTS[product].plans]]);
    if (product === "plus" && o.subscription) {
      const sub = await stripe("subscriptions/" + o.subscription, null, "GET").catch(() => null);
      u.pro = { sub: o.subscription, until: sub ? periodEnd(sub) : Date.now() + 32 * 864e5 };
      await saveUser(u);
    }
    return;
  }
  if (ev.type.startsWith("customer.subscription.")) {
    const uid = o.metadata?.uid; const u = uid && await getUser(uid); if (!u) return;
    const live = ["active", "trialing", "past_due"].includes(o.status) && ev.type !== "customer.subscription.deleted";
    u.pro = { sub: o.id, until: live ? periodEnd(o) : Date.now() };
    if (o.customer) u.stripeCustomer = o.customer;
    await saveUser(u);
  }
}

// with Stripe TEST keys (sk_test_...), only the owner's admin account can pay (fake cards), nobody else sees it
const testMode = () => String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test_");
module.exports = async (req, res) => {
  let enabled = !!process.env.STRIPE_SECRET_KEY;
  if (req.method === "GET") {
    if (enabled && testMode() && quota.ready()) { const who = await quota.account(req).catch(() => null); enabled = !!(who && who.u.admin); }
    return res.status(200).json({ enabled, test: enabled && testMode() });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!quota.ready()) return res.status(500).json({ error: "no_store" });

  // Stripe webhook
  if (req.query?.hook) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const raw = await rawBody(req);
    if (!secret || !verify(raw, req.headers["stripe-signature"], secret)) return res.status(400).json({ error: "signature" });
    let ev; try { ev = JSON.parse(raw); } catch { return res.status(400).json({ error: "json" }); }
    const [fresh] = await kv([["SET", `evt:${ev.id}`, "1", "NX", "EX", 60 * 60 * 24 * 7]]); // each event once
    if (fresh) { try { await onEvent(ev); } catch (e) { console.error(e); await kv([["DEL", `evt:${ev.id}`]]); return res.status(500).json({ error: "retry" }); } }
    return res.status(200).json({ received: true });
  }

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!enabled) return res.status(503).json({ error: "soon" });
  const who = await quota.account(req);
  if (!who) return res.status(401).json({ error: "signed_out" });
  const { uid, u } = who;
  if (testMode() && !u.admin) return res.status(503).json({ error: "soon" });
  const lang = ["fr", "en", "es"].includes(body.lang) ? body.lang : (u.lang || "fr");

  try {
    if (body.action === "checkout") {
      const p = PRODUCTS[body.product];
      if (!p) return res.status(400).json({ error: "product" });
      if (body.product === "plus" && quota.isPro(u)) return res.status(409).json({ error: "already" });
      const price = { currency: "eur", unit_amount: p.amount, product_data: { name: p.name[lang] }, ...(p.mode === "subscription" ? { recurring: { interval: "month" } } : {}) };
      const params = {
        mode: p.mode, locale: lang, client_reference_id: uid,
        line_items: { 0: { price_data: price, quantity: 1 } },
        metadata: { uid, product: body.product },
        success_url: `${SITE}/account?paid=${body.product}`, cancel_url: `${SITE}/account?paid=0`,
        ...(u.stripeCustomer ? { customer: u.stripeCustomer } : u.email ? { customer_email: u.email } : {}),
        ...(p.mode === "subscription" ? { subscription_data: { metadata: { uid } } } : { customer_creation: u.stripeCustomer ? undefined : "always" }),
      };
      const s = await stripe("checkout/sessions", params);
      return res.status(200).json({ url: s.url });
    }
    if (body.action === "portal") {
      if (!u.stripeCustomer) return res.status(404).json({ error: "no_customer" });
      const s = await stripe("billing_portal/sessions", { customer: u.stripeCustomer, return_url: `${SITE}/account`, locale: lang });
      return res.status(200).json({ url: s.url });
    }
    return res.status(400).json({ error: "action" });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "stripe" });
  }
};
