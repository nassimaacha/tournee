// Vercel serverless function: builds the prompt and calls Claude.
// The Anthropic key lives in Vercel's environment variables (ANTHROPIC_API_KEY), never in the page.

const VIBES = ["Chill, on discute", "Bar à cocktails", "Danser", "Karaoké", "Bien manger", "Bar pas cher", "Concert ou DJ set", "Rooftop"];
const clean = (s, n) => String(s ?? "").replace(/[\r\n"`]/g, " ").slice(0, n).trim();

function buildPrompt({ friends, area, start, metro }) {
  const group = friends.map(f => `- ${f.nick} : budget max ${f.budget} €, envie "${f.vibe}"${f.sober ? ", ne boit pas d'alcool" : ""}`).join("\n");
  const minB = Math.min(...friends.map(f => f.budget));
  return `Tu es Tournée, une IA qui organise des soirées à Paris pour des groupes d'étudiants de 18 à 25 ans.
Construis UN plan de soirée qui convient à tout le groupe ci dessous.

Groupe :
${group}

Point de départ : ${area}, Paris
Heure de rendez vous : ${start}
Retour : ${metro ? "en métro, le plan doit finir avant le dernier métro (vers 0h40 en semaine, 1h40 le vendredi et samedi) ou proposer le Noctilien" : "taxi ou VTC possible"}

Règles :
- Le coût total par personne ne doit pas dépasser ${minB} € (le plus petit budget du groupe). Personne ne doit se sentir exclu.
- Chaque envie du groupe doit être servie au moins une fois dans la soirée.
- Si quelqu'un ne boit pas d'alcool, chaque bar doit avoir de vraies options sans alcool.
- 3 ou 4 étapes, proches les unes des autres (à pied ou 1 ou 2 stations de métro).
- Propose des lieux réels et connus à Paris intra muros, adaptés aux étudiants. Prix réalistes en euros.
- Donne pour chaque lieu ses coordonnées GPS précises (lat, lng, 4 décimales), et celles de la station de métro du retour.
- Écris en français, ton direct et complice, phrases courtes.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, de cette forme :
{"titre":"nom accrocheur de la soirée (5 mots max)","resume":"une phrase","compromis":"une ou deux phrases qui expliquent comment le plan respecte chaque personne, en citant les pseudos","etapes":[{"heure":"20:00","type":"Apéro","lieu":"nom du lieu","quartier":"quartier ou rue","pourquoi":"une phrase","prix_pp":10,"trajet":"comment venir de l'étape précédente","lat":48.8534,"lng":2.3711}],"total_pp":28,"retour":"comment rentrer et à quelle heure partir","retour_station":"nom de la station","retour_lat":48.8532,"retour_lng":2.3692}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "no_key" });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const friends = (Array.isArray(body.friends) ? body.friends : []).slice(0, 8).map(f => ({
    nick: clean(f?.nick, 20) || "Quelqu'un",
    budget: Math.min(100, Math.max(10, Number(f?.budget) || 30)),
    vibe: VIBES.includes(f?.vibe) ? f.vibe : VIBES[0],
    sober: !!f?.sober,
  }));
  if (friends.length < 2) return res.status(400).json({ error: "group" });

  const input = {
    friends,
    area: clean(body.area, 40) || "Bastille",
    start: /^\d{2}:\d{2}$/.test(body.start) ? body.start : "20:00",
    metro: body.metro !== false,
  };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: buildPrompt(input) }],
      }),
    });
    if (r.status === 429) return res.status(429).json({ error: "rate_limited" });
    if (!r.ok) { console.error("Anthropic error", r.status, await r.text()); return res.status(502).json({ error: "upstream" }); }

    const data = await r.json();
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const plan = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return res.status(200).json({ plan });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
