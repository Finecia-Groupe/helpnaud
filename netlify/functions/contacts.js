/* HelpNaud.ai — « Mes contacts » : (1) quels contacts utilisent déjà HelpNaud, (2) présence « actif ».
   Confidentialité : le navigateur n'envoie que des empreintes SHA-256 d'adresses (jamais les adresses) ; le serveur répond seulement
   pour les empreintes qui correspondent à un compte, sans nom ni adresse. Rien n'est conservé, sauf la dernière activité de l'utilisateur
   (table hn_presence, désactivable par lui). Nécessite SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY) dans Netlify + supabase-contacts.sql. */
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const hits = new Map();
function limited(key, max, win){ const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < win); a.push(now); hits.set(key, a); return a.length > max; }
function reply(status, obj){ return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) }; }
async function authUser(token){
  if (!token || token.length > 4000) return null;
  const res = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!res.ok) return null; const u = await res.json().catch(() => null);
  return u && /^[0-9a-f-]{36}$/i.test(u.id || '') ? { id: u.id } : null;
}
exports.handler = async function(event){
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, message: 'Méthode non permise.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { ok: false, message: 'Requête invalide.' }); }
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = /^Bearer\s+(.+)$/i.exec(auth) ? RegExp.$1.trim() : '';
  let user = null; try { user = await authUser(token); } catch (e) { return reply(502, { ok: false, message: 'Vérification de la session impossible.' }); }
  if (!user) return reply(401, { ok: false, code: 'login', message: 'Connectez-vous à votre compte HelpNaud.' });
  if (!SB_SECRET) return reply(503, { ok: false, code: 'unconfigured', message: 'Statut des contacts non configuré sur le serveur (clé Supabase manquante).' });
  const H = { apikey: SB_SECRET, Authorization: 'Bearer ' + SB_SECRET, 'Content-Type': 'application/json' };
  const action = String(b.action || '');
  if (action === 'ping') {
    if (limited('p:' + user.id, 40, 3600000)) return reply(429, { ok: false, code: 'rate' });
    const r = await fetch(SB_URL + '/rest/v1/hn_presence?on_conflict=user_id', { method: 'POST', headers: Object.assign({ Prefer: 'resolution=merge-duplicates,return=minimal' }, H), body: JSON.stringify({ user_id: user.id, seen: new Date().toISOString(), visible: b.visible !== false }) });
    return r.ok ? reply(200, { ok: true }) : reply(502, { ok: false, message: 'Présence non enregistrée.' });
  }
  if (action === 'lookup') {
    if (limited('l:' + user.id, 30, 3600000)) return reply(429, { ok: false, code: 'rate', message: 'Trop de vérifications. Réessayez plus tard.' });
    const hs = (Array.isArray(b.hashes) ? b.hashes : []).filter(h => /^[0-9a-f]{64}$/.test(h)).slice(0, 100);
    if (!hs.length) return reply(200, { ok: true, found: {} });
    const r = await fetch(SB_URL + '/rest/v1/rpc/hn_contacts_lookup', { method: 'POST', headers: H, body: JSON.stringify({ p_hashes: hs }) });
    if (!r.ok) return reply(502, { ok: false, message: 'Vérification impossible (supabase-contacts.sql exécuté ?).' });
    const rows = await r.json().catch(() => []), now = Date.now(), found = {};
    (Array.isArray(rows) ? rows : []).forEach(x => { if (x && x.h) found[x.h] = { active: !!(x.seen && now - Date.parse(x.seen) < 180000) }; });
    return reply(200, { ok: true, found });
  }
  return reply(400, { ok: false, message: 'Action inconnue.' });
};
