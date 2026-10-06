/* HelpNaud.ai — fonction serveur « équipe FGH-Colab » (Netlify Function)
 *
 * Rôle : les opérations qui exigent la clé SECRÈTE Supabase (créer / réinitialiser / supprimer un
 * compte de connexion, reprendre les membres existants). Cette clé n'existe QUE dans les variables
 * d'environnement Netlify (SUPABASE_SECRET_KEY) — jamais dans index.html ni dans GitHub.
 *
 * Sécurité : chaque appel doit porter le jeton de connexion de l'utilisateur (Authorization: Bearer …).
 * Le rôle de l'appelant (propriétaire / administrateur) est confirmé par la BASE DE DONNÉES avec ce
 * jeton, jamais par ce que le navigateur prétend. Aucune dépendance npm : fetch + crypto uniquement.
 */
'use strict';
const crypto = require('crypto');

const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
// Clé « publishable » : publique par conception (déjà dans index.html).
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const PW_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function provisionalPassword(){
  let out = '';
  for (let i = 0; i < 10; i++) out += PW_ALPHABET.charAt(crypto.randomInt(PW_ALPHABET.length));
  return out;
}

function reply(status, obj){
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj)
  };
}
class Fail extends Error { constructor(status, message){ super(message); this.status = status; } }

/* ---------- appels Supabase ---------- */
function serviceHeaders(){
  // Les nouvelles clés « sb_secret_… » ne sont PAS des JWT : on les envoie uniquement dans « apikey ».
  // Une ancienne clé service_role (JWT « eyJ… ») s'envoie aussi en Authorization.
  const h = { 'Content-Type': 'application/json', apikey: SB_SECRET };
  if (!SB_SECRET.startsWith('sb_secret_')) h.Authorization = 'Bearer ' + SB_SECRET;
  return h;
}
async function readJson(res){
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return text; }
}
async function userRpc(token, fn, args){
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SB_PUB, Authorization: 'Bearer ' + token },
    body: JSON.stringify(args || {})
  });
  const data = await readJson(res);
  if (!res.ok) throw new Fail(res.status === 401 ? 401 : 403, 'Accès refusé.');
  return data;
}
async function svcRpc(fn, args){
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: serviceHeaders(), body: JSON.stringify(args || {})
  });
  const data = await readJson(res);
  if (!res.ok) {
    const msg = data && data.message ? String(data.message) : 'Erreur serveur.';
    const err = new Fail(res.status >= 500 ? 502 : 400, msg);
    err.code = data && data.code;
    throw err;
  }
  return data;
}
async function authAdmin(method, path, body){
  const res = await fetch(SB_URL + '/auth/v1/admin/' + path, {
    method, headers: serviceHeaders(), body: body ? JSON.stringify(body) : undefined
  });
  const data = await readJson(res);
  return { ok: res.ok, status: res.status, data };
}

/* ---------- identification de l'appelant ---------- */
async function identify(event){
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(raw);
  if (!m) throw new Fail(401, 'Connexion requise.');
  const token = m[1];
  const res = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Fail(401, 'Session expirée. Reconnectez-vous.');
  const user = await readJson(res);
  if (!user || !user.id) throw new Fail(401, 'Session invalide.');
  const role = await userRpc(token, 'current_team_role', {});
  const memberId = await userRpc(token, 'current_team_member_id', {});
  return { token, userId: user.id, role: typeof role === 'string' ? role : null, memberId: memberId || null };
}

/* ---------- validations ---------- */
function str(v, max){ return (typeof v === 'string' ? v : '').trim().slice(0, max); }
function isEmail(v){ return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(v) && v.length <= 254; }
function cleanTools(v){
  if (!Array.isArray(v)) return [];
  return v.filter(t => typeof t === 'string' && t.length > 0 && t.length <= 60).slice(0, 80);
}
function isUuid(v){ return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }

async function createAuthUser(email, password, name){
  const r = await authAdmin('POST', 'users', { email, password, email_confirm: true, user_metadata: { name } });
  if (r.ok && r.data && r.data.id) return { id: r.data.id };
  const code = r.data && (r.data.error_code || r.data.code || '');
  const msg = (r.data && (r.data.msg || r.data.message || r.data.error_description)) || '';
  if (r.status === 422 && (/exists|registered/i.test(code + ' ' + msg))) return { error: 'exists' };
  if (r.status === 422 && /weak|password/i.test(code + ' ' + msg)) return { error: 'weak' };
  return { error: 'other', status: r.status };
}

/* ---------- actions ---------- */
async function createMember(ctx, p){
  const asOwner = ctx.role === 'owner';
  const asAdmin = ctx.role === 'admin';
  if (!asOwner && !asAdmin) throw new Fail(403, 'Réservé au propriétaire ou à un administrateur.');
  if (asAdmin) {
    // Administrateur : session ADMINISTRATEUR ouverte (4 facteurs) + code admin confirmé par la base.
    const open = await userRpc(ctx.token, 'has_open_admin_session', {});
    if (open !== true) throw new Fail(403, 'Connexion ADMINISTRATEUR requise.');
    const okCode = await userRpc(ctx.token, 'verify_admin_code', { p_code: str(p.admin_code, 20) });
    if (okCode !== true) throw new Fail(403, 'Code administrateur incorrect.');
  }
  const name = str(p.name, 120);
  const email = str(p.email, 254).toLowerCase();
  if (!name || !isEmail(email)) throw new Fail(400, 'Nom et courriel valides requis.');
  const password = provisionalPassword();
  const created = await createAuthUser(email, password, name);
  if (created.error === 'exists') throw new Fail(409, 'Un compte existe déjà pour ce courriel.');
  if (created.error) throw new Fail(502, 'Création du compte impossible pour le moment.');
  try {
    const row = await svcRpc('svc_create_member', {
      p_auth_user_id: created.id, p_name: name, p_email: email,
      p_job_title: str(p.job_title, 120), p_tools: cleanTools(p.tools),
      p_activated_by_name: str(p.activated_by_name, 120) || null,
      p_activated_by_number: str(p.activated_by_number, 20) || null,
      p_granted_by: (asAdmin || cleanTools(p.tools).length) ? ctx.memberId : null
    });
    return { id: row.id, member_number: row.member_number, provisional_password: password };
  } catch (e) {
    await authAdmin('DELETE', 'users/' + created.id);   // on n'abandonne pas un compte sans fiche
    if (e.code === '23505') throw new Fail(409, 'Un membre existe déjà avec ce courriel.');
    throw e;
  }
}

async function targetOf(p){
  if (!isUuid(p.member_id)) throw new Fail(400, 'Membre invalide.');
  const info = await svcRpc('svc_member_info', { p_member_id: p.member_id });
  if (!info || !info.auth_user_id) throw new Fail(404, 'Membre introuvable.');
  if (info.role === 'owner') throw new Fail(403, 'Le compte propriétaire ne peut pas être modifié ici.');
  return info;
}
async function resetMemberPassword(ctx, p){
  if (ctx.role !== 'owner') throw new Fail(403, 'Réservé au propriétaire.');
  const info = await targetOf(p);
  const password = provisionalPassword();
  const r = await authAdmin('PUT', 'users/' + info.auth_user_id, { password });
  if (!r.ok) throw new Fail(502, 'Réinitialisation impossible pour le moment.');
  await svcRpc('svc_mark_provisional', { p_member_id: p.member_id });
  return { provisional_password: password };
}
async function removeMember(ctx, p){
  if (ctx.role !== 'owner') throw new Fail(403, 'Réservé au propriétaire.');
  const info = await targetOf(p);
  const r = await authAdmin('DELETE', 'users/' + info.auth_user_id);
  if (!r.ok && r.status !== 404) throw new Fail(502, 'Suppression impossible pour le moment.');
  return { removed: true };   // la fiche team_members disparaît avec le compte (ON DELETE CASCADE)
}

/* Reprise des membres existants (par lots de 8 maximum : limite de durée d'une fonction). */
async function importMembers(ctx, p){
  if (ctx.role !== 'owner') throw new Fail(403, 'Réservé au propriétaire.');
  const list = Array.isArray(p.members) ? p.members.slice(0, 8) : [];
  const results = [];
  for (const m of list) {
    const localId = str(m && m.local_id, 80);
    try {
      const email = str(m.email, 254).toLowerCase();
      const name = str(m.name, 120);
      if (!name || !isEmail(email)) { results.push({ local_id: localId, ok: false, error: 'Nom ou courriel invalide.' }); continue; }
      let password = typeof m.password === 'string' && m.password.length >= 6 ? m.password.slice(0, 72) : '';
      let regenerated = false;
      if (!password) { password = provisionalPassword(); regenerated = true; }
      let created = await createAuthUser(email, password, name);
      if (created.error === 'weak' && !regenerated) {
        password = provisionalPassword(); regenerated = true;
        created = await createAuthUser(email, password, name);
      }
      if (created.error === 'exists') { results.push({ local_id: localId, ok: false, error: 'Un compte existe déjà pour ce courriel.' }); continue; }
      if (created.error) { results.push({ local_id: localId, ok: false, error: 'Création du compte impossible.' }); continue; }
      let row;
      try {
        row = await svcRpc('svc_import_member', { p_auth_user_id: created.id, p: {
          name, email,
          member_number: str(m.member_number, 8),
          is_admin: m.is_admin === true,
          admin_code: str(m.admin_code, 20),
          admin_password: typeof m.admin_password === 'string' ? m.admin_password.slice(0, 72) : '',
          admin_role: str(m.admin_role, 120),
          can_view_access_list: m.can_view_access_list === true,
          authorized_tools: cleanTools(m.authorized_tools),
          job_title: str(m.job_title, 120),
          docs_verified_date: str(m.docs_verified_date, 10),
          admin_designated_on: str(m.admin_designated_on, 40),
          admin_removed_on: str(m.admin_removed_on, 40),
          activated_by_name: str(m.activated_by_name, 120),
          activated_by_number: str(m.activated_by_number, 20),
          activated_on: str(m.activated_on, 40),
          connections: Array.isArray(m.connections) ? m.connections.slice(-500) : [],
          admin_connections: Array.isArray(m.admin_connections) ? m.admin_connections.slice(-500) : []
        }});
      } catch (e) {
        await authAdmin('DELETE', 'users/' + created.id);
        results.push({ local_id: localId, ok: false, error: 'Fiche non importée (' + (e.code === '23505' ? 'doublon' : 'données invalides') + ').' });
        continue;
      }
      results.push({ local_id: localId, ok: true, member_id: row.id, member_number: row.member_number,
                     password_regenerated: regenerated, new_password: regenerated ? password : undefined });
    } catch (e) {
      results.push({ local_id: localId, ok: false, error: 'Erreur inattendue.' });
    }
  }
  return { results };
}
async function importGrants(ctx, p){
  if (ctx.role !== 'owner') throw new Fail(403, 'Réservé au propriétaire.');
  const list = Array.isArray(p.grants) ? p.grants.slice(0, 500) : [];
  let n = 0;
  for (const g of list) {
    if (!g || !isUuid(g.granted_by) || !isUuid(g.member_id)) continue;
    try { await svcRpc('svc_import_grant', { p_granted_by: g.granted_by, p_member_id: g.member_id, p_granted_on: str(g.granted_on, 40) || null }); n++; }
    catch (e) { /* un octroi invalide n'arrête pas les autres */ }
  }
  return { imported: n };
}

const ACTIONS = {
  'create-member': createMember,
  'reset-member-password': resetMemberPassword,
  'remove-member': removeMember,
  'import-members': importMembers,
  'import-grants': importGrants
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return reply(405, { error: 'Méthode non autorisée.' });
    if (!SB_SECRET) return reply(503, { error: 'Le serveur n\'est pas encore configuré (clé secrète absente de Netlify).', code: 'not_configured' });
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Requête illisible.' }); }
    const fn = ACTIONS[body && body.action];
    if (!fn) return reply(400, { error: 'Action inconnue.' });
    const ctx = await identify(event);
    const out = await fn(ctx, body);
    return reply(200, out);
  } catch (e) {
    if (e instanceof Fail) return reply(e.status, { error: e.message });
    return reply(500, { error: 'Erreur inattendue du serveur.' });
  }
};
