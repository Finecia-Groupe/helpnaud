/* HelpNaud.ai — ECOREP : espace de consultation des relevés de paie (Netlify Function)
 *
 * Connexion : courriel OU numéro de membre (8 chiffres) + mot de passe. Le serveur retrouve le courriel, vérifie le mot de
 * passe auprès de Supabase Auth, puis renvoie le jeton de session. Chaque action suivante porte ce jeton ; l'identité vient
 * du jeton vérifié (jamais du navigateur) : un employé ne peut lire QUE ses propres données.
 * Clé secrète : variable Netlify SUPABASE_SECRET_KEY (jamais dans GitHub). Aucune dépendance npm.
 */
'use strict';
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';

function reply(status, obj){
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}
function str(v, max){ return (typeof v === 'string' ? v : '').trim().slice(0, max); }
function isEmail(v){ return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(v) && v.length <= 254; }
function okId(v){ return /^[A-Za-z0-9_-]{1,80}$/.test(v); }

const hits = new Map();
function limited(key, max, windowMs){
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) { for (const k of hits.keys()) { if (!(hits.get(k) || []).some(t => now - t < windowMs)) hits.delete(k); } }
  return arr.length > max;
}
function svcHeaders(){
  const h = { 'Content-Type': 'application/json', apikey: SB_SECRET };
  if (!SB_SECRET.startsWith('sb_secret_')) h.Authorization = 'Bearer ' + SB_SECRET;
  return h;
}
async function svcRpc(fn, args){
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: svcHeaders(), body: JSON.stringify(args || {}) });
  const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) { const err = new Error('rpc ' + fn); err.status = res.status; throw err; }
  return data;
}
async function sendQueued(mailId){
  if (!mailId || !/^fghml-[a-f0-9]{14}$/.test(mailId) || !RESEND_KEY || !MAIL_FROM) return;
  try {
    const m = await svcRpc('svc_outbox_get', { p_id: mailId });
    if (!m || !m.to_email) return;
    const res = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY },
      body: JSON.stringify({ from: MAIL_FROM, to: [m.to_email], subject: m.subject, text: m.body }) });
    await svcRpc('svc_outbox_mark', { p_id: mailId, p_ok: res.ok, p_error: res.ok ? null : ('HTTP ' + res.status) });
  } catch (e) { try { await svcRpc('svc_outbox_mark', { p_id: mailId, p_ok: false, p_error: 'exception' }); } catch (x) {} }
}
async function userIdFromToken(token){
  if (!token || token.length > 4000) return null;
  const res = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return u && /^[0-9a-f-]{36}$/i.test(u.id || '') ? u.id : null;
}

exports.handler = async function(event){
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Méthode non permise.' });
  if (!SB_SECRET) return reply(503, { error: 'Le serveur n’est pas configuré.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Requête invalide.' }); }
  if (!body || typeof body !== 'object') return reply(400, { error: 'Requête invalide.' });
  const ip = ((event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'ip').split(',')[0].trim();
  const action = str(body.action, 30);
  try {
    if (action === 'login') {
      if (limited('l:' + ip, 10, 10 * 60 * 1000)) return reply(429, { error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
      const ident = str(body.id, 254), pw = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
      const bad = () => reply(401, { error: 'Identifiants incorrects.' });
      if (!ident || !pw) return bad();
      if (limited('li:' + ident.toLowerCase(), 8, 15 * 60 * 1000)) return reply(429, { error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
      let email = ident;
      if (/^[0-9]{8}$/.test(ident)) email = (await svcRpc('svc_ecorep_email_by_number', { p_number: ident })) || '';
      if (!isEmail(email)) return bad();
      const res = await fetch(SB_URL + '/auth/v1/token?grant_type=password', { method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SB_PUB }, body: JSON.stringify({ email, password: pw }) });
      if (!res.ok) return bad();
      const s = await res.json().catch(() => null);
      if (!s || !s.access_token || !s.user) return bad();
      const me = await svcRpc('svc_ecorep_me', { p_uid: s.user.id });
      if (!me || !me.ok) return bad();
      return reply(200, { ok: true, token: s.access_token, expiresIn: s.expires_in || 3600, me });
    }

    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const uid = await userIdFromToken(auth.replace(/^Bearer\s+/i, ''));
    if (!uid) return reply(401, { error: 'Session expirée. Reconnectez-vous.' });
    if (limited('a:' + uid, 120, 10 * 60 * 1000)) return reply(429, { error: 'Trop de requêtes.' });

    let r;
    switch (action) {
      case 'me': r = await svcRpc('svc_ecorep_me', { p_uid: uid }); break;
      case 'payslips': r = await svcRpc('svc_ecorep_payslips', { p_uid: uid }); break;
      case 'payslip': {
        const id = str(body.id, 80); if (!okId(id)) return reply(400, { error: 'Requête invalide.' });
        r = await svcRpc('svc_ecorep_payslip_get', { p_uid: uid, p_id: id }); break;
      }
      case 'ot-list': r = await svcRpc('svc_ecorep_ot_list', { p_uid: uid }); break;
      case 'ot-submit': case 'ot-resubmit': {
        const p = { date: str(body.date, 10), start: str(body.start, 5), end: str(body.end, 5), reason: str(body.reason, 300) };
        if (action === 'ot-submit') r = await svcRpc('svc_ecorep_ot_submit', { p_uid: uid, p });
        else { const id = str(body.id, 80); if (!okId(id)) return reply(400, { error: 'Requête invalide.' }); r = await svcRpc('svc_ecorep_ot_resubmit', { p_uid: uid, p_id: id, p }); }
        break;
      }
      case 'ot-cancel': {
        const id = str(body.id, 80); if (!okId(id)) return reply(400, { error: 'Requête invalide.' });
        r = await svcRpc('svc_ecorep_ot_cancel', { p_uid: uid, p_id: id }); break;
      }
      case 'mgr-list': r = await svcRpc('svc_ecorep_mgr_list', { p_uid: uid }); break;
      case 'mgr-decide': {
        const id = str(body.id, 80); if (!okId(id)) return reply(400, { error: 'Requête invalide.' });
        r = await svcRpc('svc_ecorep_mgr_decide', { p_uid: uid, p_id: id, p_decision: str(body.decision, 12), p_comment: str(body.comment, 300) }); break;
      }
      default: return reply(400, { error: 'Action inconnue.' });
    }
    if (r && r.mailId) { await sendQueued(r.mailId); delete r.mailId; }
    return reply(200, r || { ok: false });
  } catch (e) {
    return reply(502, { error: 'Service momentanément indisponible.' });
  }
};
