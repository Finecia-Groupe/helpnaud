/* HelpNaud.ai — rappels de tâches par courriel : synchronisation (Netlify Function, HTTP POST).
 * Le navigateur envoie le jeton de session Supabase et la liste des tâches ayant « courriel » activé. Le serveur vérifie le
 * jeton (l'adresse courriel vient de Supabase Auth, jamais du navigateur) puis remplace les rappels NON envoyés de cet
 * utilisateur dans la table hn_task_reminders (voir supabase-rappels-taches.sql). L'envoi lui-même est fait par la fonction
 * planifiée « task-reminders-cron ». Aucune dépendance npm. */
'use strict';
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ALLOWED = [0, 30, 60, 120, 1440, 2880, 4320, 10080, 20160];
const reply = (code, o) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(o) });
const hits = new Map();
function limited(k){ const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < 60000); a.push(n); hits.set(k, a); return a.length > 12; }

async function userFromToken(token){
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id && u.email ? { id: u.id, email: u.email } : null;
}
async function rest(method, path, body, extra){
  const r = await fetch(SB_URL + '/rest/v1/' + path, { method, headers: Object.assign({ apikey: SB_SECRET, Authorization: 'Bearer ' + SB_SECRET, 'Content-Type': 'application/json' }, extra || {}), body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = new Error('rest ' + r.status); e.detail = await r.text().catch(() => ''); throw e; }
  return r.status === 204 ? null : r.json().catch(() => null);
}

exports.handler = async function(event){
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });
  if (!SB_SECRET) return reply(503, { error: 'not_configured', message: 'Rappels par courriel non configurés sur le serveur.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad_request' }); }
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = /^Bearer\s+(.+)$/i.exec(auth) ? RegExp.$1.trim() : '';
  if (!token) return reply(401, { error: 'auth', message: 'Connectez-vous pour recevoir les rappels par courriel.' });
  let user; try { user = await userFromToken(token); } catch (e) { return reply(502, { error: 'auth_unavailable' }); }
  if (!user) return reply(401, { error: 'auth', message: 'Session expirée : reconnectez-vous.' });
  if (limited(user.id)) return reply(429, { error: 'rate' });

  const tz = typeof body.tz === 'string' && /^[A-Za-z_\/+\-0-9]{1,60}$/.test(body.tz) ? body.tz : 'UTC';
  const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 200) : [];
  const now = Date.now(), rows = [];
  for (const t of tasks) {
    if (!t || t.fait || !t.email || !t.id || !t.due || !Array.isArray(t.rappels)) continue;
    const due = Date.parse(t.due); if (isNaN(due) || due < now - 3600000) continue;
    for (const m of t.rappels.slice(0, 10)) {
      if (ALLOWED.indexOf(m) < 0) continue;
      const at = due - m * 60000;
      if (at < now - 3600000) continue;           // trop ancien : jamais envoyé
      rows.push({ rkey: user.id + '|' + String(t.id).slice(0, 60) + '|' + m + '|' + new Date(due).toISOString(), user_id: user.id, email: user.email,
        task_id: String(t.id).slice(0, 60), title: String(t.titre || 'Tâche').slice(0, 200), has_time: !!t.heure, due_utc: new Date(due).toISOString(),
        remind_at: new Date(at).toISOString(), minutes: m, tz });
    }
  }
  try {
    await rest('DELETE', 'hn_task_reminders?user_id=eq.' + encodeURIComponent(user.id) + '&sent_at=is.null', null, { Prefer: 'return=minimal' });
    if (rows.length) await rest('POST', 'hn_task_reminders?on_conflict=rkey', rows, { Prefer: 'resolution=ignore-duplicates,return=minimal' });
  } catch (e) { console.error('[task-reminders] ' + (e && e.message) + ' ' + ((e && e.detail) || '')); return reply(502, { error: 'store', message: 'Enregistrement des rappels impossible (SQL exécuté ?).' }); }
  return reply(200, { ok: true, scheduled: rows.length, email: user.email });
};
