// Reviews: visitors leave a rating and a short comment; nothing is public until the owner approves it.
// POST /api/review {stars,text,name,city,lang}           -> stored as pending
// GET  /api/review                                        -> approved reviews with 4 or 5 stars (homepage)
// GET  /api/review?key=ADMIN_KEY                          -> owner page to approve, reject or remove
// POST /api/review {action:"approve"|"reject"|"remove", key, rid}

const crypto = require("crypto");
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function kv(cmds) {
  const r = await fetch(KV_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("kv " + r.status);
  return (await r.json()).map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const clean = (s, n) => String(s ?? "").replace(/[\r\n\t<>`]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const parse = rows => (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);

async function rewrite(key, list) {
  const cmds = [["DEL", key]];
  if (list.length) cmds.push(["RPUSH", key, ...list.map(x => JSON.stringify(x))]);
  await kv(cmds);
}

function page(pending, approved, key) {
  const row = (r, actions) => `<li><div class="st">${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)}</div>
    <p class="tx">${esc(r.text) || "<em>(no comment)</em>"}</p>
    <p class="who">${esc(r.name || "?")}${r.city ? " · " + esc(r.city) : ""} · ${esc(new Date(r.at).toISOString().slice(0, 10))}</p>
    <div class="act">${actions.map(([a, label]) => `<button data-a="${a}" data-id="${esc(r.rid)}">${label}</button>`).join("")}</div></li>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tournée, reviews</title>
<style>
body{font:15px/1.5 Inter,system-ui,sans-serif;background:#271A47;color:#DBC9FF;margin:0;padding:32px 20px;max-width:620px}
h1{font-family:"Cormorant Garamond",Georgia,serif;font-weight:400;font-size:40px;margin:0 0 8px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.111em;color:#BC994E;margin:32px 0 8px}
ul{list-style:none;margin:0;padding:0}li{padding:16px 0;border-top:1px solid #43346C}
.st{color:#BC994E;letter-spacing:2px}.tx{margin:6px 0}.who{margin:0;font-size:12px;color:#B7A6DE}
.act{display:flex;gap:10px;margin-top:10px}
button{background:none;border:1px solid #DBC9FF;border-radius:30px;color:#DBC9FF;padding:6px 14px;font:inherit;font-size:12px;cursor:pointer}
button[data-a=approve]{background:#DBC9FF;color:#271A47}
.empty{color:#B7A6DE}
</style>
<h1>Reviews</h1>
<h2>Waiting for approval (${pending.length})</h2>
<ul>${pending.map(r => row(r, [["approve", "Approve"], ["reject", "Delete"]])).join("") || '<li class="empty">Nothing to review.</li>'}</ul>
<h2>Published (${approved.length})</h2>
<ul>${approved.map(r => row(r, [["remove", "Remove"]])).join("") || '<li class="empty">Nothing published yet.</li>'}</ul>
<p class="empty" style="margin-top:24px;font-size:12px">Only approved reviews with 4 or 5 stars appear on the homepage.</p>
<script>
const key=${JSON.stringify(key)};
document.addEventListener("click",async e=>{ const b=e.target.closest("button[data-a]"); if(!b) return;
  if(b.dataset.a!=="approve" && !confirm("Delete this review?")) return;
  b.disabled=true;
  await fetch("/api/review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:b.dataset.a,key,rid:b.dataset.id})});
  location.reload(); });
</script>`;
}

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "no_store" });
  const admin = process.env.ADMIN_KEY;
  try {
    if (req.method === "GET") {
      const key = String(req.query?.key || "");
      if (key) {
        if (!admin || !same(key, admin)) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); return res.status(403).send("Forbidden"); }
        const [p, a] = await kv([["LRANGE", "rv:pending", 0, 199], ["LRANGE", "rv:approved", 0, 199]]);
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(page(parse(p), parse(a), key));
      }
      const [a] = await kv([["LRANGE", "rv:approved", 0, 99]]);
      const list = parse(a).filter(r => r.stars >= 4).slice(0, 30).map(({ rid, stars, text, name, city }) => ({ rid, stars, text, name, city }));
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.status(200).json({ reviews: list });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

    if (body.action) {
      if (!admin || !same(String(body.key || ""), admin)) return res.status(403).json({ error: "forbidden" });
      const rid = clean(body.rid, 20);
      const [p, a] = await kv([["LRANGE", "rv:pending", 0, 199], ["LRANGE", "rv:approved", 0, 199]]);
      const pending = parse(p), approved = parse(a);
      if (body.action === "approve") {
        const r = pending.find(x => x.rid === rid);
        if (r) { await rewrite("rv:pending", pending.filter(x => x.rid !== rid)); await kv([["LPUSH", "rv:approved", JSON.stringify({ ...r, ok: Date.now() })]]); }
      } else if (body.action === "reject") {
        await rewrite("rv:pending", pending.filter(x => x.rid !== rid));
      } else if (body.action === "remove") {
        await rewrite("rv:approved", approved.filter(x => x.rid !== rid));
      }
      return res.status(200).json({ ok: true });
    }

    const stars = parseInt(body.stars, 10);
    if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: "stars" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    const voter = crypto.createHash("sha256").update("rv|" + ip).digest("hex").slice(0, 24);
    const [fresh] = await kv([["SET", `rv:v:${voter}`, "1", "NX", "EX", 86400]]);
    if (fresh) {
      const r = { rid: crypto.randomBytes(6).toString("hex"), stars, text: clean(body.text, 280), name: clean(body.name, 20), city: clean(body.city, 30), lang: clean(body.lang, 5), at: Date.now() };
      await kv([["LPUSH", "rv:pending", JSON.stringify(r)], ["LTRIM", "rv:pending", 0, 199]]);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
