// Hosted outings: a host creates an outing, anyone with the link adds their name and budget.
// Only the host (who holds the admin token) can edit or remove other people, change settings, or save the plan.
// Storage: Upstash Redis (Vercel Storage), read through its REST API, so no npm packages are needed.

const crypto = require("crypto");

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 30; // outings expire after 30 days
const MAX_MEMBERS = 8;

const BUDGETS = { paris: [10, 100], london: [10, 100], dubai: [50, 600], madrid: [10, 100], "new-york": [10, 150], "los-angeles": [10, 150], casablanca: [100, 1000] };
const VIBES = {
  night: ["chill", "cocktails", "dance", "karaoke", "food", "cheap", "music", "rooftop"],
  day: ["museums", "contemporary", "galleries", "streetart", "architecture", "parks", "markets", "views"],
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

function publicView(id, o) {
  const { admin, ...meta } = o.meta;
  const members = Object.entries(o.members)
    .map(([mid, m]) => ({ mid, nick: m.nick, budget: m.budget, vibe: m.vibe, flag: m.flag, host: !!m.host, t: m.t }))
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
        stops: Math.min(5, Math.max(0, parseInt(body.stops, 10) || 0)),
        metro: body.metro === true,
        created: Date.now(),
      };
      const k = keys(id);
      await kv([["SET", k.meta, JSON.stringify(meta), "EX", TTL]]);
      const o = await load(id);
      return res.status(200).json({ adminToken: admin, outing: publicView(id, o) });
    }

    const id = clean(body.id, 12);
    const o = id && await load(id);
    if (!o) return res.status(404).json({ error: "not_found" });
    const k = keys(id);
    const isAdmin = same(body.adminToken, o.meta.admin);

    if (action === "join") {
      if (Object.keys(o.members).length >= MAX_MEMBERS) return res.status(409).json({ error: "full" });
      const mid = newId(), token = newToken();
      const m = { ...member(body.member, o.meta), token, t: Date.now(), host: isAdmin && body.self === true };
      if (!isAdmin && !clean(body.member?.nick, 20)) return res.status(400).json({ error: "name" });
      await kv([["HSET", k.members, mid, JSON.stringify(m)], ...touch(id)]);
      o.members[mid] = m;
      return res.status(200).json({ mid, token, outing: publicView(id, o) });
    }

    if (action === "update") {
      const prev = o.members[body.mid];
      if (!prev) return res.status(404).json({ error: "not_found" });
      if (!isAdmin && !same(body.token, prev.token)) return res.status(403).json({ error: "forbidden" });
      const m = member(body.member, o.meta, prev);
      await kv([["HSET", k.members, body.mid, JSON.stringify(m)], ...touch(id)]);
      o.members[body.mid] = m;
      return res.status(200).json({ outing: publicView(id, o) });
    }

    if (action === "remove") {
      if (!isAdmin) return res.status(403).json({ error: "forbidden" });
      await kv([["HDEL", k.members, String(body.mid)], ...touch(id)]);
      delete o.members[body.mid];
      return res.status(200).json({ outing: publicView(id, o) });
    }

    if (action === "settings") {
      if (!isAdmin) return res.status(403).json({ error: "forbidden" });
      const meta = { ...o.meta };
      if (body.area !== undefined) meta.area = clean(body.area, 40);
      if (body.start !== undefined) meta.start = /^\d{2}:\d{2}$/.test(body.start) ? body.start : "";
      if (body.stops !== undefined) meta.stops = Math.min(5, Math.max(0, parseInt(body.stops, 10) || 0));
      if (body.metro !== undefined) meta.metro = !!body.metro;
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
