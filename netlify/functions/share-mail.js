/* HelpNaud.ai — envoi d'UNE réponse par courriel, ou invitation à essayer HelpNaud (serveur).
   Courriels : Resend (RESEND_API_KEY_FINECIA ou RESEND_API_KEY ; expéditeur MAIL_FROM_FINECIA ou MAIL_FROM), comme family.js.
   Sécurité : compte HelpNaud connecté obligatoire ; 1 destinataire par envoi ; limites par compte ; texte seul (jamais de HTML venant de
   l'utilisateur) ; l'invitation utilise un modèle fixe ; l'adresse de l'expéditeur est en Reply-To. Rien n'est conservé sur le serveur. */
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SITE = (process.env.SITE_URL || 'https://helpnaud.ai').replace(/\/+$/, '');
const MAIL_KEY = process.env.RESEND_API_KEY_FINECIA || process.env.RESEND_API_KEY || '';
const MAIL_FROM = (function(){ const v = String(process.env.MAIL_FROM_FINECIA || process.env.MAIL_FROM || '').trim(); if (!v) return ''; return v.indexOf('<') !== -1 ? v : 'HelpNaud <' + v + '>'; })();
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[A-Za-z]{2,}$/;
const hits = new Map();
function limited(key, max, win){ const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < win); a.push(now); hits.set(key, a); return a.length > max; }
function reply(status, obj){ return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) }; }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function authUser(token){
  if (!token || token.length > 4000) return null;
  const res = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!res.ok) return null; const u = await res.json().catch(() => null);
  return u && /^[0-9a-f-]{36}$/i.test(u.id || '') && u.email ? { id: u.id, email: String(u.email).toLowerCase() } : null;
}
function clean(s, n){ return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, n); }
async function send(to, subject, text, html, replyTo){
  const body = { from: MAIL_FROM, to: [to], subject, text, html }; if (replyTo) body.reply_to = replyTo;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + MAIL_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { let m = ''; try { m = (await r.text()).slice(0, 300).split(MAIL_KEY).join('[clé masquée]'); } catch (e) {} console.error('HelpNaud share-mail — Resend', r.status, m); }
  return r.ok;
}
exports.handler = async function(event){
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, message: 'Méthode non permise.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { ok: false, message: 'Requête invalide.' }); }
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = /^Bearer\s+(.+)$/i.exec(auth) ? RegExp.$1.trim() : '';
  let user = null; try { user = await authUser(token); } catch (e) { return reply(502, { ok: false, code: 'auth_unavailable', message: 'Vérification de la session impossible.' }); }
  if (!user) return reply(401, { ok: false, code: 'login', message: 'Connectez-vous à votre compte HelpNaud pour envoyer un courriel.' });
  if (!MAIL_KEY || !MAIL_FROM) return reply(503, { ok: false, code: 'mail_unconfigured', message: 'L’envoi de courriels n’est pas configuré sur le serveur.' });
  const action = String(b.action || '');
  const to = clean(b.to, 254).toLowerCase() || user.email;
  if (!EMAIL_RE.test(to)) return reply(400, { ok: false, code: 'bad_email', message: 'Adresse courriel invalide.' });
  const name = clean(b.name, 40);
  const who = name ? name + ' (' + user.email + ')' : user.email;

  if (action === 'send_response') {
    if (limited('r:' + user.id, 10, 3600000)) return reply(429, { ok: false, code: 'rate', message: 'Trop d’envois. Réessayez dans une heure.' });
    const text = String(b.text == null ? '' : b.text).replace(/\u0000/g, '').slice(0, 20000);
    if (!text.trim()) return reply(400, { ok: false, message: 'Rien à envoyer.' });
    const self = to === user.email;
    const head = self ? 'Voici la réponse HelpNaud que vous avez choisi de vous envoyer.' : who + ' vous partage une réponse de HelpNaud.';
    const foot = 'Envoyé depuis HelpNaud (' + SITE + '). Cette réponse est générée par une IA et peut contenir des erreurs : vérifiez les informations importantes.' + (self ? '' : ' Vous recevez ce message parce que l’expéditeur a saisi votre adresse ; si cela ne vous concerne pas, ignorez-le.');
    const plain = head + '\n\n' + text + '\n\n—\n' + foot;
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:680px"><p style="color:#555">' + esc(head) + '</p><div style="white-space:pre-wrap;font-family:Consolas,Menlo,monospace,Arial;font-size:14px;line-height:1.5;border:1px solid #e3e6ea;border-radius:10px;padding:14px;background:#fafbfc">' + esc(text) + '</div><p style="color:#777;font-size:12px;margin-top:16px">' + esc(foot) + '</p></div>';
    const ok = await send(to, self ? 'Votre réponse HelpNaud' : 'Une réponse HelpNaud partagée avec vous', plain, html, self ? undefined : user.email);
    return ok ? reply(200, { ok: true }) : reply(502, { ok: false, code: 'send_failed', message: 'Le courriel n’a pas pu être envoyé. Réessayez plus tard.' });
  }
  if (action === 'invite') {
    if (to === user.email) return reply(400, { ok: false, code: 'self', message: 'Saisissez l’adresse de la personne à inviter.' });
    if (limited('i:' + user.id, 5, 86400000)) return reply(429, { ok: false, code: 'rate', message: 'Limite de 5 invitations par jour atteinte.' });
    const note = clean(b.note, 200);
    const plain = who + ' vous invite à essayer HelpNaud, un assistant IA du quotidien.\n' + (note ? '\nMessage : « ' + note + ' »\n' : '') + '\nDécouvrir HelpNaud : ' + SITE + '\n\n—\nVous recevez ce courriel parce que ' + user.email + ' a saisi votre adresse. Si cela ne vous concerne pas, ignorez-le : aucun compte n’est créé et rien d’autre ne sera envoyé.';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:560px"><h2 style="margin:0 0 10px">Essayez HelpNaud</h2><p>' + esc(who) + ' vous invite à essayer HelpNaud, un assistant IA du quotidien.</p>' + (note ? '<p style="border-left:3px solid #1f4e8c;padding-left:10px;color:#333">« ' + esc(note) + ' »</p>' : '') + '<p><a href="' + esc(SITE) + '" style="display:inline-block;background:#1f4e8c;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Découvrir HelpNaud</a></p><p style="color:#777;font-size:12px">Vous recevez ce courriel parce que ' + esc(user.email) + ' a saisi votre adresse. Si cela ne vous concerne pas, ignorez-le : aucun compte n’est créé et rien d’autre ne sera envoyé.</p></div>';
    const ok = await send(to, 'Une invitation à essayer HelpNaud', plain, html, user.email);
    return ok ? reply(200, { ok: true }) : reply(502, { ok: false, code: 'send_failed', message: 'Le courriel n’a pas pu être envoyé. Réessayez plus tard.' });
  }
  return reply(400, { ok: false, message: 'Action inconnue.' });
};
