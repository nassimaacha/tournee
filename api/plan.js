// Vercel serverless function: builds the prompt and calls Claude.
// The Anthropic key lives in Vercel's environment variables (ANTHROPIC_API_KEY), never in the page.

const VIBES = {
  night: { chill: "Chill, on discute", cocktails: "Bar à cocktails", dance: "Danser", karaoke: "Karaoké", food: "Bien manger", cheap: "Bar pas cher", music: "Concert ou DJ set", rooftop: "Rooftop" },
  culture: { museums: "Musées", contemporary: "Art contemporain", galleries: "Expos et galeries", streetart: "Street art", architecture: "Architecture", parks: "Parcs et jardins", markets: "Marchés", views: "Balade et points de vue" },
};
const LANGS = { fr: "français", en: "anglais", es: "espagnol", ar: "arabe standard moderne" };
const avoidRule = (avoid) => avoid.length
  ? `- Lieux déjà proposés à ce groupe, à NE PAS reprendre : ${avoid.join(", ")}. Choisis d'autres lieux. Seulement s'il n'existe vraiment plus d'autre option adaptée près du point de départ, tu peux réutiliser certains de ces lieux, mais jamais la même combinaison ni dans le même ordre.\n`
  : "";
const style = (lang) => `- Écris toutes les valeurs texte du JSON en ${LANGS[lang]}, ton direct et complice, phrases courtes. Garde les noms propres des lieux tels quels. Les clés JSON restent identiques.\n- Le champ "heure" est toujours au format 24 h HH:MM. ${lang === "en" ? "Dans les textes (retour, trajet, pourquoi...), écris les heures au format 12 h avec AM/PM (ex : 11:30 PM)." : "Dans les textes, écris les heures au format 24 h (ex : 23:30)."}`;
const CITIES = {
  "vienna": { tz: "Europe/Vienna", cultureNotes: "Beaucoup de musées ont des tarifs étudiants ; le MuseumsQuartier et le Prater se visitent gratuitement.", name: "Vienne", cur: "€", curName: "euros", min: 10, max: 100,
    transit: "en U-Bahn, qui roule toute la nuit le vendredi, le samedi et les veilles de jours fériés, sinon bus de nuit (NightLine)",
    notes: "Âge légal : 16 ans pour la bière et le vin, 18 ans pour les alcools forts. Le Gürtel concentre beaucoup de bars sous les arches du métro." },
  "toronto": { tz: "America/Toronto", cultureNotes: "Plusieurs musées ont des tarifs jeunes ou des créneaux gratuits ; Kensington Market et le Distillery District se visitent gratuitement.", name: "Toronto", cur: "CA$", curName: "dollars canadiens", min: 15, max: 200,
    transit: "en métro (TTC), qui ferme vers 1h30, ensuite bus et tramways de nuit (Blue Night)",
    notes: "Âge légal pour l'alcool en Ontario : 19 ans. Les bars ferment à 2h." },
  "sharm-el-sheikh": { tz: "Africa/Cairo", cultureNotes: "Peu de musées : privilégie les plages et le snorkeling (Naama Bay, Ras Um Sid), l'Old Market et la mosquée Al Sahaba. Il fait très chaud l'après midi, prévois de l'ombre.", name: "Charm el-Cheikh", cur: "EGP", curName: "livres égyptiennes (EGP)", min: 500, max: 8000,
    transit: "à pied : reste dans une seule zone comme Naama Bay, les zones sont éloignées les unes des autres",
    notes: "Ville balnéaire : la vie nocturne se concentre à Naama Bay et Soho Square. L'alcool est servi dans les hôtels et lieux touristiques licenciés, à partir de 21 ans : prévois aussi des cafés, chichas et lieux sans alcool." },
  "barcelona": { tz: "Europe/Madrid", cultureNotes: "La Sagrada Família et le Park Güell se réservent à l'avance ; plusieurs musées sont gratuits certains dimanches après midi.", name: "Barcelone", cur: "€", curName: "euros", min: 10, max: 100,
    transit: "en métro, qui ferme vers minuit en semaine, vers 2h le vendredi et roule toute la nuit le samedi, sinon NitBus",
    notes: "On sort tard : dîner vers 21h30, les clubs se remplissent après 1h. Âge légal pour l'alcool : 18 ans." },
  "berlin": { tz: "Europe/Berlin", cultureNotes: "Beaucoup de musées ont des tarifs étudiants ; l'East Side Gallery et le mémorial du Mur sont gratuits.", name: "Berlin", cur: "€", curName: "euros", min: 10, max: 100,
    transit: "en U-Bahn et S-Bahn, qui roulent toute la nuit le vendredi et le samedi, sinon bus de nuit",
    notes: "Les clubs ouvrent tard et la sélection à l'entrée est stricte. Âge légal : 16 ans pour la bière et le vin, 18 ans pour les alcools forts." },
  "amsterdam": { tz: "Europe/Amsterdam", cultureNotes: "Les grands musées se réservent à l'avance ; le Vondelpark et les canaux sont gratuits.", name: "Amsterdam", cur: "€", curName: "euros", min: 10, max: 100,
    transit: "en tram et métro, puis bus de nuit (nachtbus) après minuit",
    notes: "Âge légal pour l'alcool : 18 ans. Beaucoup de bars ferment vers 1h en semaine, plus tard le week end." },
  "lisbon": { tz: "Europe/Lisbon", cultureNotes: "Beaucoup de points de vue (miradouros) sont gratuits ; plusieurs musées sont gratuits certains dimanches matin.", name: "Lisbonne", cur: "€", curName: "euros", min: 10, max: 100,
    transit: "en métro, qui ferme vers 1h, sinon bus de nuit",
    notes: "Au Bairro Alto on boit souvent dans la rue devant les bars ; les clubs ouvrent tard. Âge légal : 18 ans." },
  "rome": { tz: "Europe/Rome", cultureNotes: "Les musées d'État sont gratuits le premier dimanche du mois ; les Musées du Vatican se réservent à l'avance.", name: "Rome", cur: "€", curName: "euros", min: 10, max: 100,
    transit: "en métro, qui ferme vers 23h30 en semaine et vers 1h30 le vendredi et samedi, sinon bus de nuit",
    notes: "Aperitivo vers 19h, dîner tard ; la vie nocturne se concentre à Trastevere, Testaccio et Pigneto. Âge légal : 18 ans." },
  "miami": { tz: "America/New_York", cultureNotes: "Les murs de Wynwood se visitent gratuitement ; il fait chaud, prévois de l'ombre ou de la climatisation l'après midi.", name: "Miami", cur: "$", curName: "dollars américains", min: 10, max: 150,
    transit: "en Metrorail et Metromover, qui s'arrêtent vers minuit, les options de nuit sont limitées",
    notes: "L'âge légal pour l'alcool est 21 ans : privilégie des lieux accessibles dès 18 ans quand c'est possible. Reste dans un ou deux quartiers voisins." },
  "houston": { tz: "America/Chicago", cultureNotes: "Plusieurs musées du Museum District sont gratuits ou ont des jours gratuits ; reste dans un ou deux quartiers.", name: "Houston", cur: "$", curName: "dollars américains", min: 10, max: 150,
    transit: "en METRORail et bus, avec un service réduit tard le soir : reste dans un quartier où l'on peut tout faire à pied",
    notes: "L'âge légal pour l'alcool est 21 ans : privilégie des lieux accessibles dès 18 ans quand c'est possible. La ville est très étendue : reste dans un seul quartier ou deux quartiers voisins." },
  "mexico-city": { tz: "America/Mexico_City", cultureNotes: "Beaucoup de musées sont gratuits le dimanche pour les résidents ; le parc de Chapultepec et le centre historique se font à pied.", name: "Mexico", cur: "MXN", curName: "pesos mexicains (MXN)", min: 200, max: 3000,
    transit: "en métro, qui ferme vers minuit, sinon Metrobús",
    notes: "Âge légal pour l'alcool : 18 ans. Reste dans des quartiers animés comme Roma Norte, Condesa ou Juárez." },
  "montreal": { tz: "America/Toronto", cultureNotes: "Le mont Royal est gratuit ; plusieurs musées ont des tarifs étudiants.", name: "Montréal", cur: "CA$", curName: "dollars canadiens", min: 15, max: 200,
    transit: "en métro, qui ferme vers 0h30 en semaine et vers 1h30 le samedi, sinon bus de nuit",
    notes: "Âge légal pour l'alcool : 18 ans. Les bars ferment à 3h." },
  "tokyo": { tz: "Asia/Tokyo", cultureNotes: "Beaucoup de temples et de sanctuaires sont gratuits ; les musées ont souvent des tarifs étudiants.", name: "Tokyo", cur: "¥", curName: "yens japonais", min: 1000, max: 15000,
    transit: "en train et métro : le plan doit finir avant les derniers trains (vers minuit), sinon il faut tenir jusqu'aux premiers trains vers 5h",
    notes: "Âge légal pour l'alcool : 20 ans. Beaucoup d'izakayas et de bars à petit prix." },
  "seoul": { tz: "Asia/Seoul", cultureNotes: "Les palais royaux sont gratuits en hanbok ; plusieurs musées nationaux sont gratuits.", name: "Séoul", cur: "₩", curName: "wons sud-coréens", min: 10000, max: 150000,
    transit: "en métro, qui s'arrête vers minuit, sinon bus de nuit (Owl)",
    notes: "Âge légal pour l'alcool : 19 ans. Les soirées durent tard à Hongdae et Itaewon." },
  "bangkok": { tz: "Asia/Bangkok", cultureNotes: "Une tenue couvrant épaules et genoux est obligatoire dans les temples ; il fait chaud, prévois des lieux climatisés l'après midi.", name: "Bangkok", cur: "฿", curName: "bahts thaïlandais", min: 300, max: 5000,
    transit: "en BTS et MRT, qui s'arrêtent vers minuit",
    notes: "Âge légal pour l'alcool : 20 ans. La vente d'alcool est interdite à certaines heures et certains jours fériés bouddhistes." },
  "singapore": { tz: "Asia/Singapore", cultureNotes: "Les jardins extérieurs de Gardens by the Bay sont gratuits ; il fait chaud et humide, alterne intérieur et extérieur.", name: "Singapour", cur: "S$", curName: "dollars de Singapour", min: 15, max: 200,
    transit: "en MRT, qui s'arrête vers minuit",
    notes: "Âge légal pour l'alcool : 18 ans. L'alcool est cher, les happy hours aident beaucoup. Boire dans les lieux publics est interdit après 22h30." },
  "marrakech": { tz: "Africa/Casablanca", cultureNotes: "Les jardins et palais sont payants mais peu chers ; en été il fait très chaud l'après midi, privilégie la matinée et la fin de journée.", name: "Marrakech", cur: "MAD", curName: "dirhams marocains (MAD)", min: 100, max: 1000,
    transit: "à pied : le plan doit rester dans un quartier où tout se fait à pied, il n'y a pas de métro",
    notes: "L'alcool n'est servi que dans des lieux licenciés (surtout à Guéliz, l'Hivernage et dans les hôtels) : prévois aussi des rooftops, cafés et lieux sans alcool." },
  "cape-town": { tz: "Africa/Johannesburg", cultureNotes: "Reste dans les zones fréquentées ; la météo change vite, vérifie le vent avant Table Mountain.", name: "Le Cap", cur: "R", curName: "rands sud-africains", min: 150, max: 2000,
    transit: "à pied entre des lieux très proches dans une zone animée : les transports publics de nuit sont limités, garde toutes les étapes à quelques minutes à pied",
    notes: "Âge légal pour l'alcool : 18 ans. Pour la sécurité, évite de marcher seul la nuit et reste dans des zones animées comme Bree Street ou le V&A Waterfront." },
  "buenos-aires": { tz: "America/Argentina/Buenos_Aires", cultureNotes: "Beaucoup de musées sont gratuits certains jours ; Palermo et ses parcs se font à pied.", name: "Buenos Aires", cur: "US$", curName: "dollars américains (équivalent, les prix locaux changent vite)", min: 10, max: 120,
    transit: "en métro (Subte), qui ferme vers 23h, ensuite les bus (colectivos) roulent toute la nuit",
    notes: "On sort très tard : dîner vers 22h, bars après minuit, clubs vers 2h. Âge légal : 18 ans." },
  "rio": { tz: "America/Sao_Paulo", cultureNotes: "Les plages et le centre historique sont gratuits ; reste dans les zones fréquentées et garde peu d'objets de valeur.", name: "Rio de Janeiro", cur: "R$", curName: "réaux brésiliens", min: 50, max: 600,
    transit: "en métro, qui ferme vers minuit en semaine, plus tard certains soirs de week end",
    notes: "Âge légal pour l'alcool : 18 ans. Lapa est très animée le week end ; reste dans les zones fréquentées la nuit." },
  "sao-paulo": { tz: "America/Sao_Paulo", cultureNotes: "Le MASP est gratuit le mardi ; l'avenue Paulista est piétonne le dimanche.", name: "São Paulo", cur: "R$", curName: "réaux brésiliens", min: 50, max: 600,
    transit: "en métro, qui ferme vers minuit (vers 1h le samedi)",
    notes: "Âge légal pour l'alcool : 18 ans. La ville est immense : reste dans un ou deux quartiers voisins comme Vila Madalena et Pinheiros." },
  "sydney": { tz: "Australia/Sydney", cultureNotes: "Beaucoup de musées sont gratuits ; la balade côtière de Bondi à Coogee est gratuite.", name: "Sydney", cur: "A$", curName: "dollars australiens", min: 15, max: 200,
    transit: "en train et métro, qui s'arrêtent vers minuit, ensuite bus NightRide",
    notes: "Âge légal pour l'alcool : 18 ans, une pièce d'identité est souvent demandée à l'entrée." },
  "melbourne": { tz: "Australia/Melbourne", cultureNotes: "Les collections permanentes de la NGV sont gratuites ; les ruelles de street art du centre sont gratuites.", name: "Melbourne", cur: "A$", curName: "dollars australiens", min: 15, max: 200,
    transit: "en tram et train ; le vendredi et le samedi, le Night Network fait rouler des trains et trams toute la nuit",
    notes: "Âge légal pour l'alcool : 18 ans. Beaucoup de bars se cachent dans les ruelles (laneways) du centre." },
  "paris": { tz: "Europe/Paris", cultureNotes: "Beaucoup de musées nationaux sont gratuits pour les moins de 26 ans résidents de l'UE.", name: "Paris", cur: "€", curName: "euros", min: 10, max: 100,
    transit: "en métro, le plan doit finir avant le dernier métro (vers 0h40 en semaine, 1h40 le vendredi et samedi) ou proposer le Noctilien",
    notes: "Reste dans Paris intra muros." },
  "london": { tz: "Europe/London", cultureNotes: "Beaucoup de grands musées sont gratuits (British Museum, Tate Modern, National Gallery...).", name: "Londres", cur: "£", curName: "livres sterling", min: 10, max: 100,
    transit: "en Tube, le plan doit finir avant le dernier Tube (vers 0h30) ou utiliser le Night Tube le vendredi et samedi, sinon un bus de nuit",
    notes: "Beaucoup de pubs ferment vers 23h, les bars et clubs plus tard. Âge légal pour l'alcool : 18 ans." },
  "dubai": { tz: "Asia/Dubai", cultureNotes: "Il fait très chaud la journée une grande partie de l'année : privilégie l'intérieur l'après midi et les extérieurs en fin de journée.", name: "Dubaï", cur: "AED", curName: "dirhams émiratis (AED)", min: 50, max: 600,
    transit: "en métro de Dubaï, le plan doit finir avant la fermeture du métro (vers minuit en semaine, plus tard le week end)",
    notes: "L'alcool n'est servi que dans des lieux licenciés, souvent dans les hôtels, et seulement à partir de 21 ans : prévois des étapes sans alcool accessibles à tous. Respecte les règles locales de tenue et de comportement." },
  "madrid": { tz: "Europe/Madrid", cultureNotes: "Plusieurs grands musées ont des créneaux gratuits en fin de journée et des tarifs étudiants.", name: "Madrid", cur: "€", curName: "euros", min: 10, max: 100,
    transit: "en métro, le plan doit finir avant la fermeture du métro (vers 1h30) ou proposer les bus de nuit (búhos)",
    notes: "À Madrid on sort tard : dîner vers 21h30 ou 22h, les bars se remplissent après minuit." },
  "new-york": { tz: "America/New_York", cultureNotes: "Certains musées ont des tarifs étudiants ou des créneaux gratuits. La High Line, Central Park et le ferry de Staten Island sont gratuits.", name: "New York", cur: "$", curName: "dollars américains", min: 10, max: 150,
    transit: "en métro (subway), qui roule toute la nuit : le plan peut finir tard, mais privilégie des stations proches et fréquentées pour le retour",
    notes: "L'âge légal pour l'alcool est 21 ans : privilégie des lieux accessibles dès 18 ans quand c'est possible. Reste dans un seul quartier ou deux quartiers voisins." },
  "los-angeles": { tz: "America/Los_Angeles", cultureNotes: "La ville est très étendue : reste dans un seul quartier ou deux quartiers voisins. Certains musées sont gratuits (The Broad, Getty Center).", name: "Los Angeles", cur: "$", curName: "dollars américains", min: 10, max: 150,
    transit: "en transports en commun (Metro Rail et bus), le plan doit finir avant le dernier train (vers minuit) ou proposer un bus de nuit",
    notes: "L'âge légal pour l'alcool est 21 ans : privilégie des lieux accessibles dès 18 ans. La ville est très étendue : reste dans un seul quartier ou deux quartiers voisins." },
  "casablanca": { tz: "Africa/Casablanca", cultureNotes: "La Mosquée Hassan II se visite seulement à certains horaires, avec visite guidée.", name: "Casablanca", cur: "MAD", curName: "dirhams marocains (MAD)", min: 100, max: 1000,
    transit: "en tramway, le plan doit finir avant le dernier tram (vers 22h30), sinon proposer le petit taxi comme seule alternative",
    notes: "L'alcool n'est servi que dans certains bars, restaurants et hôtels licenciés : prévois aussi des cafés, rooftops et lieux sans alcool. Le soir, le petit taxi est le moyen le plus courant." },
};

const clean = (s, n) => String(s ?? "").replace(/[\r\n"`]/g, " ").slice(0, n).trim();

function today(c) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: c.tz }).format(new Date());
}

const JSON_SHAPE = (first) => `Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, de cette forme :
{"titre":"nom accrocheur (5 mots max)","resume":"une phrase","compromis":"une ou deux phrases qui expliquent comment le plan respecte chaque personne, en citant les pseudos","etapes":[{"heure":"${first}","type":"type d'étape","lieu":"nom du lieu","quartier":"quartier ou rue","pourquoi":"une phrase","prix_pp":10,"trajet":"comment venir de l'étape précédente","lat":48.8534,"lng":2.3711}],"total_pp":28,"retour":"comment rentrer et à quelle heure partir","retour_station":"nom de l'arrêt","retour_lat":48.8532,"retour_lng":2.3692}`;

function buildCulturePrompt({ c, lang, avoid, stops, friends, area, start, metro }) {
  const group = friends.map(f => `- ${f.nick} : budget max ${f.budget} ${c.cur}, aime "${f.vibe}"${f.flag ? ", est étudiant (tarif étudiant)" : ""}`).join("\n");
  const minB = Math.min(...friends.map(f => f.budget));
  return `Tu es Tournée, une IA qui organise des sorties culturelles à ${c.name} pour des groupes d'étudiants de 18 à 25 ans.
Construis UN plan de journée (musées, expos, galeries, street art, architecture, parcs, jardins, marchés, points de vue) qui convient à tout le groupe ci dessous.

Groupe :
${group}

Date : ${today(c)}
Point de départ : ${area}, ${c.name}
Heure de rendez vous : ${start}
Déplacements : ${metro ? "en transports en commun et à pied, pas de taxi" : "taxi ou VTC possible"}

Règles :
- Le coût total par personne ne doit pas dépasser ${minB} ${c.cur} (le plus petit budget du groupe). Personne ne doit se sentir exclu.
- Chaque centre d'intérêt du groupe doit être servi au moins une fois.
- Utilise les gratuités et les tarifs étudiants pour les personnes qui sont étudiantes.
- Tiens compte du jour : évite les lieux habituellement fermés ce jour là.
- Exactement ${stops} étape(s)${stops > 1 ? ", proches les unes des autres" : ""}. Au moins ${Math.min(2, stops)} étape(s) doivent être de vrais lieux culturels ou de plein air : musée, expo, galerie, monument, parc, jardin, marché, point de vue, street art.
- Une seule pause café ou snack maximum, jamais de bar ni d'alcool. Fin de journée vers 19h.
- Le champ "type" décrit l'activité (ex : Musée, Parc, Galerie, Marché, Balade, Pause café).
- Propose des lieux réels et connus à ${c.name}. Prix réalistes en ${c.curName} : prix_pp et total_pp sont des nombres dans cette monnaie.
- Contexte local : ${c.cultureNotes}
- Donne pour chaque lieu ses coordonnées GPS précises (lat, lng, 4 décimales), et celles de l'arrêt de transport du retour (retour_station).
${avoidRule(avoid)}${style(lang)}

${JSON_SHAPE(start)}`;
}

function buildPrompt({ c, lang, avoid, stops, friends, area, start, metro }) {
  const group = friends.map(f => `- ${f.nick} : budget max ${f.budget} ${c.cur}, envie "${f.vibe}"${f.flag ? ", ne boit pas d'alcool" : ""}`).join("\n");
  const minB = Math.min(...friends.map(f => f.budget));
  return `Tu es Tournée, une IA qui organise des soirées à ${c.name} pour des groupes d'étudiants de 18 à 25 ans.
Construis UN plan de soirée qui convient à tout le groupe ci dessous.

Groupe :
${group}

Date : ${today(c)}
Point de départ : ${area}, ${c.name}
Heure de rendez vous : ${start}
Retour : ${metro ? c.transit : "taxi ou VTC possible"}

Règles :
- Le coût total par personne ne doit pas dépasser ${minB} ${c.cur} (le plus petit budget du groupe). Personne ne doit se sentir exclu.
- Chaque envie du groupe doit être servie au moins une fois dans la soirée.
- Si quelqu'un ne boit pas d'alcool, chaque bar doit avoir de vraies options sans alcool.
- Exactement ${stops} étape(s)${stops > 1 ? ", proches les unes des autres (à pied ou 1 ou 2 stations de métro)" : ""}.
- Propose des lieux réels et connus à ${c.name}, adaptés aux étudiants. Prix réalistes en ${c.curName} : prix_pp et total_pp sont des nombres dans cette monnaie.
- Contexte local : ${c.notes}
- Donne pour chaque lieu ses coordonnées GPS précises (lat, lng, 4 décimales), et celles de l'arrêt de transport du retour (retour_station).
${avoidRule(avoid)}${style(lang)}

${JSON_SHAPE("20:00")}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "no_key" });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const c = CITIES[body.city] || CITIES.paris;
  const mode = body.mode === "culture" ? "culture" : "night";
  const lang = LANGS[body.lang] ? body.lang : "fr";
  const friends = (Array.isArray(body.friends) ? body.friends : []).slice(0, 8).map(f => ({
    nick: clean(f?.nick, 20) || "Quelqu'un",
    budget: Math.min(c.max, Math.max(c.min, Number(f?.budget) || c.min)),
    vibe: VIBES[mode][f?.vibe] || Object.values(VIBES[mode]).find(v => v === f?.vibe) || Object.values(VIBES[mode])[0],
    flag: !!(f?.flag ?? f?.sober),
  }));
  if (friends.length < 1) return res.status(400).json({ error: "group" });

  const avoid = (Array.isArray(body.avoid) ? body.avoid : []).slice(0, 40).map(x => clean(x, 60)).filter(Boolean);
  const input = {
    c,
    lang,
    avoid,
    stops: Math.min(5, Math.max(1, parseInt(body.stops, 10) || 3)),
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
        max_tokens: 3000,
        messages: [{ role: "user", content: mode === "culture" ? buildCulturePrompt(input) : buildPrompt(input) }],
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
