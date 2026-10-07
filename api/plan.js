// Vercel serverless function: builds the prompt, asks Claude for a plan, then checks it against Google:
// every place is looked up on Google Places (closed or unknown places get replaced),
// coordinates come from Google, and travel times between stops come from the Google Routes API.
// Keys live in Vercel environment variables: ANTHROPIC_API_KEY and GOOGLE_SERVER_KEY.

const VIBES = {
  night: { chill: "Chill, on discute", cocktails: "Bar à cocktails", dance: "Danser", karaoke: "Karaoké", food: "Bien manger", cheap: "Bar pas cher", music: "Concert ou DJ set", rooftop: "Rooftop" },
  culture: { museums: "Musées", contemporary: "Art contemporain", galleries: "Expos et galeries", streetart: "Street art", architecture: "Architecture", parks: "Parcs et jardins", markets: "Marchés", views: "Balade et points de vue", conceptcafe: "Cafés concept (café à chats, jeux de société, livres, mangas, thèmes originaux)" },
};
const LANGS = { fr: "français", en: "anglais", es: "espagnol" };
const CITIES = {
  "khobar": { dry: true, tz: "Asia/Riyadh", cultureNotes: "Corniche de Khobar, quartier de la Water Tower, plages de Half Moon Bay, Ithra (centre culturel du roi Abdulaziz, à Dhahran tout proche). Il fait très chaud : intérieur l'après midi, Corniche en fin de journée. Tenue correcte exigée.", name: "Khobar", cur: "SAR", curName: "riyals saoudiens (SAR)", min: 0, max: 600,
    transit: "à pied : il n'y a pas de métro, garde des étapes très proches les unes des autres",
    notes: "L'alcool est totalement interdit en Arabie saoudite : AUCUN bar ni alcool, jamais. Propose des cafés de spécialité, lounges, restaurants, desserts, balades sur la Corniche, Ajdan Walk, bowling, karaoké et événements. Tenue correcte et règles locales à respecter." },
  "prague": { tz: "Europe/Prague", cultureNotes: "Château de Prague, pont Charles, Vieille Ville, musées et galeries, parc de Letná. Beaucoup de musées ont des tarifs étudiants.", name: "Prague", cur: "Kč", curName: "couronnes tchèques (CZK)", min: 0, max: 5000,
    transit: "en métro, qui roule jusque vers minuit, puis en tramways de nuit",
    notes: "Âge légal pour l'alcool : 18 ans. La bière est très bon marché ; quartiers animés : Vieille Ville, Žižkov, Vinohrady, Karlín." },
  "riyadh": { dry: true, tz: "Asia/Riyadh", cultureNotes: "Musées et sites historiques : Musée national, forteresse de Masmak, Diriyah (At-Turaif, classé UNESCO). Il fait très chaud une grande partie de l'année : intérieur l'après midi, extérieur en fin de journée. Tenue correcte exigée.", name: "Riyad", cur: "SAR", curName: "riyals saoudiens (SAR)", min: 0, max: 600,
    transit: "en métro de Riyad, qui ferme vers minuit, sinon VTC",
    notes: "L'alcool est totalement interdit en Arabie saoudite : AUCUN bar ni alcool, jamais. Propose des cafés de spécialité, lounges, restaurants, desserts, Boulevard City, concerts et événements, karaoké, bowling, sorties en soirée en famille ou entre amis. Tenue correcte et règles locales à respecter." },
  "vienna": { tz: "Europe/Vienna", cultureNotes: "Beaucoup de musées ont des tarifs étudiants ; le MuseumsQuartier et le Prater se visitent gratuitement.", name: "Vienne", cur: "€", curName: "euros", min: 0, max: 500,
    transit: "en U-Bahn, qui roule toute la nuit le vendredi, le samedi et les veilles de jours fériés, sinon bus de nuit (NightLine)",
    notes: "Âge légal : 16 ans pour la bière et le vin, 18 ans pour les alcools forts. Le Gürtel concentre beaucoup de bars sous les arches du métro." },
  "toronto": { tz: "America/Toronto", cultureNotes: "Plusieurs musées ont des tarifs jeunes ou des créneaux gratuits ; Kensington Market et le Distillery District se visitent gratuitement.", name: "Toronto", cur: "CA$", curName: "dollars canadiens", min: 0, max: 800,
    transit: "en métro (TTC), qui ferme vers 1h30, ensuite bus et tramways de nuit (Blue Night)",
    notes: "Âge légal pour l'alcool en Ontario : 19 ans. Les bars ferment à 2h." },
  "sharm-el-sheikh": { tz: "Africa/Cairo", cultureNotes: "Peu de musées : privilégie les plages et le snorkeling (Naama Bay, Ras Um Sid), l'Old Market et la mosquée Al Sahaba. Il fait très chaud l'après midi, prévois de l'ombre.", name: "Charm el-Cheikh", cur: "EGP", curName: "livres égyptiennes (EGP)", min: 0, max: 28000,
    transit: "à pied : reste dans une seule zone comme Naama Bay, les zones sont éloignées les unes des autres",
    notes: "Ville balnéaire : la vie nocturne se concentre à Naama Bay et Soho Square. L'alcool est servi dans les hôtels et lieux touristiques licenciés, à partir de 21 ans : prévois aussi des cafés, chichas et lieux sans alcool." },
  "barcelona": { tz: "Europe/Madrid", cultureNotes: "La Sagrada Família et le Park Güell se réservent à l'avance ; plusieurs musées sont gratuits certains dimanches après midi.", name: "Barcelone", cur: "€", curName: "euros", min: 0, max: 500,
    transit: "en métro, qui ferme vers minuit en semaine, vers 2h le vendredi et roule toute la nuit le samedi, sinon NitBus",
    notes: "On sort tard : dîner vers 21h30, les clubs se remplissent après 1h. Âge légal pour l'alcool : 18 ans." },
  "berlin": { tz: "Europe/Berlin", cultureNotes: "Beaucoup de musées ont des tarifs étudiants ; l'East Side Gallery et le mémorial du Mur sont gratuits.", name: "Berlin", cur: "€", curName: "euros", min: 0, max: 500,
    transit: "en U-Bahn et S-Bahn, qui roulent toute la nuit le vendredi et le samedi, sinon bus de nuit",
    notes: "Les clubs ouvrent tard et la sélection à l'entrée est stricte. Âge légal : 16 ans pour la bière et le vin, 18 ans pour les alcools forts." },
  "amsterdam": { tz: "Europe/Amsterdam", cultureNotes: "Les grands musées se réservent à l'avance ; le Vondelpark et les canaux sont gratuits.", name: "Amsterdam", cur: "€", curName: "euros", min: 0, max: 500,
    transit: "en tram et métro, puis bus de nuit (nachtbus) après minuit",
    notes: "Âge légal pour l'alcool : 18 ans. Beaucoup de bars ferment vers 1h en semaine, plus tard le week end." },
  "lisbon": { tz: "Europe/Lisbon", cultureNotes: "Beaucoup de points de vue (miradouros) sont gratuits ; plusieurs musées sont gratuits certains dimanches matin.", name: "Lisbonne", cur: "€", curName: "euros", min: 0, max: 500,
    transit: "en métro, qui ferme vers 1h, sinon bus de nuit",
    notes: "Au Bairro Alto on boit souvent dans la rue devant les bars ; les clubs ouvrent tard. Âge légal : 18 ans." },
  "rome": { tz: "Europe/Rome", cultureNotes: "Les musées d'État sont gratuits le premier dimanche du mois ; les Musées du Vatican se réservent à l'avance.", name: "Rome", cur: "€", curName: "euros", min: 0, max: 500,
    transit: "en métro, qui ferme vers 23h30 en semaine et vers 1h30 le vendredi et samedi, sinon bus de nuit",
    notes: "Aperitivo vers 19h, dîner tard ; la vie nocturne se concentre à Trastevere, Testaccio et Pigneto. Âge légal : 18 ans." },
  "miami": { tz: "America/New_York", cultureNotes: "Les murs de Wynwood se visitent gratuitement ; il fait chaud, prévois de l'ombre ou de la climatisation l'après midi.", name: "Miami", cur: "$", curName: "dollars américains", min: 0, max: 600,
    transit: "en Metrorail et Metromover, qui s'arrêtent vers minuit, les options de nuit sont limitées",
    notes: "L'âge légal pour l'alcool est 21 ans : privilégie des lieux accessibles dès 18 ans quand c'est possible. Reste dans un ou deux quartiers voisins." },
  "houston": { tz: "America/Chicago", cultureNotes: "Plusieurs musées du Museum District sont gratuits ou ont des jours gratuits ; reste dans un ou deux quartiers.", name: "Houston", cur: "$", curName: "dollars américains", min: 0, max: 600,
    transit: "en METRORail et bus, avec un service réduit tard le soir : reste dans un quartier où l'on peut tout faire à pied",
    notes: "L'âge légal pour l'alcool est 21 ans : privilégie des lieux accessibles dès 18 ans quand c'est possible. La ville est très étendue : reste dans un seul quartier ou deux quartiers voisins." },
  "mexico-city": { tz: "America/Mexico_City", cultureNotes: "Beaucoup de musées sont gratuits le dimanche pour les résidents ; le parc de Chapultepec et le centre historique se font à pied.", name: "Mexico", cur: "MXN", curName: "pesos mexicains (MXN)", min: 0, max: 10600,
    transit: "en métro, qui ferme vers minuit, sinon Metrobús",
    notes: "Âge légal pour l'alcool : 18 ans. Reste dans des quartiers animés comme Roma Norte, Condesa ou Juárez." },
  "montreal": { tz: "America/Toronto", cultureNotes: "Le mont Royal est gratuit ; plusieurs musées ont des tarifs étudiants.", name: "Montréal", cur: "CA$", curName: "dollars canadiens", min: 0, max: 800,
    transit: "en métro, qui ferme vers 0h30 en semaine et vers 1h30 le samedi, sinon bus de nuit",
    notes: "Âge légal pour l'alcool : 18 ans. Les bars ferment à 3h." },
  "tokyo": { tz: "Asia/Tokyo", cultureNotes: "Beaucoup de temples et de sanctuaires sont gratuits ; les musées ont souvent des tarifs étudiants.", name: "Tokyo", cur: "¥", curName: "yens japonais", min: 0, max: 85000,
    transit: "en train et métro : le plan doit finir avant les derniers trains (vers minuit), sinon il faut tenir jusqu'aux premiers trains vers 5h",
    notes: "Âge légal pour l'alcool : 20 ans. Beaucoup d'izakayas et de bars à petit prix." },
  "seoul": { tz: "Asia/Seoul", cultureNotes: "Les palais royaux sont gratuits en hanbok ; plusieurs musées nationaux sont gratuits.", name: "Séoul", cur: "₩", curName: "wons sud-coréens", min: 0, max: 800000,
    transit: "en métro, qui s'arrête vers minuit, sinon bus de nuit (Owl)",
    notes: "Âge légal pour l'alcool : 19 ans. Les soirées durent tard à Hongdae et Itaewon." },
  "bangkok": { tz: "Asia/Bangkok", cultureNotes: "Une tenue couvrant épaules et genoux est obligatoire dans les temples ; il fait chaud, prévois des lieux climatisés l'après midi.", name: "Bangkok", cur: "฿", curName: "bahts thaïlandais", min: 0, max: 18900,
    transit: "en BTS et MRT, qui s'arrêtent vers minuit",
    notes: "Âge légal pour l'alcool : 20 ans. La vente d'alcool est interdite à certaines heures et certains jours fériés bouddhistes." },
  "singapore": { tz: "Asia/Singapore", cultureNotes: "Les jardins extérieurs de Gardens by the Bay sont gratuits ; il fait chaud et humide, alterne intérieur et extérieur.", name: "Singapour", cur: "S$", curName: "dollars de Singapour", min: 0, max: 700,
    transit: "en MRT, qui s'arrête vers minuit",
    notes: "Âge légal pour l'alcool : 18 ans. L'alcool est cher, les happy hours aident beaucoup. Boire dans les lieux publics est interdit après 22h30." },
  "marrakech": { tz: "Africa/Casablanca", cultureNotes: "Les jardins et palais sont payants mais peu chers ; en été il fait très chaud l'après midi, privilégie la matinée et la fin de journée.", name: "Marrakech", cur: "MAD", curName: "dirhams marocains (MAD)", min: 0, max: 5400,
    transit: "à pied : le plan doit rester dans un quartier où tout se fait à pied, il n'y a pas de métro",
    notes: "L'alcool n'est servi que dans des lieux licenciés (surtout à Guéliz, l'Hivernage et dans les hôtels) : prévois aussi des rooftops, cafés et lieux sans alcool." },
  "cape-town": { tz: "Africa/Johannesburg", cultureNotes: "Reste dans les zones fréquentées ; la météo change vite, vérifie le vent avant Table Mountain.", name: "Le Cap", cur: "R", curName: "rands sud-africains", min: 0, max: 10300,
    transit: "à pied entre des lieux très proches dans une zone animée : les transports publics de nuit sont limités, garde toutes les étapes à quelques minutes à pied",
    notes: "Âge légal pour l'alcool : 18 ans. Pour la sécurité, évite de marcher seul la nuit et reste dans des zones animées comme Bree Street ou le V&A Waterfront." },
  "buenos-aires": { tz: "America/Argentina/Buenos_Aires", cultureNotes: "Beaucoup de musées sont gratuits certains jours ; Palermo et ses parcs se font à pied.", name: "Buenos Aires", cur: "US$", curName: "dollars américains (équivalent, les prix locaux changent vite)", min: 0, max: 600,
    transit: "en métro (Subte), qui ferme vers 23h, ensuite les bus (colectivos) roulent toute la nuit",
    notes: "On sort très tard : dîner vers 22h, bars après minuit, clubs vers 2h. Âge légal : 18 ans." },
  "rio": { tz: "America/Sao_Paulo", cultureNotes: "Les plages et le centre historique sont gratuits ; reste dans les zones fréquentées et garde peu d'objets de valeur.", name: "Rio de Janeiro", cur: "R$", curName: "réaux brésiliens", min: 0, max: 3200,
    transit: "en métro, qui ferme vers minuit en semaine, plus tard certains soirs de week end",
    notes: "Âge légal pour l'alcool : 18 ans. Lapa est très animée le week end ; reste dans les zones fréquentées la nuit." },
  "sao-paulo": { tz: "America/Sao_Paulo", cultureNotes: "Le MASP est gratuit le mardi ; l'avenue Paulista est piétonne le dimanche.", name: "São Paulo", cur: "R$", curName: "réaux brésiliens", min: 0, max: 3200,
    transit: "en métro, qui ferme vers minuit (vers 1h le samedi)",
    notes: "Âge légal pour l'alcool : 18 ans. La ville est immense : reste dans un ou deux quartiers voisins comme Vila Madalena et Pinheiros." },
  "sydney": { tz: "Australia/Sydney", cultureNotes: "Beaucoup de musées sont gratuits ; la balade côtière de Bondi à Coogee est gratuite.", name: "Sydney", cur: "A$", curName: "dollars australiens", min: 0, max: 900,
    transit: "en train et métro, qui s'arrêtent vers minuit, ensuite bus NightRide",
    notes: "Âge légal pour l'alcool : 18 ans, une pièce d'identité est souvent demandée à l'entrée." },
  "melbourne": { tz: "Australia/Melbourne", cultureNotes: "Les collections permanentes de la NGV sont gratuites ; les ruelles de street art du centre sont gratuites.", name: "Melbourne", cur: "A$", curName: "dollars australiens", min: 0, max: 900,
    transit: "en tram et train ; le vendredi et le samedi, le Night Network fait rouler des trains et trams toute la nuit",
    notes: "Âge légal pour l'alcool : 18 ans. Beaucoup de bars se cachent dans les ruelles (laneways) du centre." },
  "paris": { tz: "Europe/Paris", cultureNotes: "Beaucoup de musées nationaux sont gratuits pour les moins de 26 ans résidents de l'UE.", name: "Paris", cur: "€", curName: "euros", min: 0, max: 500,
    transit: "en métro, le plan doit finir avant le dernier métro (vers 0h40 en semaine, 1h40 le vendredi et samedi) ou proposer le Noctilien",
    notes: "Reste dans Paris intra muros." },
  "london": { tz: "Europe/London", cultureNotes: "Beaucoup de grands musées sont gratuits (British Museum, Tate Modern, National Gallery...).", name: "Londres", cur: "£", curName: "livres sterling", min: 0, max: 400,
    transit: "en Tube, le plan doit finir avant le dernier Tube (vers 0h30) ou utiliser le Night Tube le vendredi et samedi, sinon un bus de nuit",
    notes: "Beaucoup de pubs ferment vers 23h, les bars et clubs plus tard. Âge légal pour l'alcool : 18 ans." },
  "dubai": { tz: "Asia/Dubai", cultureNotes: "Il fait très chaud la journée une grande partie de l'année : privilégie l'intérieur l'après midi et les extérieurs en fin de journée.", name: "Dubaï", cur: "AED", curName: "dirhams émiratis (AED)", min: 0, max: 2100,
    transit: "en métro de Dubaï, le plan doit finir avant la fermeture du métro (vers minuit en semaine, plus tard le week end)",
    notes: "L'alcool n'est servi que dans des lieux licenciés, souvent dans les hôtels, et seulement à partir de 21 ans : prévois des étapes sans alcool accessibles à tous. Respecte les règles locales de tenue et de comportement." },
  "madrid": { tz: "Europe/Madrid", cultureNotes: "Plusieurs grands musées ont des créneaux gratuits en fin de journée et des tarifs étudiants.", name: "Madrid", cur: "€", curName: "euros", min: 0, max: 500,
    transit: "en métro, le plan doit finir avant la fermeture du métro (vers 1h30) ou proposer les bus de nuit (búhos)",
    notes: "À Madrid on sort tard : dîner vers 21h30 ou 22h, les bars se remplissent après minuit." },
  "new-york": { tz: "America/New_York", cultureNotes: "Certains musées ont des tarifs étudiants ou des créneaux gratuits. La High Line, Central Park et le ferry de Staten Island sont gratuits.", name: "New York", cur: "$", curName: "dollars américains", min: 0, max: 600,
    transit: "en métro (subway), qui roule toute la nuit : le plan peut finir tard, mais privilégie des stations proches et fréquentées pour le retour",
    notes: "L'âge légal pour l'alcool est 21 ans : privilégie des lieux accessibles dès 18 ans quand c'est possible. Reste dans un seul quartier ou deux quartiers voisins." },
  "los-angeles": { tz: "America/Los_Angeles", cultureNotes: "La ville est très étendue : reste dans un seul quartier ou deux quartiers voisins. Certains musées sont gratuits (The Broad, Getty Center).", name: "Los Angeles", cur: "$", curName: "dollars américains", min: 0, max: 600,
    transit: "en transports en commun (Metro Rail et bus), le plan doit finir avant le dernier train (vers minuit) ou proposer un bus de nuit",
    notes: "L'âge légal pour l'alcool est 21 ans : privilégie des lieux accessibles dès 18 ans. La ville est très étendue : reste dans un seul quartier ou deux quartiers voisins." },
  "casablanca": { tz: "Africa/Casablanca", cultureNotes: "La Mosquée Hassan II se visite seulement à certains horaires, avec visite guidée.", name: "Casablanca", cur: "MAD", curName: "dirhams marocains (MAD)", min: 0, max: 5400,
    transit: "en tramway, le plan doit finir avant le dernier tram (vers 22h30), sinon proposer le petit taxi comme seule alternative",
    notes: "L'alcool n'est servi que dans certains bars, restaurants et hôtels licenciés : prévois aussi des cafés, rooftops et lieux sans alcool. Le soir, le petit taxi est le moyen le plus courant." },
};
const clean = (s, n) => String(s ?? "").replace(/[\r\n"`]/g, " ").slice(0, n).trim();
const GKEY = process.env.GOOGLE_SERVER_KEY || process.env.GOOGLE_PLACES_KEY;
const isTime = v => /^\d{2}:\d{2}$/.test(v || "");

function today(c) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: c.tz }).format(new Date());
}

const avoidRule = avoid => avoid.length
  ? `- Lieux déjà proposés à ce groupe, à NE PAS reprendre : ${avoid.join(", ")}. Choisis d'autres lieux. Seulement s'il n'existe vraiment plus d'autre option adaptée près du point de départ, tu peux réutiliser certains de ces lieux, mais jamais la même combinaison ni dans le même ordre.\n`
  : "";
const style = lang => `- Écris toutes les valeurs texte du JSON en ${LANGS[lang]}, ton direct et complice, phrases courtes. Garde les noms propres des lieux tels quels. Les clés JSON restent identiques.
- ${lang === "en" ? "Dans les textes, écris les heures au format 12 h avec AM/PM (ex : 11:30 PM)." : "Dans les textes, écris les heures au format 24 h (ex : 23:30)."}`;
const accuracy = `- N'utilise QUE des lieux qui existent vraiment et qui sont ouverts aujourd'hui : jamais de lieu fermé définitivement ou temporairement, ni de lieu dont tu n'es pas sûr qu'il existe encore. Préfère les lieux établis depuis longtemps.
- Le champ "lieu" doit être le nom exact du lieu tel qu'il apparaît sur Google Maps.
- "billet" vaut true seulement pour les lieux avec un billet réservable en ligne (musée, monument, visite guidée, croisière, spectacle, attraction), false pour les bars, restaurants, clubs, parcs gratuits et rues.
- Chaque étape est UN lieu précis avec une adresse (un musée, un parc, un bar, une rue précise de street art), jamais une zone vague comme "quartier X et rues adjacentes".
- Choisis des étapes proches les unes des autres : le trajet entre deux étapes doit rester court et réaliste.`;
const timing = (start, end) => !isTime(start)
  ? `Horaires : pas d'heure imposée, choisis un enchaînement adapté au moment habituel de la sortie. Ne donne PAS d'horaires : mets "" dans le champ "heure" de chaque étape.`
  : isTime(end)
  ? `Horaires : rendez vous à ${start}, fin au plus tard à ${end}. Tout le plan, trajets compris, doit tenir dans ce créneau. Donne l'heure de début de chaque étape dans le champ "heure" (format HH:MM).`
  : `Horaires : rendez vous à ${start}, pas d'heure de fin. Ne donne PAS d'horaires : mets "" dans le champ "heure" de chaque étape, les étapes s'enchaînent simplement dans l'ordre.`;
const JSON_SHAPE = `Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, de cette forme :
{"titre":"nom accrocheur (5 mots max)","resume":"une phrase","compromis":"une ou deux phrases qui expliquent comment le plan respecte chaque personne, en citant les pseudos","etapes":[{"heure":"","type":"type d'étape","lieu":"nom exact du lieu","quartier":"quartier ou rue","pourquoi":"une phrase","prix_pp":10,"billet":false,"trajet":"comment venir de l'étape précédente","lat":48.8534,"lng":2.3711}],"total_pp":28,"retour":"comment rentrer","retour_station":"nom de l'arrêt ou de la station","retour_lat":48.8532,"retour_lng":2.3692}`;

// how many stops must have a bookable ticket: none for 1 stop, 1 for 2 to 4, 2 for 5.
// skipped when someone picked the smallest budget (a paid ticket would break it).
function ticketsNeeded(stops, friends) {
  if (friends.some(f => f.level === 0)) return 0;
  return stops <= 1 ? 0 : stops <= 4 ? 1 : 2;
}
const input0 = (stops, friends) => ticketsNeeded(stops, friends);
function ticketRule(n, mode) {
  if (!n) return "";
  const kinds = mode === "culture"
    ? "musée, monument, visite guidée, croisière, attraction, spectacle"
    : "concert, spectacle comique, croisière ou soirée en bateau, visite nocturne, bar crawl organisé, rooftop ou club avec entrée payante";
  return `- OBLIGATOIRE : au moins ${n} étape(s) doivent être des lieux avec un billet réservable en ligne ("billet": true), par exemple : ${kinds}. Choisis des lieux connus qu'on trouve sur GetYourGuide.`;
}

function groupText(friends, c, mode) {
  return friends.map(f => {
    const want = f.vibe ? `${mode === "culture" ? "aime" : "envie"} "${f.vibe}"` : "pas de préférence particulière";
    const extra = f.flag ? (mode === "culture" ? ", est étudiant (tarif étudiant)" : ", ne boit pas d'alcool") : "";
    const budget = f.plus ? `budget de ${f.budget} ${c.cur} ou plus` : `budget max ${f.budget} ${c.cur}`;
    return `- ${f.nick} : ${budget}, ${want}${extra}`;
  }).join("\n");
}

function buildPrompt({ c, mode, lang, avoid, stops, friends, area, start, end, metro }) {
  const minB = Math.min(...friends.map(f => f.budget));
  const intro = mode === "culture"
    ? `Tu es Tournée, une IA qui organise des sorties culturelles à ${c.name} pour des groupes d'étudiants de 18 à 25 ans.
Construis UN plan de journée (musées, expos, galeries, street art, architecture, parcs, jardins, marchés, points de vue) qui convient à tout le groupe ci dessous.`
    : `Tu es Tournée, une IA qui organise des soirées à ${c.name} pour des groupes d'étudiants de 18 à 25 ans.
Construis UN plan de soirée qui convient à tout le groupe ci dessous.`;
  const moves = mode === "culture"
    ? `Déplacements : ${metro ? "en transports en commun et à pied, pas de taxi" : "taxi ou VTC possible"}`
    : `Retour : ${metro ? c.transit : "taxi ou VTC possible"}`;
  const rules = mode === "culture"
    ? `- Exactement ${stops} étape(s)${stops > 1 ? ", proches les unes des autres" : ""}. Au moins ${Math.min(2, stops)} étape(s) doivent être de vrais lieux culturels ou de plein air : musée, expo, galerie, monument, parc, jardin, marché, point de vue, street art.
- Une seule pause café ou snack maximum, jamais de bar ni d'alcool. Exception : un café concept (café à chats, jeux de société, livres, mangas, thème original) demandé par le groupe compte comme une vraie activité, pas comme une pause.
- Le champ "type" décrit l'activité (ex : Musée, Parc, Galerie, Marché, Balade, Pause café).
- Utilise les gratuités et les tarifs étudiants pour les personnes qui sont étudiantes.
- Tiens compte du jour : évite les lieux habituellement fermés ce jour là.
- Contexte local : ${c.cultureNotes}`
    : `- Exactement ${stops} étape(s)${stops > 1 ? ", proches les unes des autres (à pied ou 1 ou 2 stations de métro)" : ""}.
${c.dry ? "- Aucun alcool dans cette ville : ne propose jamais de bar." : "- Si quelqu'un ne boit pas d'alcool, chaque bar doit avoir de vraies options sans alcool."}
- Contexte local : ${c.notes}`;
  return `LANGUE DE RÉPONSE OBLIGATOIRE : ${LANGS[lang].toUpperCase()}. Tous les textes du JSON (titre, resume, compromis, type, pourquoi, trajet, retour) doivent être écrits en ${LANGS[lang]}, même si ces consignes sont en français.

${intro}

Groupe :
${groupText(friends, c, mode)}

Date : ${today(c)}
Point de départ : ${area}, ${c.name}
${timing(start, end)}
${moves}

Règles :
- Le coût total par personne ne doit pas dépasser ${friends.every(f => f.plus) ? `environ ${minB} ${c.cur} (tout le monde a un gros budget, tu peux aller un peu au delà)` : `${minB} ${c.cur} (le plus petit budget du groupe)`}. Personne ne doit se sentir exclu.
${ticketRule(input0(stops, friends), mode)}
- Chaque envie exprimée dans le groupe doit être servie au moins une fois. Les personnes sans préférence suivent le groupe.
${friends.some(f => f.minor) ? "- IMPORTANT : au moins une personne du groupe a moins de 18 ans. Propose UNIQUEMENT des lieux ouverts à tous les âges et sans alcool : aucun bar, club, rooftop bar, pub, bar à cocktails, karaoké réservé aux adultes ni lieu interdit aux mineurs. Les envies liées à l'alcool deviennent des équivalents sans alcool (café, salon de thé, glacier, bowling, jeux, concert tout public)." : ""}
${rules}
- Prix réalistes en ${c.curName} : prix_pp et total_pp sont des nombres dans cette monnaie.
${accuracy}
- Donne pour chaque lieu ses coordonnées GPS (lat, lng, 4 décimales), et celles de l'arrêt de transport du retour (retour_station).
${avoidRule(avoid)}${style(lang)}

${JSON_SHAPE}`;
}

// rough language check on the plan's own sentences (place names are ignored on purpose)
const MARKERS = {
  fr: [" les ", " des ", " et ", " une ", " pour ", " avec ", " du ", " est ", " au ", " vous ", " ton "],
  es: [" los ", " las ", " y ", " una ", " para ", " con ", " del ", " es ", " al ", " tu ", " el "],
  en: [" the ", " and ", " a ", " for ", " with ", " of ", " is ", " to ", " your ", " you "],
};
function detectLang(plan) {
  const txt = " " + [plan.resume, plan.compromis, plan.retour, ...(plan.etapes || []).map(s => s.pourquoi)].filter(Boolean).join(" ").toLowerCase().replace(/[.,;:!?()"']/g, " ") + " ";
  if (txt.trim().length < 40) return null;
  const score = l => MARKERS[l].reduce((n, w) => n + (txt.split(w).length - 1), 0);
  const ranked = Object.keys(MARKERS).map(l => [l, score(l)]).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] >= 3 && ranked[0][1] >= ranked[1][1] * 1.5 ? ranked[0][0] : null;
}

async function claude(key, messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 3000, messages }),
  });
  if (r.status === 429) throw { code: "rate_limited" };
  if (!r.ok) { console.error("Anthropic error", r.status, await r.text()); throw { code: "upstream" }; }
  const data = await r.json();
  const text = (data.content || []).filter(x => x.type === "text").map(x => x.text).join("");
  return { text, plan: JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) };
}

/* ---------- Google checks ---------- */
const words = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
const nameMatch = (a, b) => { const B = new Set(words(b)); return words(a).some(w => B.has(w)); };
const validLL = (lat, lng) => typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);

async function findPlace(query, lang, bias) {
  try {
    const body = { textQuery: query, maxResultCount: 1, languageCode: lang };
    if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 5000 } };
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.businessStatus" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.error("Places error", r.status, await r.text()); return { error: true }; }
    const d = await r.json();
    return { place: (d.places || [])[0] || null };
  } catch (e) { console.error(e); return { error: true }; }
}

// returns the list of stop indexes that must be replaced (closed or not found)
async function verifyStops(plan, c, lang) {
  const bad = [];
  await Promise.all((plan.etapes || []).map(async (s, i) => {
    const bias = validLL(+s.lat, +s.lng) ? { lat: +s.lat, lng: +s.lng } : null;
    const { place, error } = await findPlace(`${s.lieu}, ${s.quartier || ""}, ${c.name}`, lang, bias);
    if (error) return;                       // Google unavailable: keep the stop as is
    if (!place) { bad.push(i); s._why = "introuvable sur Google Maps"; return; }
    const status = place.businessStatus;
    if (status === "CLOSED_PERMANENTLY" || status === "CLOSED_TEMPORARILY") {
      bad.push(i); s._why = status === "CLOSED_PERMANENTLY" ? "fermé définitivement" : "fermé temporairement"; return;
    }
    if (!nameMatch(s.lieu, place.displayName?.text)) return; // Google found something else: keep the AI version
    s.lieu = place.displayName.text;
    s.adresse = place.formattedAddress || "";
    s.lat = place.location.latitude; s.lng = place.location.longitude;
    s._ok = true;
  }));
  return bad.sort((a, b) => a - b);
}

async function route(from, to, mode) {
  try {
    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GKEY, "X-Goog-FieldMask": "routes.duration,routes.distanceMeters" },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: mode,
      }),
    });
    if (!r.ok) { console.error("Routes error", r.status, await r.text()); return null; }
    const d = await r.json();
    const sec = parseInt(String(d.routes?.[0]?.duration || "").replace("s", ""), 10);
    return Number.isFinite(sec) ? Math.max(1, Math.round(sec / 60)) : null;
  } catch (e) { console.error(e); return null; }
}

async function travel(from, to, metro) {
  const walk = await route(from, to, "WALK");
  if (walk !== null && walk <= 20) return { min: walk, mode: "walk" };
  const alt = metro ? await route(from, to, "TRANSIT") : await route(from, to, "DRIVE");
  if (alt !== null) return { min: alt, mode: metro ? "transit" : "drive" };
  return walk !== null ? { min: walk, mode: "walk" } : null;
}

async function addTravelTimes(plan, c, lang, area, metro) {
  const stops = plan.etapes || [];
  const startPlace = await findPlace(`${area}, ${c.name}`, lang, null);
  const origin = startPlace.place?.location ? { lat: startPlace.place.location.latitude, lng: startPlace.place.location.longitude } : null;
  const legs = stops.map((s, i) => {
    const from = i === 0 ? origin : (validLL(+stops[i - 1].lat, +stops[i - 1].lng) ? { lat: +stops[i - 1].lat, lng: +stops[i - 1].lng } : null);
    const to = validLL(+s.lat, +s.lng) ? { lat: +s.lat, lng: +s.lng } : null;
    return from && to ? travel(from, to, metro) : Promise.resolve(null);
  });
  const last = stops[stops.length - 1];
  const home = last && validLL(+last.lat, +last.lng) && validLL(+plan.retour_lat, +plan.retour_lng)
    ? travel({ lat: +last.lat, lng: +last.lng }, { lat: +plan.retour_lat, lng: +plan.retour_lng }, metro) : Promise.resolve(null);
  const res = await Promise.all([...legs, home]);
  stops.forEach((s, i) => { if (res[i]) { s.trajet_min = res[i].min; s.trajet_mode = res[i].mode; } });
  if (res[stops.length]) { plan.retour_min = res[stops.length].min; plan.retour_mode = res[stops.length].mode; }
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "no_key" });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const c = CITIES[body.city] || CITIES.paris;
  const mode = body.mode === "culture" ? "culture" : "night";
  const lang = LANGS[body.lang] ? body.lang : "fr";
  const friends = (Array.isArray(body.friends) ? body.friends : []).slice(0, 8).map(f => {
    const b = Number(f?.budget);
    return {
      nick: clean(f?.nick, 20) || "Quelqu'un",
      budget: Number.isFinite(b) ? Math.min(c.max, Math.max(0, Math.round(b))) : 0,
      plus: f?.plus === true,
      minor: f?.minor === true,
      level: Number.isInteger(f?.level) ? f.level : null,
      vibe: VIBES[mode][f?.vibe] || null,
      flag: !!(f?.flag ?? f?.sober),
    };
  });
  if (friends.length < 1) return res.status(400).json({ error: "group" });

  const input = {
    c, mode, lang,
    avoid: (Array.isArray(body.avoid) ? body.avoid : []).slice(0, 40).map(x => clean(x, 60)).filter(Boolean),
    stops: Math.min(5, Math.max(1, parseInt(body.stops, 10) || 3)),
    friends,
    area: clean(body.area, 40) || c.name,
    start: isTime(body.start) ? body.start : "",
    end: isTime(body.end) ? body.end : "",
    metro: body.metro === true,
  };

  try {
    const prompt = buildPrompt(input);
    let { text, plan } = await claude(key, [{ role: "user", content: prompt }]);
    // safety net: the plan came back in the wrong language, ask once more
    if (detectLang(plan) && detectLang(plan) !== lang) {
      try {
        const again = await claude(key, [
          { role: "user", content: prompt },
          { role: "assistant", content: text },
          { role: "user", content: `Les textes sont dans la mauvaise langue. Réécris exactement le même plan, avec les mêmes lieux, mais avec TOUS les textes en ${LANGS[lang]}. Réponds avec le JSON complet, sans texte autour.` },
        ]);
        if (Array.isArray(again.plan.etapes) && again.plan.etapes.length) { text = again.text; plan = again.plan; }
      } catch (e) { console.error("language retry failed", e); }
    }
    const excluded = [];

    const need = ticketsNeeded(input.stops, friends);
    const tickets = p => (p.etapes || []).filter(s => s.billet === true).length;
    if (Array.isArray(plan.etapes)) {
      let bad = GKEY ? await verifyStops(plan, c, lang) : [];
      const missingTickets = Math.max(0, need - tickets(plan));
      if (bad.length || missingTickets) {
        bad.forEach(i => excluded.push(plan.etapes[i].lieu));
        const list = bad.map(i => `étape ${i + 1} "${plan.etapes[i].lieu}" (${plan.etapes[i]._why})`).join(", ");
        const asks = [];
        if (bad.length) asks.push(`Vérification Google Maps : ${list}. Remplace UNIQUEMENT ces étapes par d'autres lieux réels, ouverts aujourd'hui, du même type et proches des autres étapes. N'utilise aucun de ces lieux : ${excluded.join(", ")}.`);
        if (missingTickets) asks.push(`Il manque ${missingTickets} étape(s) avec un billet réservable en ligne ("billet": true). Remplace une ou plusieurs étapes sans billet par des lieux connus avec billet (${mode === "culture" ? "musée, monument, visite, croisière" : "concert, spectacle, croisière de nuit, entrée payante"}), en respectant le budget.`);
        try {
          const fix = await claude(key, [
            { role: "user", content: prompt },
            { role: "assistant", content: text },
            { role: "user", content: `${asks.join(" ")} Garde toutes les autres étapes identiques et respecte les mêmes règles. Réponds avec le JSON complet, sans texte autour.` },
          ]);
          if (Array.isArray(fix.plan.etapes) && fix.plan.etapes.length) {
            plan = fix.plan;
            bad = GKEY ? await verifyStops(plan, c, lang) : [];
            // still closed after the retry: drop those stops rather than send people to a closed place
            const closed = bad.filter(i => /fermé/.test(plan.etapes[i]._why || ""));
            if (closed.length && closed.length < plan.etapes.length) {
              closed.forEach(i => excluded.push(plan.etapes[i].lieu));
              plan.etapes = plan.etapes.filter((_, i) => !closed.includes(i));
            }
          }
        } catch (e) { console.error("retry failed", e); }
      }
      if (GKEY) await addTravelTimes(plan, c, lang, input.area, input.metro);
    }

    (plan.etapes || []).forEach(s => { delete s._why; delete s._ok; s.billet = s.billet === true; if (!input.end) s.heure = ""; });
    plan.excluded = excluded;
    return res.status(200).json({ plan });
  } catch (e) {
    if (e && e.code) return res.status(e.code === "rate_limited" ? 429 : 502).json({ error: e.code });
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
