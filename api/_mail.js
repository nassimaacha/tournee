// Emails sent by Tournée (through Resend). Files starting with "_" in /api are helpers, not routes.
// Env: RESEND_API_KEY. Optional: MAIL_FROM (default "Tournée <invitations@tournee.site>"), CONTACT_EMAIL (reply to).
// Only used for party invites; a failed email never blocks the action that triggered it.

const CITY_T = {
 london:{fr:"Londres",en:"London",es:"Londres"},
 dubai:{fr:"Dubaï",en:"Dubai",es:"Dubái"},
 paris:{fr:"Paris",en:"Paris",es:"París"},
 madrid:{fr:"Madrid",en:"Madrid",es:"Madrid"},
 "new-york":{fr:"New York",en:"New York",es:"Nueva York"},
 "los-angeles":{fr:"Los Angeles",en:"Los Angeles",es:"Los Ángeles"},
 casablanca:{fr:"Casablanca",en:"Casablanca",es:"Casablanca"},
 "barcelona":{fr:"Barcelone",en:"Barcelona",es:"Barcelona"},
 "berlin":{fr:"Berlin",en:"Berlin",es:"Berlín"},
 "amsterdam":{fr:"Amsterdam",en:"Amsterdam",es:"Ámsterdam"},
 "lisbon":{fr:"Lisbonne",en:"Lisbon",es:"Lisboa"},
 "rome":{fr:"Rome",en:"Rome",es:"Roma"},
 "miami":{fr:"Miami",en:"Miami",es:"Miami"},
 "houston":{fr:"Houston",en:"Houston",es:"Houston"},
 "mexico-city":{fr:"Mexico",en:"Mexico City",es:"Ciudad de México"},
 "montreal":{fr:"Montréal",en:"Montreal",es:"Montreal"},
 "riyadh":{fr:"Riyad",en:"Riyadh",es:"Riad"},
 "khobar":{fr:"Khobar",en:"Khobar",es:"Khobar"},
 "prague":{fr:"Prague",en:"Prague",es:"Praga"},
 "tokyo":{fr:"Tokyo",en:"Tokyo",es:"Tokio"},
 "seoul":{fr:"Séoul",en:"Seoul",es:"Seúl"},
 "bangkok":{fr:"Bangkok",en:"Bangkok",es:"Bangkok"},
 "singapore":{fr:"Singapour",en:"Singapore",es:"Singapur"},
 "marrakech":{fr:"Marrakech",en:"Marrakesh",es:"Marrakech"},
 "cape-town":{fr:"Le Cap",en:"Cape Town",es:"Ciudad del Cabo"},
 "buenos-aires":{fr:"Buenos Aires",en:"Buenos Aires",es:"Buenos Aires"},
 "rio":{fr:"Rio de Janeiro",en:"Rio de Janeiro",es:"Río de Janeiro"},
 "sao-paulo":{fr:"São Paulo",en:"São Paulo",es:"São Paulo"},
 "sydney":{fr:"Sydney",en:"Sydney",es:"Sídney"},
 "melbourne":{fr:"Melbourne",en:"Melbourne",es:"Melbourne"},
 "toronto":{fr:"Toronto",en:"Toronto",es:"Toronto"},
 "sharm-el-sheikh":{fr:"Charm el-Cheikh",en:"Sharm El Sheikh",es:"Sharm el-Sheij"},
 "vienna":{fr:"Vienne",en:"Vienna",es:"Viena"}
};

const T = {
  fr: { night: "une soirée", day: "une journée", invite: "{n} vous invite à {m} à {c}", added: "{n} vous a ajouté à {m} à {c}", body: "Ajoutez votre budget et vos envies, Tournée s'occupe du plan.", cta: "Voir la sortie", foot: "Vous recevez cet e-mail parce que vous avez un compte Tournée. Pour ne plus les recevoir, décochez l'option dans votre compte." },
  en: { night: "a night out", day: "a day out", invite: "{n} invited you to {m} in {c}", added: "{n} added you to {m} in {c}", body: "Add your budget and what you're into, Tournée takes care of the plan.", cta: "See the party", foot: "You're getting this email because you have a Tournée account. To stop these emails, untick the option in your account." },
  es: { night: "una noche", day: "un día", invite: "{n} te invita a {m} en {c}", added: "{n} te ha añadido a {m} en {c}", body: "Añade tu presupuesto y lo que te apetece, Tournée se encarga del plan.", cta: "Ver el plan", foot: "Recibes este correo porque tienes una cuenta en Tournée. Para no recibir más, desmarca la opción en tu cuenta." },
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fill = (s, v) => s.replace(/\{(\w)\}/g, (_, k) => v[k] ?? "");

// kind: "invite" or "added"; to: email; lang: fr/en/es
async function sendPartyMail({ to, lang, kind, from, city, mode, outing }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  const L = T[lang] ? lang : "fr", t = T[L];
  const cityName = CITY_T[city]?.[L] || CITY_T[city]?.en || city;
  const subject = fill(kind === "added" ? t.added : t.invite, { n: from || "Tournée", m: mode === "day" ? t.day : t.night, c: cityName });
  const link = `https://tournee.site/o/${encodeURIComponent(outing)}`;
  const html = `<!doctype html><html lang="${L}"><body style="margin:0;background:#DBC9FF;font-family:Inter,Arial,sans-serif;color:#271A47">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#DBC9FF;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#271A47;border-radius:24px;color:#DBC9FF">
<tr><td style="padding:36px 32px 8px;font-size:12px;font-weight:600;letter-spacing:.111em;text-transform:uppercase;color:#BC994E">Tournée</td></tr>
<tr><td style="padding:8px 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.1">${esc(subject)}</td></tr>
<tr><td style="padding:16px 32px 0;font-size:15px;line-height:1.5;color:#B7A6DE">${esc(t.body)}</td></tr>
<tr><td style="padding:28px 32px 36px"><a href="${link}" style="display:inline-block;border:1px solid #DBC9FF;border-radius:30px;padding:12px 22px;color:#DBC9FF;text-decoration:none;font-size:12px;font-weight:600;letter-spacing:.111em;text-transform:uppercase">${esc(t.cta)}</a></td></tr>
</table>
<p style="max-width:480px;margin:18px auto 0;font-size:11px;line-height:1.5;color:#4A3B70">${esc(t.foot)}</p>
</td></tr></table></body></html>`;
  const text = `${subject}\n\n${t.body}\n\n${t.cta}: ${link}\n\n${t.foot}`;
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM || "Tournée <invitations@tournee.site>", to: [to], subject, html, text, ...(process.env.CONTACT_EMAIL ? { reply_to: process.env.CONTACT_EMAIL } : {}) }),
    });
    clearTimeout(timer);
    if (!r.ok) console.error("resend", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) { console.error("resend failed", e); return false; }
}

module.exports = { sendPartyMail };
