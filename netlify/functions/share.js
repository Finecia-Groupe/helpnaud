/* HelpNaud.ai — liens publics de conversation (Netlify Function)
 *   POST (Authorization: Bearer <jeton Supabase>)  { action:'create', title, messages:[{role,content}] } → { id }
 *   POST (idem)                                    { action:'revoke', id }                              → { ok:true }
 *   GET  ?id=<id>  (public, sans connexion)                                                             → { title, messages, created }
 * Seul le TEXTE de la conversation est partagé (jamais les fichiers joints). Le lien se désactive à tout moment.
 * Table : shared_chats (voir supabase-share.sql). Aucune dépendance npm. */
'use strict';
const crypto = require('crypto');
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAX_MSGS = 200, MAX_CHARS = 250000, MAX_PER_HOUR = 20;
function reply(status, obj, extra){ return { statusCode: status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, extra || {}), body: JSON.stringify(obj) }; }
function svcHeaders(extra){ const h = Object.assign({ 'Content-Type': 'application/json', apikey: SB_SECRET }, extra || {}); if (!SB_SECRET.startsWith('sb_secret_')) h.Authorization = 'Bearer ' + SB_SECRET; return h; }
async function rest(path, opts){ const res = await fetch(SB_URL + '/rest/v1/' + path, Object.assign({ headers: svcHeaders() }, opts || {})); const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; } if (!res.ok) { const err = new Error('rest ' + res.status); err.status = res.status; throw err; } return d; }
async function userIdFromToken(token){
  if (!token || token.length > 4000) return null;
  const res = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!res.ok) return null; const u = await res.json().catch(() => null);
  return u && /^[0-9a-f-]{36}$/i.test(u.id || '') ? u.id : null;
}
const hits = new Map();
function limited(key, max, ms){ const now = Date.now(); const a = (hits.get(key) || []).filter(t => now - t < ms); a.push(now); hits.set(key, a); return a.length > max; }

exports.handler = async function(event){
  if (!SB_SECRET) return reply(503, { error: 'not_configured', message: 'Le partage n’est pas encore configuré sur le serveur.' });
  const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
  if (event.httpMethod === 'GET') {
    const id = String((event.queryStringParameters && event.queryStringParameters.id) || '');
    if (!ID_RE.test(id)) return reply(404, { error: 'not_found', message: 'Lien introuvable.' });
    if (limited('g:' + (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for']) || 'ip'), 60, 60 * 1000)) return reply(429, { error: 'rate', message: 'Trop de demandes.' });
    try {
      const rows = await rest('shared_chats?id=eq.' + encodeURIComponent(id) + '&revoked=eq.false&select=title,messages,created_at&limit=1');
      if (!rows || !rows.length) return reply(404, { error: 'not_found', message: 'Ce lien n’existe pas ou a été désactivé.' });
      return reply(200, { title: rows[0].title, messages: rows[0].messages, created: rows[0].created_at });
    } catch (e) { return reply(502, { error: 'unavailable', message: 'Service momentanément indisponible.' }); }
  }
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method', message: 'Méthode non permise.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad_request', message: 'Requête invalide.' }); }
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = /^Bearer\s+(.+)$/i.exec(auth) ? RegExp.$1.trim() : '';
  let uid = null; try { uid = await userIdFromToken(token); } catch (e) { return reply(502, { error: 'auth_unavailable', message: 'Vérification de la session impossible.' }); }
  if (!uid) return reply(401, { error: 'auth', message: 'Connectez-vous pour créer un lien public.' });
  if (limited('u:' + uid, MAX_PER_HOUR, 3600 * 1000)) return reply(429, { error: 'rate', message: 'Trop de liens créés : réessayez plus tard.' });
  try {
    if (body.action === 'create') {
      const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-MAX_MSGS).map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 60000) })).filter(m => m.content.trim());
      if (!msgs.length) return reply(400, { error: 'empty', message: 'Rien à partager : la conversation est vide.' });
      if (msgs.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) return reply(413, { error: 'too_long', message: 'Conversation trop longue pour un lien public.' });
      const id = crypto.randomBytes(18).toString('base64url');
      await rest('shared_chats', { method: 'POST', headers: svcHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ id, owner: uid, title: String(body.title || 'Conversation').slice(0, 120), messages: msgs }) });
      return reply(200, { id });
    }
    if (body.action === 'revoke') {
      const id = String(body.id || ''); if (!ID_RE.test(id)) return reply(400, { error: 'bad_request', message: 'Lien invalide.' });
      await rest('shared_chats?id=eq.' + encodeURIComponent(id) + '&owner=eq.' + uid, { method: 'PATCH', headers: svcHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ revoked: true }) });
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'bad_request', message: 'Action inconnue.' });
  } catch (e) { return reply(502, { error: 'unavailable', message: 'Le partage est momentanément indisponible (la table shared_chats est-elle créée ?).' }); }
};
