// Stories: one photo a day from an outing, with a caption and #hashtags. Gone after 24 hours.
// Friends always see it; with "Public" on, it also shows in search and in the daily best (most liked).
// Photos are shrunk in the browser (about 100 to 300 KB) and kept in the database with a 24 h expiry.
// Ads (managed from the admin page, /api/business?view=ads) show between stories, never for Tournée+.
//
// POST /api/story {action:"post", image, caption, pub, outing, mission}  (signed in, 1 a day)
// POST /api/story {action:"feed"}                    -> friends' stories (and mine) + ads
// POST /api/story {action:"best"}                    -> today's most liked public stories
// POST /api/story {action:"search", q:"#tag"|"@name"} -> public stories with that tag, or that person's stories
// POST /api/story {action:"like", id, owner, on}     -> heart on or off
// POST /api/story {action:"seen", ids, ads}          -> stories seen, ads shown
// POST /api/story {action:"delete", id}              -> delete my story (the admin can delete any)
// GET  /api/story?img=ID&e=EXPIRY&s=SIG              -> the photo (signed link)
// GET  /api/story?adimg=ID                           -> an ad's picture
// GET  /api/story?ad=ID&go=1                         -> counts the click and opens the ad's link

const crypto = require("crypto");
const quota = require("./_quota");
const { kv } = quota;

const DAY = 24 * 60 * 60;
const MAX_BYTES = 600 * 1024;
const clean = (s, n) => String(s ?? "").replace(/[\r\n<>"`]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const rid = () => crypto.randomBytes(9).toString("base64url");
const SECRET = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "tournee";
const sign = (id, e) => crypto.createHmac("sha256", SECRET()).update(`story|${id}|${e}`).digest("base64url").slice(0, 32);
const urlFor = (id, at) => { const e = Math.floor(at / 1000) + DAY; return `/api/story?img=${id}&e=${e}&s=${sign(id, e)}`; };
const parse = rows => (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
const fresh = s => Date.now() - s.at < DAY * 1000;
const banned = u => !!(u && u.banned && (!u.banned.until || u.banned.until > Date.now()));
const parisDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const normTag = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]/g, "").slice(0, 30);
const tagsOf = caption => [...new Set((String(caption).match(/#[\p{L}\p{N}_]{2,30}/gu) || []).map(normTag).filter(t => t.length >= 2))].slice(0, 10);
const isPro = u => !!(u && u.pro && Number(u.pro.until) > Date.now());

// likes count and "liked by me" for a list of stories, in one round trip
async function withLikes(list, uid) {
  if (!list.length) return list;
  const res = await kv(list.flatMap(s => [["SCARD", `stl:${s.id}`], ["SISMEMBER", `stl:${s.id}`, uid]]));
  return list.map((s, i) => ({ ...s, likes: Number(res[i * 2]) || 0, liked: !!res[i * 2 + 1] }));
}
// public index entries -> viewer groups (one story per group, newest first unless sorted otherwise)
const asGroups = (entries, uid, seen) => entries.map(e => ({
  uid: e.uid, me: e.uid === uid, nick: e.nick || "?", handle: e.handle || "", av: e.av || null, pub: true,
  stories: [{ ...e.s, url: urlFor(e.s.id, e.s.at), seen: e.uid === uid || seen.has(e.s.id), likes: e.s.likes, liked: e.s.liked }],
  unseen: e.uid !== uid && !seen.has(e.s.id), last: e.s.at,
}));

async function publicEntries(key, limit) {
  const [rows] = await kv([["LRANGE", key, 0, limit - 1]]);
  const list = parse(rows).filter(e => e.s && fresh(e.s));
  if (!list.length) return [];
  const alive = await kv(list.map(e => ["EXISTS", `st:img:${e.s.id}`]));
  return list.filter((_, i) => alive[i]);
}

module.exports = async (req, res) => {
  if (!quota.ready()) return res.status(500).json({ error: "no_store" });
  try {
    if (req.method === "GET") {
      const q = req.query || {};
      // an ad's click: count it, then go to the business's page
      if (q.ad && q.go) {
        const id = clean(q.ad, 20);
        const [rows] = await kv([["GET", "ads:list"]]);
        let ads = []; try { ads = JSON.parse(rows) || []; } catch {}
        const ad = ads.find(a => a.id === id);
        if (!ad || !/^https:\/\//.test(ad.link || "")) return res.status(404).send("Not found");
        await kv([["INCR", `ad:c:${id}`]]);
        res.setHeader("Location", ad.link); return res.status(302).send("");
      }
      const key = q.adimg ? `ad:img:${clean(q.adimg, 20)}` : q.av ? `av:${clean(q.av, 20)}` : null;
      if (!key) {
        const id = String(q.img || ""), e = Number(q.e), s = String(q.s || "");
        const want = sign(id, e);
        if (!/^[A-Za-z0-9_-]{8,20}$/.test(id) || !e || e * 1000 < Date.now() || s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return res.status(404).send("Not found");
      }
      const [raw] = await kv([["GET", key || `st:img:${String(q.img)}`]]);
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(raw || "");
      if (!m) return res.status(404).send("Not found");
      res.setHeader("Content-Type", m[1]);
      res.setHeader("Cache-Control", key ? "public, max-age=3600" : "private, max-age=3600");
      return res.status(200).send(Buffer.from(m[2], "base64"));
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const who = await quota.account(req);
    if (!who) return res.status(401).json({ error: "signed_out" });
    const { uid, u } = who;
    if (banned(u)) return res.status(403).json({ error: "banned" });
    const nick = u.profile?.nick || "?", handle = u.handle || "";

    if (body.action === "post") {
      const img = String(body.image || "");
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(img);
      if (!m) return res.status(400).json({ error: "image" });
      if (Buffer.byteLength(m[2], "base64") > MAX_BYTES) return res.status(413).json({ error: "too_big" });
      // one story a day (Paris time); the admin is not limited
      const dk = `st:n:${uid}:${parisDay()}`;
      const [n] = await kv([["INCR", dk], ["EXPIRE", dk, DAY * 2]]);
      if (n > 1 && !u.admin) { await kv([["DECR", dk]]); return res.status(429).json({ error: "too_many" }); }
      let link = {};
      const oid = clean(body.outing, 12);
      if (oid) {
        const [rows] = await kv([["LRANGE", `h:${uid}`, 0, 49]]);
        const e = parse(rows).find(x => x.id === oid);
        if (e) link = { oid, title: clean(e.title, 80), city: e.city, mode: e.mode, ...(body.mission ? { mission: clean(body.mission, 80) } : {}) };
      }
      const caption = clean(body.caption, 200);
      const s = { id: rid(), at: Date.now(), caption, tags: tagsOf(caption), pub: body.pub === true, ...link };
      const cmds = [["SET", `st:img:${s.id}`, img, "EX", DAY], ["LPUSH", `st:${uid}`, JSON.stringify(s)], ["LTRIM", `st:${uid}`, 0, 19], ["EXPIRE", `st:${uid}`, DAY]];
      if (s.pub) {
        const entry = JSON.stringify({ uid, nick, handle, av: u.av || null, s });
        cmds.push(["LPUSH", "stpub", entry], ["LTRIM", "stpub", 0, 999], ["EXPIRE", "stpub", DAY]);
        s.tags.forEach(t => cmds.push(["LPUSH", `sth:${t}`, entry], ["LTRIM", `sth:${t}`, 0, 199], ["EXPIRE", `sth:${t}`, DAY]));
      }
      await kv(cmds);
      return res.status(200).json({ ok: true, story: { ...s, url: urlFor(s.id, s.at), likes: 0, liked: false } });
    }

    if (body.action === "feed") {
      const [friendIds, seenIds] = await kv([["SMEMBERS", `fr:${uid}`], ["SMEMBERS", `sts:${uid}`]]);
      const ids = [uid, ...(friendIds || [])].slice(0, 200);
      const lists = await kv(ids.map(id => ["LRANGE", `st:${id}`, 0, 19]));
      const seen = new Set(seenIds || []);
      const withStories = ids.map((id, i) => [id, parse(lists[i]).filter(fresh)]).filter(([, l]) => l.length);
      const users = withStories.length ? await kv(withStories.map(([id]) => ["GET", `u:${id}`])) : [];
      let groups = withStories.map(([id, l], i) => {
        let f = null; try { f = JSON.parse(users[i]); } catch {}
        if (!f || (id !== uid && banned(f))) return null;
        const stories = l.sort((a, b) => a.at - b.at).map(s => ({ ...s, url: urlFor(s.id, s.at), seen: id === uid || seen.has(s.id) }));
        return { uid: id, me: id === uid, nick: f.profile?.nick || "?", handle: f.handle || "", av: f.av || null, stories, unseen: stories.some(s => !s.seen), last: stories[stories.length - 1].at };
      }).filter(Boolean).sort((a, b) => (b.me - a.me) || (b.unseen - a.unseen) || (b.last - a.last));
      const flat = await withLikes(groups.flatMap(g => g.stories), uid);
      let k = 0; groups = groups.map(g => ({ ...g, stories: g.stories.map(() => flat[k++]) }));
      // ads between stories, except for Tournée+ and the admin
      let ads = [];
      const noAds = isPro(u) || !!u.admin;
      if (!noAds) {
        const [raw] = await kv([["GET", "ads:list"]]);
        try { ads = (JSON.parse(raw) || []).filter(a => a.on).map(a => ({ id: a.id, title: a.title, text: a.text, cta: a.cta || "", url: `/api/story?adimg=${a.id}`, link: `/api/story?ad=${a.id}&go=1` })); } catch {}
      }
      return res.status(200).json({ groups, ads, noAds, posted: !!(await kv([["EXISTS", `st:n:${uid}:${parisDay()}`]]))[0] });
    }

    // the daily best: today's public stories with the most likes
    if (body.action === "best") {
      const [seenIds] = await kv([["SMEMBERS", `sts:${uid}`]]);
      const list = await publicEntries("stpub", 300);
      const liked = await withLikes(list.map(e => e.s), uid);
      const top = list.map((e, i) => ({ ...e, s: liked[i] })).filter(e => e.s.likes > 0 || list.length <= 12)
        .sort((a, b) => b.s.likes - a.s.likes || b.s.at - a.s.at).slice(0, 12);
      return res.status(200).json({ groups: asGroups(top, uid, new Set(seenIds || [])) });
    }

    // search: #tag -> public stories with it; @name or name -> that person's public stories (all of them if it's a friend)
    if (body.action === "search") {
      const q = String(body.q || "").trim();
      const [seenIds] = await kv([["SMEMBERS", `sts:${uid}`]]);
      const seen = new Set(seenIds || []);
      if (q.startsWith("#")) {
        const tag = normTag(q); if (tag.length < 2) return res.status(200).json({ groups: [] });
        const list = await publicEntries(`sth:${tag}`, 100);
        const liked = await withLikes(list.map(e => e.s), uid);
        return res.status(200).json({ groups: asGroups(list.map((e, i) => ({ ...e, s: liked[i] })), uid, seen) });
      }
      const h = q.replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_.]/g, "");
      if (h.length < 2) return res.status(200).json({ groups: [] });
      const [handles] = await kv([["ZRANGEBYLEX", "handles", `[${h}`, `[${h}\xff`, "LIMIT", 0, 10]]);
      if (!handles || !handles.length) return res.status(200).json({ groups: [] });
      const uids = await kv(handles.map(x => ["GET", `un:${x}`]));
      const ok = handles.map((x, i) => [x, uids[i]]).filter(([, id]) => id);
      const rows = await kv(ok.flatMap(([, id]) => [["GET", `u:${id}`], ["LRANGE", `st:${id}`, 0, 19], ["SISMEMBER", `fr:${uid}`, id]]));
      let groups = ok.map(([hd, id], i) => {
        let f = null; try { f = JSON.parse(rows[i * 3]); } catch {}
        if (!f || banned(f)) return null;
        const friend = !!rows[i * 3 + 2] || id === uid;
        const stories = parse(rows[i * 3 + 1]).filter(s => fresh(s) && (friend || s.pub)).sort((a, b) => a.at - b.at)
          .map(s => ({ ...s, url: urlFor(s.id, s.at), seen: id === uid || seen.has(s.id) }));
        return stories.length ? { uid: id, me: id === uid, nick: f.profile?.nick || "?", handle: hd, av: f.av || null, stories, unseen: stories.some(s => !s.seen), last: stories[stories.length - 1].at } : null;
      }).filter(Boolean);
      const flat = await withLikes(groups.flatMap(g => g.stories), uid);
      let k = 0; groups = groups.map(g => ({ ...g, stories: g.stories.map(() => flat[k++]) }));
      return res.status(200).json({ groups });
    }

    if (body.action === "like") {
      const id = clean(body.id, 20);
      const [alive] = await kv([["EXISTS", `st:img:${id}`]]);
      if (!alive) return res.status(404).json({ error: "gone" });
      const [, n] = await kv([[body.on === false ? "SREM" : "SADD", `stl:${id}`, uid], ["SCARD", `stl:${id}`], ["EXPIRE", `stl:${id}`, DAY]]);
      return res.status(200).json({ likes: Number(n) || 0, liked: body.on !== false });
    }

    if (body.action === "seen") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 50).map(x => clean(x, 20)).filter(Boolean);
      const ads = (Array.isArray(body.ads) ? body.ads : []).slice(0, 20).map(x => clean(x, 20)).filter(Boolean);
      const cmds = [];
      if (ids.length) cmds.push(["SADD", `sts:${uid}`, ...ids], ["EXPIRE", `sts:${uid}`, DAY * 2]);
      ads.forEach(a => cmds.push(["INCR", `ad:v:${a}`]));
      if (cmds.length) await kv(cmds);
      return res.status(200).json({ ok: true });
    }

    if (body.action === "delete") {
      const id = clean(body.id, 20);
      const owner = u.admin && body.owner ? clean(body.owner, 20) : uid;
      const [rows, pub] = await kv([["LRANGE", `st:${owner}`, 0, 19], ["LRANGE", "stpub", 0, 999]]);
      const mine = parse(rows), gone = mine.find(s => s.id === id), keep = mine.filter(s => s.id !== id);
      const cmds = [["DEL", `st:${owner}`, `st:img:${id}`, `stl:${id}`]];
      if (keep.length) cmds.push(["RPUSH", `st:${owner}`, ...keep.map(s => JSON.stringify(s))], ["EXPIRE", `st:${owner}`, DAY]);
      if (gone && gone.pub) {
        const rest = parse(pub).filter(e => e.s?.id !== id);
        cmds.push(["DEL", "stpub"], ...(rest.length ? [["RPUSH", "stpub", ...rest.map(e => JSON.stringify(e))], ["EXPIRE", "stpub", DAY]] : []));
        const tagRows = gone.tags?.length ? await kv(gone.tags.map(t => ["LRANGE", `sth:${t}`, 0, 199])) : [];
        (gone.tags || []).forEach((t, i) => { const r = parse(tagRows[i]).filter(e => e.s?.id !== id); cmds.push(["DEL", `sth:${t}`], ...(r.length ? [["RPUSH", `sth:${t}`, ...r.map(e => JSON.stringify(e))], ["EXPIRE", `sth:${t}`, DAY]] : [])); });
      }
      await kv(cmds);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
