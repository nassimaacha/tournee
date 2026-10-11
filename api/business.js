// Businesses that want to be featured on Tournée: a short contact form on /business.
// POST /api/business {name, city, email, msg, lang}     -> stored, owner gets an email (Resend) and a blinking admin button
// GET  /api/business?key=ADMIN_KEY                      -> owner page with the requests
// POST /api/business {action:"delete", key, id}         -> owner removes a request
// Limit: 3 requests per connection per day.

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
const clean = (s, n) => String(s ?? "").replace(/[\r\t<>`]/g, " ").replace(/[  ]+/g, " ").trim().slice(0, n);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const parse = rows => (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);

// a copy to the owner's inbox; a failed email never blocks the request
async function notify(r) {
  const key = process.env.RESEND_API_KEY; if (!key) return;
  const to = process.env.CONTACT_EMAIL || "tournee.help@gmail.com";
  const html = `<div style="font:15px/1.5 Arial,sans-serif;color:#271A47">
    <p style="font-size:20px;margin:0 0 12px"><b>${esc(r.name)}</b> · ${esc(r.city)}</p>
    <p style="margin:0 0 12px"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></p>
    <p style="margin:0;white-space:pre-wrap">${esc(r.msg) || "<em>(no message)</em>"}</p></div>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM || "Tournée <invitations@tournee.site>", to: [to], reply_to: r.email, subject: `Tournée pro : ${r.name} (${r.city})`, html }),
  }).catch(e => console.error("business mail", e));
}

function page(list, key) {
  const row = r => `<li><p class="nm">${esc(r.name)} <span>· ${esc(r.city)}</span></p>
    <p class="who"><a href="mailto:${esc(r.email)}">${esc(r.email)}</a> · ${esc(new Date(r.at).toISOString().slice(0, 10))} · ${esc(r.lang || "")}</p>
    ${r.msg ? `<p class="tx">${esc(r.msg)}</p>` : ""}
    <div class="act"><button data-id="${esc(r.id)}">Delete</button></div></li>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tournée, business requests</title>
<style>
body{font:15px/1.5 Inter,system-ui,sans-serif;background:#271A47;color:#DBC9FF;margin:0;padding:32px 20px;max-width:620px}
h1{font-family:"Cormorant Garamond",Georgia,serif;font-weight:400;font-size:40px;margin:0 0 8px}
ul{list-style:none;margin:0;padding:0}li{padding:16px 0;border-top:1px solid #43346C}
.nm{margin:0;font-size:18px;font-weight:600}.nm span{font-weight:400;color:#B7A6DE}.tx{margin:8px 0;white-space:pre-wrap}.who{margin:4px 0 0;font-size:12px;color:#B7A6DE}.who a{color:#BC994E}
.act{margin-top:10px}button{background:none;border:1px solid #DBC9FF;border-radius:30px;color:#DBC9FF;padding:6px 14px;font:inherit;font-size:12px;cursor:pointer}
.empty{color:#B7A6DE}
</style>
<h1>Business requests</h1>
<ul>${list.map(row).join("") || '<li class="empty">No requests yet.</li>'}</ul>
<script>
const key=${JSON.stringify(key)};
document.addEventListener("click",async e=>{ const b=e.target.closest("button[data-id]"); if(!b||!confirm("Delete this request?")) return; b.disabled=true;
  await fetch("/api/business",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"delete",key,id:b.dataset.id})});
  location.reload(); });
</script>`;
}

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "no_store" });
  const admin = process.env.ADMIN_KEY;
  try {
    if (req.method === "GET") {
      const key = String(req.query?.key || "");
      if (!admin || !same(key, admin)) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); return res.status(403).send("Forbidden"); }
      const [rows] = await kv([["LRANGE", "biz:list", 0, 199]]);
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(page(parse(rows), key));
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    let body = req.body || {};
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

    if (body.action === "delete") {
      if (!admin || !same(String(body.key || ""), admin)) return res.status(403).json({ error: "forbidden" });
      const [rows] = await kv([["LRANGE", "biz:list", 0, 199]]);
      const keep = parse(rows).filter(r => r.id !== String(body.id || ""));
      await kv([["DEL", "biz:list"], ...(keep.length ? [["RPUSH", "biz:list", ...keep.map(r => JSON.stringify(r))]] : [])]);
      return res.status(200).json({ ok: true });
    }

    const r = { id: crypto.randomBytes(6).toString("hex"), name: clean(body.name, 80), city: clean(body.city, 60), email: clean(body.email, 120).toLowerCase(), msg: clean(body.msg, 1000), lang: clean(body.lang, 5), at: Date.now() };
    if (!r.name || !r.city || !r.email) return res.status(400).json({ error: "missing" });
    if (!EMAIL_RE.test(r.email)) return res.status(400).json({ error: "email" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    const lk = "biz:rl:" + crypto.createHash("sha256").update("biz|" + ip).digest("hex").slice(0, 24);
    const [n] = await kv([["INCR", lk], ["EXPIRE", lk, 86400]]);
    if (n > 3) return res.status(429).json({ error: "too_many" });
    await kv([["LPUSH", "biz:list", JSON.stringify(r)], ["LTRIM", "biz:list", 0, 199], ["SET", "adm:newBiz", Date.now()]]);
    await notify(r);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
