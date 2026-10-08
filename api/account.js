// Accounts: sign in with Google, a profile reused when planning, and friends added through invite links.
// Env: GOOGLE_CLIENT_ID (OAuth web client) + the Upstash Redis vars already used by outings.
// Stored per user: a random id, the display name, the planning profile, a friend code, the friend list,
// the email (only to send party invites, which can be turned off in the profile) and the site language.
// No photo and no Google token is kept.

const crypto = require("crypto");
const { sendPartyMail, sendResetMail } = require("./_mail");
const LANG_OK = ["fr", "en", "es"];
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_TTL = 60 * 60 * 24 * 60; // 60 days

const VIBES = {
  night: ["chill", "cocktails", "dance", "club", "karaoke", "food", "cheap", "music", "rooftop"],
  day: ["museums", "contemporary", "galleries", "streetart", "architecture", "parks", "markets", "views", "conceptcafe"],
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

// the owner's account: whoever signs in with the email set in ADMIN_EMAIL (Vercel) gets admin rights.
// The email itself is only compared at sign in, never stored for Google accounts.
const isAdminEmail = e => !!process.env.ADMIN_EMAIL && !!e && String(e).trim().toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase();
const meView = u => ({ ...publicView(u), code: u.code, admin: !!u.admin, mail: u.profile.mail !== false });
const publicView = u => ({ uid: u.uid, nick: u.profile.nick, level: u.profile.level, vibeNight: u.profile.vibeNight, vibeDay: u.profile.vibeDay, sober: u.profile.sober, student: u.profile.student, minor: !!u.profile.minor });

function cleanProfile(p, prev) {
  const lv = Number.isInteger(p?.level) && p.level >= 0 && p.level <= 4 ? p.level : (p?.level === null ? null : prev.level ?? null);
  return {
    nick: clean(p?.nick ?? prev.nick, 20) || prev.nick || "?",
    level: lv,
    vibeNight: VIBES.night.includes(p?.vibeNight) ? p.vibeNight : (p?.vibeNight === "" ? "" : prev.vibeNight || ""),
    vibeDay: VIBES.day.includes(p?.vibeDay) ? p.vibeDay : (p?.vibeDay === "" ? "" : prev.vibeDay || ""),
    sober: p?.sober === undefined ? !!prev.sober : !!p.sober,
    student: p?.student === undefined ? !!prev.student : !!p.student,
    minor: p?.minor === undefined ? !!prev.minor : !!p.minor,
    mail: p?.mail === undefined ? prev.mail !== false : !!p.mail,
  };
}

async function getUser(uid) { const [raw] = await kv([["GET", `u:${uid}`]]); return raw ? JSON.parse(raw) : null; }
async function friendsOf(uid) {
  const [ids] = await kv([["SMEMBERS", `fr:${uid}`]]);
  if (!ids || !ids.length) return [];
  const raws = await kv(ids.map(id => ["GET", `u:${id}`]));
  return raws.filter(Boolean).map(r => publicView(JSON.parse(r))).sort((a, b) => a.nick.localeCompare(b.nick));
}
async function historyOf(uid) {
  const [rows] = await kv([["LRANGE", `h:${uid}`, 0, 49]]);
  return (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
// deleted outings go to an archive for 3 days, then they are gone for good
const ARCHIVE_MS = 3 * 24 * 60 * 60 * 1000;
const listCmds = (key, arr, ttlSec) => {
  const c = [["DEL", key]];
  if (arr.length) { c.push(["RPUSH", key, ...arr.map(x => JSON.stringify(x))]); if (ttlSec) c.push(["EXPIRE", key, ttlSec]); }
  return c;
};
async function archiveOf(uid) {
  const [rows] = await kv([["LRANGE", `ha:${uid}`, 0, 199]]);
  const all = (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  const live = all.filter(x => Date.now() - (x.deletedAt || 0) < ARCHIVE_MS);
  if (live.length !== all.length) await kv(listCmds(`ha:${uid}`, live, ARCHIVE_MS / 1000));
  return live;
}
const MODES_OK = ["night", "day"];
function cleanEntry(b) {
  const plan = b.plan || {};
  const stops = (Array.isArray(plan.etapes) ? plan.etapes : []).slice(0, 6).map(s => ({
    lieu: clean(s.lieu, 80), type: clean(s.type, 40), area: clean(s.adresse || s.quartier, 80), billet: s.billet === true,
  })).filter(s => s.lieu);
  if (!stops.length) return null;
  return {
    id: rid(10), at: Date.now(),
    city: clean(b.city, 30), mode: MODES_OK.includes(b.mode) ? b.mode : "night",
    title: clean(plan.titre, 80), stops,
    people: (Array.isArray(b.people) ? b.people : []).slice(0, 8).map(p => ({ nick: clean(p?.nick, 20) || "?", uid: clean(p?.uid, 20) || null })),
    settings: { area: clean(b.settings?.area, 40), start: /^\d{2}:\d{2}$/.test(b.settings?.start) ? b.settings.start : "", end: /^\d{2}:\d{2}$/.test(b.settings?.end) ? b.settings.end : "", stops: Math.min(5, Math.max(0, parseInt(b.settings?.stops, 10) || 0)) },
  };
}

// outings in progress this user is part of (hosted outings expire after 30 days)
async function groupsOf(uid) {
  const [ids] = await kv([["SMEMBERS", `g:${uid}`]]);
  if (!ids || !ids.length) return [];
  const metas = await kv(ids.map(id => ["GET", `o:${id}`]));
  const lens = await kv(ids.map(id => ["HLEN", `o:${id}:m`]));
  const mems = await kv(ids.map(id => ["HVALS", `o:${id}:m`]));
  const plans = await kv(ids.map(id => ["EXISTS", `o:${id}:p`]));
  const out = [], dead = [];
  ids.forEach((id, i) => {
    if (!metas[i]) { dead.push(id); return; }
    const m = JSON.parse(metas[i]);
    if (m.replacedBy) { dead.push(id); return; }
    const rows = (mems[i] || []).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    const uids = rows.map(x => x.uid).filter(Boolean);
    const host = m.owner === uid || rows.some(x => x.host && x.uid === uid);
    // same people (account, or first name for guests) + same city + same mode = same group
    const sig = rows.length >= 2 ? [m.mode, m.city, ...rows.map(x => x.uid || "n:" + String(x.nick || "").toLowerCase()).sort()].join("|") : null;
    out.push({ id, city: m.city, mode: m.mode, created: m.created || 0, count: lens[i] || 0, uids, status: plans[i] ? "ready" : "waiting", host, sig, meta: m });
  });
  // a newer group with the same people and city replaces the older ones (their link redirects to it)
  out.sort((a, b) => b.created - a.created);
  const newest = {}, cmds = [];
  const keep = out.filter(g => {
    if (!g.sig) return true;
    if (!newest[g.sig]) { newest[g.sig] = g.id; return true; }
    dead.push(g.id);
    cmds.push(["SET", `o:${g.id}`, JSON.stringify({ ...g.meta, replacedBy: newest[g.sig] }), "EX", 60 * 60 * 24 * 30]);
    return false;
  });
  if (dead.length) cmds.push(["SREM", `g:${uid}`, ...dead]);
  if (cmds.length) await kv(cmds);
  return keep.map(({ sig, meta, ...g }) => g);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const scrypt = (pw, salt) => new Promise((ok, ko) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? ko(e) : ok(k)));
async function openSession(u) {
  const token = crypto.randomBytes(24).toString("hex");
  await kv([["SET", `s:${token}`, u.uid, "EX", SESSION_TTL], ["SADD", `us:${u.uid}`, token]]);
  return { token, me: meView(u), friends: await friendsOf(u.uid), history: await historyOf(u.uid), archive: await archiveOf(u.uid), groups: await groupsOf(u.uid), ...(await notifsOf(u.uid)) };
}

const INVITE_TTL = 60 * 60 * 24 * 30;
async function notifsOf(uid) {
  const [rows, seen] = await kv([["LRANGE", `n:${uid}`, 0, 49], ["GET", `nseen:${uid}`]]);
  const list = (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  return { notifs: list, unread: list.filter(n => n.at > (Number(seen) || 0)).length };
}
async function dropNotif(uid, nid) {
  const { notifs } = await notifsOf(uid);
  const keep = notifs.filter(n => n.nid !== nid);
  const cmds = [["DEL", `n:${uid}`]];
  if (keep.length) cmds.push(["RPUSH", `n:${uid}`, ...keep.map(n => JSON.stringify(n))]);
  await kv(cmds);
  return { found: notifs.find(n => n.nid === nid) || null, notifs: keep };
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
  return { sub: String(t.sub), name: clean(t.given_name || t.name || "", 20), email: (t.email_verified === true || t.email_verified === "true") ? String(t.email || "") : "" };
}

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ clientId: CLIENT_ID || null, ready: !!(KV_URL && KV_TOKEN), contact: clean(process.env.CONTACT_EMAIL || "", 120) || null });
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "no_accounts" });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = body.action;

  try {
    /* ---- email + password accounts ---- */
    if (action === "register" || action === "loginPw") {
      const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
      const password = String(body.password || "");
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "email" });
      const emKey = "em:" + crypto.createHash("sha256").update(email).digest("hex");
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
      const rlKey = "rl:" + crypto.createHash("sha256").update(ip + "|" + email).digest("hex").slice(0, 32);
      const [tries] = await kv([["GET", rlKey]]);
      if (Number(tries) >= 10) return res.status(429).json({ error: "too_many" });

      if (action === "register") {
        const first = clean(body.first, 30), last = clean(body.last, 40);
        if (!first || !last) return res.status(400).json({ error: "missing" });
        if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "weak" });
        const [exists] = await kv([["GET", emKey]]);
        if (exists) return res.status(409).json({ error: "exists" });
        const uid = rid(12), code = rid(8), salt = crypto.randomBytes(16).toString("hex");
        const hash = (await scrypt(password, salt)).toString("hex");
        const u = { uid, code, sk: emKey, email, last, lang: LANG_OK.includes(body.lang) ? body.lang : "fr", pw: { salt, hash }, created: Date.now(), profile: cleanProfile({ nick: first.split(" ")[0] }, {}) };
        const [ok] = await kv([["SET", emKey, uid, "NX"]]);
        if (!ok) return res.status(409).json({ error: "exists" });
        await kv([["SET", `u:${uid}`, JSON.stringify(u)], ["SET", `fc:${code}`, uid]]);
        return res.status(200).json(await openSession(u));
      }

      const [uid] = await kv([["GET", emKey]]);
      const u = uid ? await getUser(uid) : null;
      let good = false;
      if (u && u.pw) {
        const h = await scrypt(password, u.pw.salt);
        const want = Buffer.from(u.pw.hash, "hex");
        good = h.length === want.length && crypto.timingSafeEqual(h, want);
      }
      if (!good) {
        await kv([["INCR", rlKey], ["EXPIRE", rlKey, 900]]);
        return res.status(401).json({ error: "creds" });
      }
      await kv([["DEL", rlKey]]);
      if (!!u.admin !== isAdminEmail(u.email)) { u.admin = isAdminEmail(u.email); await kv([["SET", `u:${u.uid}`, JSON.stringify(u)]]); }
      return res.status(200).json(await openSession(u));
    }

    /* ---- forgot password: email a one time link (30 min). The answer never says whether the email exists. ---- */
    if (action === "forgot") {
      const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "email" });
      const h = crypto.createHash("sha256").update(email).digest("hex");
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
      const rl = "rf:" + crypto.createHash("sha256").update(ip + "|" + email).digest("hex").slice(0, 32);
      const [n] = await kv([["INCR", rl], ["EXPIRE", rl, 900]]);
      if (n > 3) return res.status(200).json({ ok: true }); // quietly ignore spam
      const [pwUid, gUid] = await kv([["GET", "em:" + h], ["GET", "ge:" + h]]);
      const lg = LANG_OK.includes(body.lang) ? body.lang : "fr";
      if (pwUid) {
        const token = crypto.randomBytes(32).toString("hex");
        await kv([["SET", "pr:" + crypto.createHash("sha256").update(token).digest("hex"), pwUid, "EX", 1800]]);
        await sendResetMail({ to: email, lang: lg, token });
      } else if (gUid) {
        await sendResetMail({ to: email, lang: lg, google: true });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === "reset") {
      const token = String(body.token || "");
      const password = String(body.password || "");
      if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: "bad_link" });
      if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "weak" });
      const prKey = "pr:" + crypto.createHash("sha256").update(token).digest("hex");
      const [uid] = await kv([["GET", prKey], ["DEL", prKey]]); // one use only
      const u = uid ? await getUser(uid) : null;
      if (!u || !u.pw) return res.status(400).json({ error: "bad_link" });
      const salt = crypto.randomBytes(16).toString("hex");
      u.pw = { salt, hash: (await scrypt(password, salt)).toString("hex") };
      // sign out every device, then sign in here with the new password
      const [tokens] = await kv([["SMEMBERS", `us:${uid}`]]);
      await kv([["SET", `u:${uid}`, JSON.stringify(u)], ...(tokens || []).map(t => ["DEL", `s:${t}`]), ["DEL", `us:${uid}`]]);
      return res.status(200).json(await openSession(u));
    }

    if (action === "login") {
      if (!CLIENT_ID) return res.status(500).json({ error: "no_google" });
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
      const lg = LANG_OK.includes(body.lang) ? body.lang : u.lang;
      if (!!u.admin !== isAdminEmail(g.email) || (g.email && u.email !== g.email) || u.lang !== lg) {
        u.admin = isAdminEmail(g.email); if (g.email) u.email = g.email; u.lang = lg;
        const ge = g.email ? [["SET", "ge:" + crypto.createHash("sha256").update(g.email.trim().toLowerCase()).digest("hex"), uid]] : [];
        await kv([["SET", `u:${uid}`, JSON.stringify(u)], ...ge]);
      }
      const token = crypto.randomBytes(24).toString("hex");
      await kv([["SET", `s:${token}`, uid, "EX", SESSION_TTL], ["SADD", `us:${uid}`, token]]);
      return res.status(200).json({ token, me: meView(u), friends: await friendsOf(uid), history: await historyOf(uid), archive: await archiveOf(uid), groups: await groupsOf(uid), ...(await notifsOf(uid)) });
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
    // remember the site language so emails go out in it
    if (LANG_OK.includes(body.lang) && u.lang !== body.lang) { u.lang = body.lang; await kv([["SET", `u:${u.uid}`, JSON.stringify(u)]]); }

    if (action === "admin") {
      if (!u.admin) return res.status(403).json({ error: "forbidden" });
      const key = process.env.ADMIN_KEY || "";
      const [pending, cities, nr, nc, sr, sc] = await kv([["LLEN", "rv:pending"], ["ZCARD", "sg:count"], ["GET", "adm:newReview"], ["GET", "adm:newCity"], ["GET", "adm:seenReview"], ["GET", "adm:seenCity"]]);
      // "new" = something arrived since the owner last opened that page; the account page makes the button blink
      return res.status(200).json({ pending: pending || 0, cities: cities || 0, newReviews: Number(nr) > (Number(sr) || 0), newCities: Number(nc) > (Number(sc) || 0), reviewsUrl: key ? "/api/review?key=" + encodeURIComponent(key) : null, citiesUrl: key ? "/api/suggest?key=" + encodeURIComponent(key) : null });
    }

    if (action === "adminSeen") {
      if (!u.admin) return res.status(403).json({ error: "forbidden" });
      await kv([["SET", body.what === "cities" ? "adm:seenCity" : "adm:seenReview", Date.now()]]);
      return res.status(200).json({ ok: true });
    }

    // remove a group from my list only (the group itself stays for the others)
    if (action === "leaveGroup") {
      await kv([["SREM", `g:${u.uid}`, clean(body.id, 12)]]);
      return res.status(200).json({ groups: await groupsOf(u.uid) });
    }

    if (action === "me") return res.status(200).json({ me: meView(u), friends: await friendsOf(u.uid), history: await historyOf(u.uid), archive: await archiveOf(u.uid), groups: await groupsOf(u.uid), ...(await notifsOf(u.uid)) });

    if (action === "saveOuting") {
      const e = cleanEntry(body);
      if (!e) return res.status(400).json({ error: "bad_plan" });
      // the plan also lands in the history of friends who were part of the group
      const [mine] = await kv([["SMEMBERS", `fr:${u.uid}`]]);
      const owners = new Set([u.uid, ...e.people.map(p => p.uid).filter(id => id && (mine || []).includes(id))]);
      const cmds = [];
      owners.forEach(id => { cmds.push(["LPUSH", `h:${id}`, JSON.stringify(e)], ["LTRIM", `h:${id}`, 0, 49]); });
      await kv(cmds);
      return res.status(200).json({ entry: e });
    }

    if (action === "notifs") return res.status(200).json(await notifsOf(u.uid));

    if (action === "seenNotifs") {
      await kv([["SET", `nseen:${u.uid}`, String(Date.now())]]);
      return res.status(200).json({ ok: true });
    }

    // host invites friends to a group: each friend gets a notification
    if (action === "invite") {
      const oid = clean(body.outing, 12);
      const [metaRaw] = await kv([["GET", `o:${oid}`]]);
      if (!metaRaw) return res.status(404).json({ error: "not_found" });
      const meta = JSON.parse(metaRaw);
      const tok = String(body.adminToken || "");
      if (!meta.admin || tok.length !== meta.admin.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(meta.admin))) return res.status(403).json({ error: "forbidden" });
      const wanted = (Array.isArray(body.uids) ? body.uids : []).slice(0, 8).map(x => clean(x, 20));
      const flags = wanted.length ? await kv(wanted.map(id => ["SISMEMBER", `fr:${u.uid}`, id])) : [];
      const cmds = []; let sent = 0;
      const mailTo = [];
      wanted.forEach((fid, i) => {
        if (!flags[i]) return;
        const n = { nid: rid(10), type: "invite", from: u.profile.nick, outing: oid, city: meta.city, mode: meta.mode, at: Date.now() };
        cmds.push(["LPUSH", `n:${fid}`, JSON.stringify(n)], ["LTRIM", `n:${fid}`, 0, 49], ["SET", `inv:${oid}:${fid}`, "1", "EX", INVITE_TTL]);
        mailTo.push(fid); sent++;
      });
      if (cmds.length) await kv(cmds);
      // email each invited friend who has an email and didn't turn invite emails off
      if (mailTo.length) {
        const raws = await kv(mailTo.map(fid => ["GET", `u:${fid}`]));
        await Promise.allSettled(raws.map(raw => {
          const f = raw ? JSON.parse(raw) : null;
          if (!f || !f.email || f.profile?.mail === false) return null;
          return sendPartyMail({ to: f.email, lang: f.lang, kind: "invite", from: u.profile.nick, city: meta.city, mode: meta.mode, outing: oid });
        }));
      }
      return res.status(200).json({ sent });
    }

    if (action === "declineInvite") {
      const { found, notifs } = await dropNotif(u.uid, clean(body.nid, 12));
      if (found && found.outing) await kv([["DEL", `inv:${found.outing}:${u.uid}`]]);
      return res.status(200).json({ notifs });
    }

    // joining from an invite: the person is added to the group with their own profile
    if (action === "acceptInvite") {
      const { found, notifs } = await dropNotif(u.uid, clean(body.nid, 12));
      if (!found || !found.outing) return res.status(404).json({ error: "gone", notifs });
      const oid = found.outing;
      const [ok, metaRaw, members] = await kv([["GET", `inv:${oid}:${u.uid}`], ["GET", `o:${oid}`], ["HVALS", `o:${oid}:m`]]);
      if (!ok || !metaRaw) return res.status(410).json({ error: "gone", notifs });
      const meta = JSON.parse(metaRaw);
      const list = (members || []).map(x => { try { return JSON.parse(x); } catch { return {}; } });
      if (!list.some(m => m.uid === u.uid)) {
        if (list.length >= 8) return res.status(409).json({ error: "full", notifs });
        const p = u.profile;
        const m = { nick: p.nick, level: p.level ?? null, vibe: (meta.mode === "day" ? p.vibeDay : p.vibeNight) || "", flag: !!(meta.mode === "day" ? p.student : p.sober), minor: !!p.minor, budget: null, uid: u.uid, token: crypto.randomBytes(24).toString("hex"), t: Date.now(), host: false };
        await kv([["HSET", `o:${oid}:m`, rid(8), JSON.stringify(m)], ["SADD", `g:${u.uid}`, oid], ["EXPIRE", `g:${u.uid}`, INVITE_TTL]]);
      }
      await kv([["DEL", `inv:${oid}:${u.uid}`]]);
      return res.status(200).json({ outing: oid, notifs, groups: await groupsOf(u.uid) });
    }

    // delete one outing, or all of them: they move to the archive (3 days to restore)
    if (action === "deleteOuting" || action === "clearHistory") {
      const id = clean(body.id, 12);
      const list = await historyOf(u.uid);
      const gone = action === "clearHistory" ? list : list.filter(x => x.id === id);
      const keep = list.filter(x => !gone.includes(x));
      const now = Date.now();
      const archive = [...gone.map(x => ({ ...x, deletedAt: now })), ...(await archiveOf(u.uid))].slice(0, 200);
      await kv([...listCmds(`h:${u.uid}`, keep), ...listCmds(`ha:${u.uid}`, archive, ARCHIVE_MS / 1000)]);
      return res.status(200).json({ history: keep, archive });
    }

    if (action === "restoreOuting") {
      const id = clean(body.id, 12);
      const archive = await archiveOf(u.uid);
      const back = archive.find(x => x.id === id);
      if (!back) return res.status(404).json({ error: "not_found" });
      const rest = archive.filter(x => x !== back);
      const { deletedAt, ...entry } = back;
      const history = [entry, ...(await historyOf(u.uid)).filter(x => x.id !== id)].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 50);
      await kv([...listCmds(`h:${u.uid}`, history), ...listCmds(`ha:${u.uid}`, rest, ARCHIVE_MS / 1000)]);
      return res.status(200).json({ history, archive: rest });
    }

    if (action === "profile") {
      u.profile = cleanProfile(body.profile || {}, u.profile);
      await kv([["SET", `u:${u.uid}`, JSON.stringify(u)]]);
      return res.status(200).json({ me: meView(u) });
    }

    if (action === "addFriend") {
      const code = clean(body.code, 12);
      const [fid] = await kv([["GET", `fc:${code}`]]);
      if (!fid) return res.status(404).json({ error: "not_found" });
      if (fid === u.uid) return res.status(400).json({ error: "self" });
      const [count] = await kv([["SCARD", `fr:${u.uid}`]]);
      if (count >= 200) return res.status(409).json({ error: "full" });
      const [isNew] = await kv([["SADD", `fr:${u.uid}`, fid], ["SADD", `fr:${fid}`, u.uid]]);
      const f = await getUser(fid);
      // tell the link's owner by email that someone added them (only for a new friendship)
      if (isNew && f && f.email && f.profile?.mail !== false) await sendPartyMail({ to: f.email, lang: f.lang, kind: "friend", from: u.profile.nick });
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
      if (u.email && !u.pw) cmds.push(["DEL", "ge:" + crypto.createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex")]);
      cmds.push(["DEL", `u:${u.uid}`, `fr:${u.uid}`, `us:${u.uid}`, `fc:${u.code}`, `h:${u.uid}`, `ha:${u.uid}`, `g:${u.uid}`, `n:${u.uid}`, `nseen:${u.uid}`]);
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
