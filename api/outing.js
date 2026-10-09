// Hosted outings: a host creates an outing, anyone with the link adds their name and budget.
// Only the host (who holds the admin token) can edit or remove other people, change settings, or save the plan.
// Storage: Upstash Redis (Vercel Storage), read through its REST API, so no npm packages are needed.

const crypto = require("crypto");
const { sendPartyMail } = require("./_mail");
const quota = require("./_quota");

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 30; // outings expire after 30 days
const MAX_MEMBERS = 8;

const BUDGETS = { "khobar": [0, 600], "prague": [0, 5000], "istanbul": [0, 28000], "riyadh": [0, 600], "vienna": [0, 500], "toronto": [0, 800], "sharm-el-sheikh": [0, 28000], "barcelona": [0, 500], "berlin": [0, 500], "amsterdam": [0, 500], "lisbon": [0, 500], "rome": [0, 500], "miami": [0, 600], "houston": [0, 600], "mexico-city": [0, 10600], "montreal": [0, 800], "tokyo": [0, 85000], "seoul": [0, 800000], "bangkok": [0, 18900], "singapore": [0, 700], "marrakech": [0, 5400], "cape-town": [0, 10300], "buenos-aires": [0, 600], "rio": [0, 3200], "sao-paulo": [0, 3200], "sydney": [0, 900], "melbourne": [0, 900], "paris": [0, 500], "london": [0, 400], "dubai": [0, 2100], "madrid": [0, 500], "new-york": [0, 600], "los-angeles": [0, 600], "casablanca": [0, 5400] };
const VIBES = {
  night: ["chill", "cocktails", "dance", "club", "karaoke", "food", "cheap", "music", "rooftop"],
  day: ["museums", "contemporary", "galleries", "streetart", "architecture", "parks", "markets", "views", "conceptcafe"],
};

const clean = (s, n) => String(s ?? "").replace(/[\r\n"`<>]/g, " ").slice(0, n).trim();
const newId = () => {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  return [...crypto.randomBytes(8)].map(b => abc[b % abc.length]).join("");
};
const newToken = () => crypto.randomBytes(24).toString("hex");
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

async function kv(cmds) {
  const r = await fetch(KV_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("kv " + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const keys = id => ({ meta: `o:${id}`, members: `o:${id}:m`, plan: `o:${id}:p` });
const touch = id => { const k = keys(id); return [["EXPIRE", k.meta, TTL], ["EXPIRE", k.members, TTL], ["EXPIRE", k.plan, TTL]]; };

function member(raw, meta, prev = {}) {
  const [lo, hi] = BUDGETS[meta.city];
  const list = VIBES[meta.mode];
  const b = Number(raw?.budget);
  return {
    ...prev,
    nick: raw?.nick === undefined ? (prev.nick || "") : clean(raw.nick, 20),
    budget: raw?.budget != null && Number.isFinite(b) ? Math.min(hi, Math.max(lo, Math.round(b))) : (prev.budget ?? null),
    vibe: list.includes(raw?.vibe) ? raw.vibe : (prev.vibe || ""),
    flag: raw?.flag === undefined ? !!prev.flag : !!raw.flag,
    level: Number.isInteger(raw?.level) && raw.level >= 0 && raw.level <= 4 ? raw.level : (prev.level ?? null),
    minor: raw?.minor === undefined ? !!prev.minor : !!raw.minor,
  };
}

async function load(id) {
  const k = keys(id);
  const [meta, members, plan] = await kv([["GET", k.meta], ["HGETALL", k.members], ["GET", k.plan]]);
  if (!meta) return null;
  const m = {};
  for (let i = 0; i < (members || []).length; i += 2) m[members[i]] = JSON.parse(members[i + 1]);
  return { meta: JSON.parse(meta), members: m, plan: plan ? JSON.parse(plan) : null };
}

// signed in Tournée user behind this request, if any (same session store as /api/account)
async function sessionUid(req) {
  const h = String(req.headers?.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const [uid] = await kv([["GET", `s:${token}`]]);
  return uid || null;
}

function publicView(id, o) {
  const { admin, ...meta } = o.meta;
  const members = Object.entries(o.members)
    .map(([mid, m]) => ({ mid, uid: m.uid || null, minor: !!m.minor, nick: m.nick, level: m.level ?? null, vibe: m.vibe, flag: m.flag, host: !!m.host, t: m.t }))
    .sort((a, b) => a.t - b.t);
  return { id, ...meta, members, plan: o.plan };
}

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "no_store" });
  try {
    if (req.method === "GET") {
      const id = clean(req.query?.id, 12);
      const o = id && await load(id);
      if (!o) return res.status(404).json({ error: "not_found" });
      // replaced by a newer group with the same people and city: send visitors there
      if (o.meta.replacedBy) {
        const [alive] = await kv([["EXISTS", `o:${o.meta.replacedBy}`]]);
        if (alive) return res.status(410).json({ error: "moved", to: o.meta.replacedBy });
      }
      return res.status(200).json({ outing: publicView(id, o) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const action = body.action;

    if (action === "create") {
      const mode = body.mode === "day" ? "day" : "night";
      const city = BUDGETS[body.city] ? body.city : "paris";
      const id = newId(), admin = newToken();
      const meta = {
        mode, city, admin,
        area: clean(body.area, 40),
        start: /^\d{2}:\d{2}$/.test(body.start) ? body.start : "",
        end: /^\d{2}:\d{2}$/.test(body.end) ? body.end : "",
        stops: Math.min(5, Math.max(0, parseInt(body.stops, 10) || 0)),
        metro: body.metro === true,
        date: /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : "", // the outing's day (empty = today)
        created: Date.now(),
      };
      // the signed in creator owns the group: it shows in their account and they can delete it
      const owner = await sessionUid(req);
      if (owner) meta.owner = owner;
      // group size follows the host: you + 3 friends free, you + 10 with Tournée+
      let ownerU = null; if (owner) { const [raw] = await kv([["GET", `u:${owner}`]]); try { ownerU = JSON.parse(raw); } catch {} }
      meta.max = quota.groupMax(ownerU);
      const k = keys(id);
      await kv([["SET", k.meta, JSON.stringify(meta), "EX", TTL], ...(owner ? [["SADD", `g:${owner}`, id], ["EXPIRE", `g:${owner}`, TTL]] : [])]);
      const o = await load(id);
      return res.status(200).json({ adminToken: admin, outing: publicView(id, o) });
    }

    const id = clean(body.id, 12);
    const o = id && await load(id);
    if (!o) return res.status(404).json({ error: "not_found" });
    const k = keys(id);
    const isAdmin = same(body.adminToken, o.meta.admin);
    const me = await sessionUid(req);

    // the host (admin link) signed in: make sure the party is linked to their account and shows in "My parties"
    if (action === "claim") {
      if (!isAdmin || !me) return res.status(403).json({ error: "forbidden" });
      const cmds = [["SADD", `g:${me}`, id], ["EXPIRE", `g:${me}`, TTL]];
      if (!o.meta.owner) cmds.push(["SET", k.meta, JSON.stringify({ ...o.meta, owner: me }), "EX", TTL]);
      const [added] = await kv(cmds);
      return res.status(200).json({ ok: true, added: !!added });
    }

    // host only: delete the group for everyone
    if (action === "delete") {
      const hostUid = Object.values(o.members).find(m => m.host && m.uid)?.uid;
      if (!isAdmin && !(me && (o.meta.owner === me || hostUid === me))) return res.status(403).json({ error: "forbidden" });
      const uids = new Set([o.meta.owner, ...Object.values(o.members).map(m => m.uid)].filter(Boolean));
      await kv([["DEL", k.meta, k.members, k.plan], ...[...uids].map(u => ["SREM", `g:${u}`, id])]);
      return res.status(200).json({ ok: true });
    }

    if (action === "join") {
      if (Object.keys(o.members).length >= (o.meta.max || MAX_MEMBERS)) return res.status(409).json({ error: "full", max: o.meta.max || MAX_MEMBERS });
      const mid = newId(), token = newToken();
      const m = { ...member(body.member, o.meta), token, t: Date.now(), host: isAdmin && body.self === true };
      // link the row to a Tournée account: yourself, or (as host) one of your friends
      const wanted = clean(body.member?.uid, 20);
      if (me && (body.self === true || !isAdmin) && (!wanted || wanted === me)) m.uid = me;
      else if (me && isAdmin && wanted) {
        const [isFriend] = await kv([["SISMEMBER", `fr:${me}`, wanted]]);
        if (isFriend) m.uid = wanted;
      }
      if (m.uid && Object.values(o.members).some(x => x.uid === m.uid)) return res.status(409).json({ error: "already" });
      if (!isAdmin && !clean(body.member?.nick, 20)) return res.status(400).json({ error: "name" });
      const extra = m.uid ? [["SADD", `g:${m.uid}`, id], ["EXPIRE", `g:${m.uid}`, TTL]] : [];
      // a friend added by the host gets a notification (bell) in their account
      let mailFriend = null;
      if (m.uid && me && m.uid !== me) {
        const [hostRaw, friendRaw] = await kv([["GET", `u:${me}`], ["GET", `u:${m.uid}`]]);
        const from = hostRaw ? (JSON.parse(hostRaw).profile?.nick || "") : "";
        const f = friendRaw ? JSON.parse(friendRaw) : null;
        if (f && f.email && f.profile?.mail !== false) mailFriend = { to: f.email, lang: f.lang, kind: "added", from, city: o.meta.city, mode: o.meta.mode, outing: id };
        const note = { nid: newId(), type: "added", from, outing: id, city: o.meta.city, mode: o.meta.mode, at: Date.now() };
        extra.push(["LPUSH", `n:${m.uid}`, JSON.stringify(note)], ["LTRIM", `n:${m.uid}`, 0, 49]);
      }
      await kv([["HSET", k.members, mid, JSON.stringify(m)], ...touch(id), ...extra]);
      o.members[mid] = m;
      if (mailFriend) await sendPartyMail(mailFriend); // email the friend the host just added
      return res.status(200).json({ mid, token, outing: publicView(id, o) });
    }

    if (action === "update") {
      const prev = o.members[body.mid];
      if (!prev) return res.status(404).json({ error: "not_found" });
      if (!isAdmin && !same(body.token, prev.token) && !(me && prev.uid === me)) return res.status(403).json({ error: "forbidden" });
      const m = member(body.member, o.meta, prev);
      await kv([["HSET", k.members, body.mid, JSON.stringify(m)], ...touch(id)]);
      o.members[body.mid] = m;
      return res.status(200).json({ outing: publicView(id, o) });
    }

    if (action === "remove") {
      if (!isAdmin) return res.status(403).json({ error: "forbidden" });
      const gone = o.members[body.mid];
      await kv([["HDEL", k.members, String(body.mid)], ...touch(id), ...(gone && gone.uid ? [["SREM", `g:${gone.uid}`, id]] : [])]);
      delete o.members[body.mid];
      return res.status(200).json({ outing: publicView(id, o) });
    }

    if (action === "settings") {
      if (!isAdmin) return res.status(403).json({ error: "forbidden" });
      const meta = { ...o.meta };
      if (body.area !== undefined) meta.area = clean(body.area, 40);
      if (body.start !== undefined) meta.start = /^\d{2}:\d{2}$/.test(body.start) ? body.start : "";
      if (body.end !== undefined) meta.end = /^\d{2}:\d{2}$/.test(body.end) ? body.end : "";
      if (body.stops !== undefined) meta.stops = Math.min(5, Math.max(0, parseInt(body.stops, 10) || 0));
      if (body.metro !== undefined) meta.metro = !!body.metro;
      if (body.date !== undefined) meta.date = /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : "";
      await kv([["SET", k.meta, JSON.stringify(meta), "EX", TTL], ...touch(id)]);
      o.meta = meta;
      return res.status(200).json({ outing: publicView(id, o) });
    }

    if (action === "plan") {
      if (!isAdmin) return res.status(403).json({ error: "forbidden" });
      const text = JSON.stringify(body.plan || null);
      if (!body.plan || !Array.isArray(body.plan.etapes) || text.length > 40000) return res.status(400).json({ error: "bad_plan" });
      await kv([["SET", k.plan, text, "EX", TTL], ...touch(id)]);
      o.plan = body.plan;
      return res.status(200).json({ outing: publicView(id, o) });
    }

    return res.status(400).json({ error: "action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
