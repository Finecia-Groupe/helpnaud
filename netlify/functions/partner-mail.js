/* HelpNaud.ai — envoi des courriels partenaires en attente (Netlify Function)
 * Appelée par l'application avec la connexion de l'équipe (Authorization: Bearer …). Les droits sont vérifiés
 * par la base (fgh_outbox_take). Variables Netlify : RESEND_API_KEY et MAIL_FROM (adresse d'expédition vérifiée).
 * Sans ces variables, rien n'est envoyé et les messages restent « en attente » (visibles dans PartnerDoss). */
'use strict';
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const reply = (st, o) => ({ statusCode: st, headers: H, body: JSON.stringify(o) });
async function rpc(fn, args, token){
  const headers = { 'Content-Type': 'application/json' };
  if (token) { headers.apikey = SB_PUB; headers.Authorization = 'Bearer ' + token; }
  else { headers.apikey = SB_SECRET; if (!SB_SECRET.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + SB_SECRET; }
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify(args || {}) });
  const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  if (!res.ok) { const e = new Error('rpc'); e.status = res.status; throw e; }
  return d;
}
exports.handler = async function(event){
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Méthode non permise.' });
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return reply(401, { error: 'Connexion requise.' });
  if (!SB_SECRET) return reply(503, { error: 'Le serveur n’est pas configuré.' });
  try {
    const items = await rpc('fgh_outbox_take', { p_limit: 10 }, token);
    if (!Array.isArray(items) || !items.length) return reply(200, { ok: true, sent: 0, queued: 0 });
    if (!RESEND_KEY || !MAIL_FROM) {   // pas de service d'envoi : on remet en file
      for (const m of items) await rpc('svc_outbox_requeue', { p_id: m.id }).catch(() => {});
      return reply(200, { ok: true, sent: 0, queued: items.length, configured: false });
    }
    let sent = 0;
    for (const m of items) {
      let ok = false, err = null;
      try {
        const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY },
          body: JSON.stringify({ from: MAIL_FROM, to: [m.to_email], subject: m.subject, text: m.body }) });
        ok = r.ok; if (!ok) err = 'HTTP ' + r.status;
      } catch (e) { err = 'exception'; }
      await rpc('svc_outbox_mark', { p_id: m.id, p_ok: ok, p_error: err }).catch(() => {});
      if (ok) sent++;
    }
    return reply(200, { ok: true, sent, queued: 0, configured: true });
  } catch (e) {
    return reply(e && e.status === 401 ? 401 : 403, { error: 'Accès refusé.' });
  }
};
