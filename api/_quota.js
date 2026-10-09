// Plan limits (helper, not a route).
// Free account: 5 plans a day (Paris time), plus extra plans bought in packs that never expire.
// Tournée+ (subscription): unlimited plans. The owner's admin account: unlimited.
// Guests (no account): 1 plan, then they have to sign up.
// Party plans count against the host; the first party a person ever hosts gets one free plan.
// Group size: you + 3 friends for free, you + 10 friends with Tournée+.

const crypto = require("crypto");
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const FREE_DAILY = 5;
const GROUP_FREE = 4;   // you + 3 friends
const GROUP_PRO = 11;   // you + 10 friends
const GUEST_TRIES = 1;

async function kv(cmds) {
  const r = await fetch(KV_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("kv " + r.status);
  return (await r.json()).map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const ready = () => !!(KV_URL && KV_TOKEN);
const day = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const hash = s => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
const isPro = u => !!(u && u.pro && Number(u.pro.until) > Date.now());
const isAdmin = u => !!(u && u.admin);
const groupMax = u => (isPro(u) || isAdmin(u)) ? GROUP_PRO : GROUP_FREE;

// signed in user behind the request (same sessions as /api/account)
async function account(req) {
  const h = String(req.headers?.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const [uid] = await kv([["GET", `s:${token}`]]);
  if (!uid) return null;
  const [raw] = await kv([["GET", `u:${uid}`]]);
  try { return raw ? { uid, u: JSON.parse(raw) } : null; } catch { return null; }
}

// one time gift of 5 plans when someone first runs out, tied to the email (or the account if no email)
const GIFT = 5;
const giftKey = (uid, u) => u.email ? `gift:${hash(String(u.email).trim().toLowerCase())}` : `gift:u:${uid}`;

// what the page shows: plans left today, stored extra plans, Tournée+, gift still available
async function status(uid, u) {
  if (isAdmin(u) || isPro(u)) return { unlimited: true, pro: isPro(u), admin: isAdmin(u), proUntil: isPro(u) ? Number(u.pro.until) : null, groupMax: GROUP_PRO, daily: FREE_DAILY };
  const [used, credits, gift] = await kv([["GET", `q:${uid}:${day()}`], ["GET", `cr:${uid}`], ["EXISTS", giftKey(uid, u)]]);
  return { unlimited: false, pro: false, left: Math.max(0, FREE_DAILY - (Number(used) || 0)), credits: Math.max(0, Number(credits) || 0), groupMax: GROUP_FREE, daily: FREE_DAILY, giftAvailable: !gift && !u.giftUsed };
}
// only when everything is used up, once per email
async function claimGift(uid, u) {
  const st = await status(uid, u);
  if (st.unlimited || st.left > 0 || st.credits > 0) return { error: "not_now" };
  const [ok] = await kv([["SET", giftKey(uid, u), uid, "NX"]]);
  if (!ok || u.giftUsed) return { error: "gift_used" };
  u.giftUsed = true;
  await kv([["INCRBY", `cr:${uid}`, GIFT], ["SET", `u:${uid}`, JSON.stringify(u)]]);
  return { ok: true, status: await status(uid, u) };
}

// take one plan from the right bucket. Returns { ok, refund(), status } or { error }.
async function consume(req, body) {
  const who = await account(req);
  if (!who) {
    // guest: one try per device, with a loose per network cap against abuse
    const dev = /^[a-z0-9]{16,64}$/.test(String(body.device || "")) ? body.device : "";
    if (!dev) return { error: "signup" };
    const ip = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    const dk = `gt:${hash(dev)}`, nk = `gn:${hash(ip)}:${day()}`;
    const [n, net] = await kv([["INCR", dk], ["INCR", nk], ["EXPIRE", dk, 60 * 60 * 24 * 365], ["EXPIRE", nk, 60 * 60 * 26]]);
    if (n > GUEST_TRIES || net > 30) { await kv([["DECR", dk], ["DECR", nk]]); return { error: "signup" }; }
    return { ok: true, guest: true, groupMax: GROUP_FREE, refund: () => kv([["DECR", dk], ["DECR", nk]]).catch(() => {}), status: () => ({ guest: true, left: 0 }) };
  }
  const { uid, u } = who;
  if (u.banned && (!u.banned.until || u.banned.until > Date.now())) return { error: "signup" };
  const st = () => status(uid, u);
  if (isAdmin(u) || isPro(u)) return { ok: true, uid, groupMax: GROUP_PRO, refund: async () => {}, status: st };

  // first party ever hosted: that plan is free
  const oid = String(body.outing || "").slice(0, 12);
  if (oid && !u.hosted) {
    const [metaRaw] = await kv([["GET", `o:${oid}`]]);
    let meta = null; try { meta = JSON.parse(metaRaw); } catch {}
    if (meta && meta.owner === uid) {
      u.hosted = true;
      await kv([["SET", `u:${uid}`, JSON.stringify(u)]]);
      return { ok: true, uid, groupMax: GROUP_FREE, refund: async () => { u.hosted = false; await kv([["SET", `u:${uid}`, JSON.stringify(u)]]).catch(() => {}); }, status: st };
    }
  }

  // daily free plans first, then stored extra plans
  const qk = `q:${uid}:${day()}`;
  const [n] = await kv([["INCR", qk], ["EXPIRE", qk, 60 * 60 * 48]]);
  if (n <= FREE_DAILY) return { ok: true, uid, groupMax: GROUP_FREE, refund: () => kv([["DECR", qk]]).catch(() => {}), status: st };
  await kv([["DECR", qk]]);
  const [c] = await kv([["DECR", `cr:${uid}`]]);
  if (c >= 0) return { ok: true, uid, groupMax: GROUP_FREE, refund: () => kv([["INCR", `cr:${uid}`]]).catch(() => {}), status: st };
  await kv([["INCR", `cr:${uid}`]]);
  return { error: "quota", status: await st() };
}

module.exports = { ready, kv, account, status, consume, claimGift, groupMax, isPro, FREE_DAILY, GROUP_FREE, GROUP_PRO };
