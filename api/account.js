// Accounts: sign in with Google, a profile reused when planning, and friends added through invite links.
// Env: GOOGLE_CLIENT_ID (OAuth web client) + the Upstash Redis vars already used by outings.
// Stored per user: a random id, the display name, the planning profile, a friend code and the friend list.
// No email, no photo, no Google token is kept.

const crypto = require("crypto");
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_TTL = 60 * 60 * 24 * 60; // 60 days

const VIBES = {
  night: ["chill", "cocktails", "dance", "karaoke", "food", "cheap", "music", "rooftop"],
  day: ["museums", "contemporary", "galleries", "streetart", "architecture", "parks", "markets", "views"],
};
const clean = (s, n) => String(s ?? "").replace(/[\r\n<>"`]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const rid = n => { const abc = "abcdefghjkmnpqrstuvwxyz23456789"; return [...crypto.randomBytes(n)].map(b => abc[b % abc.length]).join(""); };

async function kv(cmds) {
  const r = await fetch(KV_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("kv " + r.status);
  return (await r.json()).map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

const publicView = u => ({ uid: u.uid, nick: u.profile.nick, level: u.profile.level, vibeNight: u.profile.vibeNight, vibeDay: u.profile.vibeDay, sober: u.profile.sober, student: u.profile.student });

function cleanProfile(p, prev) {
  const lv = Number.isInteger(p?.level) && p.level >= 0 && p.level <= 4 ? p.level : (p?.level === null ? null : prev.level ?? null);
  return {
    nick: clean(p?.nick ?? prev.nick, 20) || prev.nick || "?",
    level: lv,
    vibeNight: VIBES.night.includes(p?.vibeNight) ? p.vibeNight : (p?.vibeNight === "" ? "" : prev.vibeNight || ""),
    vibeDay: VIBES.day.includes(p?.vibeDay) ? p.vibeDay : (p?.vibeDay === "" ? "" : prev.vibeDay || ""),
    sober: p?.sober === undefined ? !!prev.sober : !!p.sober,
    student: p?.student === undefined ? !!prev.student : !!p.student,
  };
}

async function getUser(uid) { const [raw] = await kv([["GET", `u:${uid}`]]); return raw ? JSON.parse(raw) : null; }
async function friendsOf(uid) {
  const [ids] = await kv([["SMEMBERS", `fr:${uid}`]]);
  if (!ids || !ids.length) return [];
  const raws = await kv(ids.map(id => ["GET", `u:${id}`]));
  return raws.filter(Boolean).map(r => publicView(JSON.parse(r))).sort((a, b) => a.nick.localeCompare(b.nick));
}
async function auth(req) {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const [uid] = await kv([["GET", `s:${token}`]]);
  if (!uid) return null;
  const u = await getUser(uid);
  return u ? { u, token } : null;
}
async function verifyGoogle(credential) {
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  if (!r.ok) return null;
  const t = await r.json();
  const okIss = t.iss === "accounts.google.com" || t.iss === "https://accounts.google.com";
  if (!okIss || t.aud !== CLIENT_ID || Number(t.exp) * 1000 < Date.now() || !t.sub) return null;
  return { sub: String(t.sub), name: clean(t.given_name || t.name || "", 20) };
}

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ clientId: CLIENT_ID || null, ready: !!(CLIENT_ID && KV_URL && KV_TOKEN), contact: clean(process.env.CONTACT_EMAIL || "", 120) || null });
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!KV_URL || !KV_TOKEN || !CLIENT_ID) return res.status(500).json({ error: "no_accounts" });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = body.action;

  try {
    if (action === "login") {
      const g = await verifyGoogle(String(body.credential || ""));
      if (!g) return res.status(401).json({ error: "bad_login" });
      const subKey = "gsub:" + crypto.createHash("sha256").update(g.sub).digest("hex");
      let [uid] = await kv([["GET", subKey]]);
      let u = uid ? await getUser(uid) : null;
      if (!u) {
        uid = rid(12);
        const code = rid(8);
        u = { uid, code, sk: subKey, created: Date.now(), profile: cleanProfile({ nick: g.name || "Moi" }, {}) };
        await kv([["SET", `u:${uid}`, JSON.stringify(u)], ["SET", subKey, uid], ["SET", `fc:${code}`, uid]]);
      }
      const token = crypto.randomBytes(24).toString("hex");
      await kv([["SET", `s:${token}`, uid, "EX", SESSION_TTL], ["SADD", `us:${uid}`, token]]);
      return res.status(200).json({ token, me: { ...publicView(u), code: u.code }, friends: await friendsOf(uid) });
    }

    if (action === "peek") {
      const code = clean(body.code, 12);
      const [uid] = await kv([["GET", `fc:${code}`]]);
      const u = uid ? await getUser(uid) : null;
      return u ? res.status(200).json({ nick: u.profile.nick }) : res.status(404).json({ error: "not_found" });
    }

    const a = await auth(req);
    if (!a) return res.status(401).json({ error: "signed_out" });
    const { u, token } = a;

    if (action === "me") return res.status(200).json({ me: { ...publicView(u), code: u.code }, friends: await friendsOf(u.uid) });

    if (action === "profile") {
      u.profile = cleanProfile(body.profile || {}, u.profile);
      await kv([["SET", `u:${u.uid}`, JSON.stringify(u)]]);
      return res.status(200).json({ me: { ...publicView(u), code: u.code } });
    }

    if (action === "addFriend") {
      const code = clean(body.code, 12);
      const [fid] = await kv([["GET", `fc:${code}`]]);
      if (!fid) return res.status(404).json({ error: "not_found" });
      if (fid === u.uid) return res.status(400).json({ error: "self" });
      const [count] = await kv([["SCARD", `fr:${u.uid}`]]);
      if (count >= 200) return res.status(409).json({ error: "full" });
      await kv([["SADD", `fr:${u.uid}`, fid], ["SADD", `fr:${fid}`, u.uid]]);
      const f = await getUser(fid);
      return res.status(200).json({ added: f ? f.profile.nick : "", friends: await friendsOf(u.uid) });
    }

    if (action === "removeFriend") {
      const fid = clean(body.uid, 20);
      await kv([["SREM", `fr:${u.uid}`, fid], ["SREM", `fr:${fid}`, u.uid]]);
      return res.status(200).json({ friends: await friendsOf(u.uid) });
    }

    if (action === "logout") {
      await kv([["DEL", `s:${token}`], ["SREM", `us:${u.uid}`, token]]);
      return res.status(200).json({ ok: true });
    }

    if (action === "delete") {
      const [friendIds, tokens] = await kv([["SMEMBERS", `fr:${u.uid}`], ["SMEMBERS", `us:${u.uid}`]]);
      const cmds = (friendIds || []).map(f => ["SREM", `fr:${f}`, u.uid]);
      (tokens || []).forEach(t => cmds.push(["DEL", `s:${t}`]));
      cmds.push(["DEL", `u:${u.uid}`, `fr:${u.uid}`, `us:${u.uid}`, `fc:${u.code}`]);
      if (u.sk) cmds.push(["DEL", u.sk]);
      await kv(cmds);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
