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
 "istanbul":{fr:"Istanbul",en:"Istanbul",es:"Estambul"},
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
  fr: { night: "une soirée", day: "une journée", invite: "{n} vous invite à {m} à {c}", added: "{n} vous a ajouté à {m} à {c}", friend: "{n} vous a ajouté en ami sur Tournée", friendBody: "Vous pouvez maintenant vous inviter à vos sorties en un clic.", friendCta: "Voir mes amis", freq: "{n} veut vous ajouter en ami sur Tournée", freqBody: "Acceptez ou refusez la demande depuis vos notifications.", freqCta: "Voir la demande", body: "Ajoutez votre budget et vos envies, Tournée s'occupe du plan.", cta: "Voir la sortie", foot: "Vous recevez cet e-mail parce que vous avez un compte Tournée." },
  en: { night: "a night out", day: "a day out", invite: "{n} invited you to {m} in {c}", added: "{n} added you to {m} in {c}", friend: "{n} added you as a friend on Tournée", friendBody: "You can now invite each other to parties in one click.", friendCta: "See my friends", freq: "{n} wants to be your friend on Tournée", freqBody: "Accept or decline the request from your notifications.", freqCta: "See the request", body: "Add your budget and what you're into, Tournée takes care of the plan.", cta: "See the party", foot: "You're getting this email because you have a Tournée account." },
  es: { night: "una noche", day: "un día", invite: "{n} te invita a {m} en {c}", added: "{n} te ha añadido a {m} en {c}", friend: "{n} te ha añadido como amigo en Tournée", friendBody: "Ahora podéis invitaros a vuestros planes con un clic.", friendCta: "Ver mis amigos", freq: "{n} quiere ser tu amigo en Tournée", freqBody: "Acepta o rechaza la solicitud desde tus notificaciones.", freqCta: "Ver la solicitud", body: "Añade tu presupuesto y lo que te apetece, Tournée se encarga del plan.", cta: "Ver el plan", foot: "Recibes este correo porque tienes una cuenta en Tournée." },
};
const HI = { fr: n => `Bonjour ${n},`, en: n => `Hi ${n},`, es: n => `Hola ${n},` };
const SIGN = { fr: "À bientôt sur Tournée", en: "See you on Tournée", es: "Nos vemos en Tournée" };
// a header-safe display name ("Nassim via Tournée") and a reply address that works
const nameSafe = s => String(s || "").replace(/["<>\r\n,;]/g, "").trim().slice(0, 30);
const REPLY = () => process.env.CONTACT_EMAIL || "tournee.help@gmail.com";
const greet = (L, n) => n ? `<tr><td style="padding:28px 32px 0;font-size:15px;line-height:1.5;color:#DBC9FF">${esc(HI[L](n))}</td></tr>` : "";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fill = (s, v) => s.replace(/\{(\w)\}/g, (_, k) => v[k] ?? "");

// kind: "invite", "added" (party) or "friend" (new friend); to: email; lang: fr/en/es
async function sendPartyMail({ to, toName, sender, lang, kind, from, city, mode, outing }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  const L = T[lang] ? lang : "fr", t = T[L];
  const cityName = CITY_T[city]?.[L] || CITY_T[city]?.en || city;
  const isFriend = kind === "friend" || kind === "freq", isReq = kind === "freq";
  const subject = fill(isReq ? t.freq : isFriend ? t.friend : kind === "added" ? t.added : t.invite, { n: from || "Tournée", m: mode === "day" ? t.day : t.night, c: cityName });
  // friend request: home page with the bell open; new friend: the Friends page; parties: the party itself
  const link = isReq ? "https://tournee.site/?notifs=1" : isFriend ? "https://tournee.site/friends" : `https://tournee.site/o/${encodeURIComponent(outing)}`;
  const bodyText = isReq ? t.freqBody : isFriend ? t.friendBody : t.body, ctaText = isReq ? t.freqCta : isFriend ? t.friendCta : t.cta;
  const html = `<!doctype html><html lang="${L}"><body style="margin:0;background:#DBC9FF;font-family:Inter,Arial,sans-serif;color:#271A47">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#DBC9FF;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#271A47;border-radius:24px;color:#DBC9FF">
<tr><td style="padding:36px 32px 0;font-size:12px;font-weight:600;letter-spacing:.111em;text-transform:uppercase;color:#BC994E">Tournée</td></tr>
${greet(L, nameSafe(toName))}
<tr><td style="padding:12px 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.1">${esc(subject)}</td></tr>
<tr><td style="padding:16px 32px 0;font-size:15px;line-height:1.5;color:#B7A6DE">${esc(bodyText)}</td></tr>
<tr><td style="padding:28px 32px 36px"><a href="${link}" style="display:inline-block;border:1px solid #DBC9FF;border-radius:30px;padding:12px 22px;color:#DBC9FF;text-decoration:none;font-size:12px;font-weight:600;letter-spacing:.111em;text-transform:uppercase">${esc(ctaText)}</a></td></tr>
</table>
<p style="max-width:480px;margin:18px auto 0;font-size:11px;line-height:1.5;color:#4A3B70">${esc(t.foot)}</p>
</td></tr></table></body></html>`;
  const hi = nameSafe(toName) ? HI[L](nameSafe(toName)) + "\n\n" : "";
  const text = `${hi}${subject}.\n\n${bodyText}\n\n${ctaText} : ${link}\n\n${SIGN[L]}\n\n${t.foot}`;
  const fromName = nameSafe(sender) ? `${nameSafe(sender)} via Tournée` : "Tournée";
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${fromName} <${process.env.MAIL_ADDR || "invitations@tournee.site"}>`, to: [to], subject, html, text, reply_to: REPLY() }),
    });
    clearTimeout(timer);
    if (!r.ok) console.error("resend", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) { console.error("resend failed", e); return false; }
}

// password reset: a one time link (or, for Google accounts, a reminder to use Google)
const R = {
  fr: { subject: "Réinitialiser votre mot de passe Tournée", title: "Nouveau mot de passe", body: "Cliquez sur le bouton pour choisir un nouveau mot de passe. Le lien est valable 30 minutes et ne marche qu'une fois. Si vous n'avez rien demandé, ignorez cet e-mail.", cta: "Choisir un mot de passe", gSubject: "Votre compte Tournée", gBody: "Votre compte Tournée utilise Google : il n'a pas de mot de passe. Connectez-vous avec le bouton « Se connecter avec Google ».", gCta: "Aller sur Tournée" },
  en: { subject: "Reset your Tournée password", title: "New password", body: "Click the button to choose a new password. The link works for 30 minutes and only once. If you didn't ask for this, ignore this email.", cta: "Choose a password", gSubject: "Your Tournée account", gBody: "Your Tournée account uses Google, so it has no password. Sign in with the \"Sign in with Google\" button.", gCta: "Go to Tournée" },
  es: { subject: "Restablecer tu contraseña de Tournée", title: "Nueva contraseña", body: "Haz clic en el botón para elegir una nueva contraseña. El enlace vale 30 minutos y solo una vez. Si no lo has pedido, ignora este correo.", cta: "Elegir contraseña", gSubject: "Tu cuenta de Tournée", gBody: "Tu cuenta de Tournée usa Google, así que no tiene contraseña. Inicia sesión con el botón \"Iniciar sesión con Google\".", gCta: "Ir a Tournée" },
};
async function sendResetMail({ to, toName, lang, token, google }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  const L = R[lang] ? lang : "fr", t = R[L];
  const subject = google ? t.gSubject : t.subject, title = google ? t.gSubject : t.title, body = google ? t.gBody : t.body, cta = google ? t.gCta : t.cta;
  const link = google ? "https://tournee.site/account" : `https://tournee.site/reset/${encodeURIComponent(token)}`;
  const html = `<!doctype html><html lang="${L}"><body style="margin:0;background:#DBC9FF;font-family:Inter,Arial,sans-serif;color:#271A47">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#DBC9FF;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#271A47;border-radius:24px;color:#DBC9FF">
<tr><td style="padding:36px 32px 0;font-size:12px;font-weight:600;letter-spacing:.111em;text-transform:uppercase;color:#BC994E">Tournée</td></tr>
${greet(L, nameSafe(toName))}
<tr><td style="padding:12px 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.1">${esc(title)}</td></tr>
<tr><td style="padding:16px 32px 0;font-size:15px;line-height:1.5;color:#B7A6DE">${esc(body)}</td></tr>
<tr><td style="padding:28px 32px 36px"><a href="${link}" style="display:inline-block;border:1px solid #DBC9FF;border-radius:30px;padding:12px 22px;color:#DBC9FF;text-decoration:none;font-size:12px;font-weight:600;letter-spacing:.111em;text-transform:uppercase">${esc(cta)}</a></td></tr>
</table></td></tr></table></body></html>`;
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM_ACCOUNT || "Tournée <compte@tournee.site>", to: [to], subject, html, reply_to: REPLY(), text: `${nameSafe(toName) ? HI[L](nameSafe(toName)) + "\n\n" : ""}${title}\n\n${body}\n\n${cta} : ${link}\n\n${SIGN[L]}` }),
    });
    clearTimeout(timer);
    if (!r.ok) console.error("resend", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) { console.error("resend failed", e); return false; }
}

module.exports = { sendPartyMail, sendResetMail };
