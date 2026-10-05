// "My city isn't here": visitors suggest a city, the owner sees a ranked list.
// POST /api/suggest            -> records a suggestion (stored in the same Upstash Redis as outings)
// GET  /api/suggest?key=XXXX   -> owner view, key must match the ADMIN_KEY environment variable

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
const clean = (s, n) => String(s ?? "").replace(/[\r\n<>"`]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "no_store" });
  try {
    if (req.method === "POST") {
      let body = req.body || {};
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const city = clean(body.city, 60);
      const key = norm(city);
      if (key.length < 2) return res.status(400).json({ error: "city" });
      // one vote per city per visitor per day
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
      const voter = crypto.createHash("sha256").update(ip + "|" + key).digest("hex").slice(0, 24);
      const [fresh] = await kv([["SET", `sg:v:${voter}`, "1", "NX", "EX", 86400]]);
      if (fresh) {
        const entry = JSON.stringify({ city, mode: body.mode === "day" ? "day" : "night", lang: clean(body.lang, 5), tz: clean(body.tz, 40), at: new Date().toISOString() });
        await kv([["ZINCRBY", "sg:count", 1, key], ["HSET", "sg:label", key, city], ["LPUSH", "sg:log", entry], ["LTRIM", "sg:log", 0, 499]]);
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      const admin = process.env.ADMIN_KEY;
      if (!admin || !same(String(req.query?.key || ""), admin)) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.status(403).send("Forbidden");
      }
      const [ranked, labels, log] = await kv([["ZREVRANGE", "sg:count", 0, 99, "WITHSCORES"], ["HGETALL", "sg:label"], ["LRANGE", "sg:log", 0, 49]]);
      const lab = {};
      for (let i = 0; i < (labels || []).length; i += 2) lab[labels[i]] = labels[i + 1];
      const rows = [];
      for (let i = 0; i < (ranked || []).length; i += 2) rows.push(`<tr><td>${esc(lab[ranked[i]] || ranked[i])}</td><td>${esc(ranked[i + 1])}</td></tr>`);
      const recent = (log || []).map(x => { try { const e = JSON.parse(x); return `<tr><td>${esc(e.city)}</td><td>${esc(e.mode)}</td><td>${esc(e.lang)}</td><td>${esc(e.tz)}</td><td>${esc(e.at.slice(0, 16).replace("T", " "))}</td></tr>`; } catch { return ""; } }).join("");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tournée, city requests</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#271A47;color:#DBC9FF;margin:0;padding:24px;max-width:760px}h1{font-weight:400;font-size:28px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:#BC994E;margin-top:32px}table{width:100%;border-collapse:collapse}td{padding:8px 6px;border-bottom:1px solid #43346C}td:last-child{text-align:right}</style>
<h1>City requests</h1><h2>Most asked</h2><table>${rows.join("") || "<tr><td>No requests yet</td><td></td></tr>"}</table>
<h2>Latest 50</h2><table>${recent || "<tr><td>Nothing yet</td></tr>"}</table>`);
    }
    return res.status(405).json({ error: "method" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
