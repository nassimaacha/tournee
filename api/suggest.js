// "My city isn't here": visitors suggest a city, the owner sees the top 5.
// POST /api/suggest {city}                        -> records a suggestion
// POST /api/suggest {action:"delete", key, ids}   -> owner deletes cities (key = ADMIN_KEY)
// GET  /api/suggest?key=XXXX                      -> owner view, top 5 with checkboxes
//
// Spelling: each entry is turned into its official city name (via Claude, which knows that
// "pariss", "Parí" and "Paris" are the same city). If that call fails, a typo tolerant match
// against cities already stored is used instead.

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
const clean = (s, n) => String(s ?? "").replace(/[\r\n<>"`{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

async function canonical(raw) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 80,
        messages: [{ role: "user", content: `A visitor typed a city name, possibly misspelled, abbreviated or written in another language: [${raw}]. Identify the city they most likely mean. Reply ONLY with JSON, no other text: {"city":"official English name","country":"country in English"}, or {"city":null} if it is not a real city.` }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const txt = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    if (!j.city) return { invalid: true };
    return { city: clean(j.city, 60), country: clean(j.country, 60) };
  } catch { return null; }
}

function page(rows, key) {
  const list = rows.map(r => `<label class="row"><input type="checkbox" value="${esc(r.id)}"><span class="name">${esc(r.label)}</span><span class="n">${esc(r.n)}</span></label>`).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tournée, top cities</title>
<style>
body{font:15px/1.5 Inter,system-ui,sans-serif;background:#271A47;color:#DBC9FF;margin:0;padding:32px 20px;max-width:520px}
h1{font-family:"Cormorant Garamond",Georgia,serif;font-weight:400;font-size:40px;margin:0 0 24px}
.row{display:flex;align-items:center;gap:14px;padding:12px 0;cursor:pointer}
.row input{width:18px;height:18px;accent-color:#DBC9FF}
.name{flex:1;font-family:"Cormorant Garamond",Georgia,serif;font-size:26px}
.n{font-size:13px;font-weight:600;letter-spacing:.111em;color:#BC994E}
button{margin-top:20px;background:none;border:1px solid #DBC9FF;border-radius:30px;color:#DBC9FF;padding:10px 20px;font:inherit;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.111em;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
.empty{color:#B7A6DE}
</style>
<h1>Top cities</h1>
${list || '<p class="empty">No requests yet.</p>'}
${list ? '<button id="del" disabled>Delete selected</button>' : ""}
<script>
const key=${JSON.stringify(key)}, del=document.getElementById("del");
document.addEventListener("change",()=>{ if(del) del.disabled=!document.querySelector(".row input:checked"); });
if(del) del.onclick=async()=>{
  const ids=[...document.querySelectorAll(".row input:checked")].map(i=>i.value);
  if(!ids.length||!confirm("Delete "+ids.length+" city?")) return;
  del.disabled=true;
  await fetch("/api/suggest",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"delete",key,ids})});
  location.reload();
};
</script>`;
}

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "no_store" });
  const admin = process.env.ADMIN_KEY;
  try {
    if (req.method === "POST") {
      let body = req.body || {};
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

      if (body.action === "delete") {
        if (!admin || !same(String(body.key || ""), admin)) return res.status(403).json({ error: "forbidden" });
        const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 50).map(x => String(x).slice(0, 140));
        if (ids.length) {
          // also clear today's "already voted" locks for these cities, so anyone can add them again right away
          const voters = await kv(ids.map(id => ["SMEMBERS", `sg:vs:${id}`]));
          const locks = voters.flat().filter(Boolean).map(v => `sg:v:${v}`);
          await kv([["ZREM", "sg:count", ...ids], ["HDEL", "sg:label", ...ids], ["DEL", ...ids.map(id => `sg:vs:${id}`), ...locks]]);
        }
        return res.status(200).json({ ok: true });
      }

      const raw = clean(body.city, 60);
      if (norm(raw).length < 2) return res.status(400).json({ error: "city" });

      let id, label;
      const c = await canonical(raw);
      if (c && c.invalid) return res.status(200).json({ ok: true }); // not a real city: quietly ignored
      if (c) {
        id = norm(c.city) + "|" + norm(c.country);
        label = c.country ? `${c.city}, ${c.country}` : c.city;
      } else {
        // fallback: typo tolerant match against cities already stored
        const [labels] = await kv([["HGETALL", "sg:label"]]);
        const r = norm(raw);
        let best = null, bestD = Infinity;
        for (let i = 0; i < (labels || []).length; i += 2) {
          const k = labels[i], cityPart = k.split("|")[0], dist = lev(r, cityPart);
          if (dist < bestD) { bestD = dist; best = { id: k, label: labels[i + 1] }; }
        }
        const limit = Math.max(1, Math.floor(r.length / 5));
        if (best && bestD <= limit) { id = best.id; label = best.label; }
        else { id = r; label = raw; }
      }

      // one vote per city per visitor per day
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
      const voter = crypto.createHash("sha256").update(ip + "|" + id).digest("hex").slice(0, 24);
      const [fresh] = await kv([["SET", `sg:v:${voter}`, "1", "NX", "EX", 86400]]);
      if (fresh) await kv([["ZINCRBY", "sg:count", 1, id], ["HSET", "sg:label", id, label], ["SADD", `sg:vs:${id}`, voter], ["EXPIRE", `sg:vs:${id}`, 86400], ["SET", "adm:newCity", Date.now()]]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      const key = String(req.query?.key || "");
      if (!admin || !same(key, admin)) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(403).send("Forbidden");
      }
      const [ranked, labels] = await kv([["ZREVRANGE", "sg:count", 0, 4, "WITHSCORES"], ["HGETALL", "sg:label"]]);
      const lab = {};
      for (let i = 0; i < (labels || []).length; i += 2) lab[labels[i]] = labels[i + 1];
      const rows = [];
      for (let i = 0; i < (ranked || []).length; i += 2) rows.push({ id: ranked[i], label: lab[ranked[i]] || ranked[i], n: ranked[i + 1] });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(page(rows, key));
    }
    return res.status(405).json({ error: "method" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
