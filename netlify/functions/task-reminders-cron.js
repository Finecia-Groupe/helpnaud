/* HelpNaud.ai — envoi des rappels de tâches par courriel (fonction planifiée Netlify, toutes les 10 minutes).
 * Lit hn_task_reminders (voir supabase-rappels-taches.sql), « réclame » chaque rappel avant l'envoi (aucun doublon même si la
 * fonction se déclenche deux fois), envoie un courriel via Resend puis le marque envoyé. Sans clé Resend, rien n'est envoyé.
 * Planification : netlify.toml ([functions."task-reminders-cron"] schedule). */
'use strict';
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || process.env.RESEND_API_KEY_FINECIA || '';
const FROM = process.env.MAIL_FROM_FINECIA || process.env.MAIL_FROM || '';
async function rest(method, path, body, extra){
  const r = await fetch(SB_URL + '/rest/v1/' + path, { method, headers: Object.assign({ apikey: SB_SECRET, Authorization: 'Bearer ' + SB_SECRET, 'Content-Type': 'application/json' }, extra || {}), body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = new Error('rest ' + r.status); e.detail = await r.text().catch(() => ''); throw e; }
  return r.status === 204 ? null : r.json().catch(() => null);
}
const LAB = { 0: 'C’est maintenant', 30: 'Dans 30 minutes', 60: 'Dans 1 heure', 120: 'Dans 2 heures', 1440: 'Demain', 2880: 'Dans 2 jours', 4320: 'Dans 3 jours', 10080: 'Dans 1 semaine', 20160: 'Dans 2 semaines' };
function whenText(r){
  try {
    const o = { timeZone: r.tz || 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    if (r.has_time) { o.hour = '2-digit'; o.minute = '2-digit'; }
    return new Date(r.due_utc).toLocaleString('fr-CA', o);
  } catch (e) { return new Date(r.due_utc).toISOString(); }
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

exports.handler = async function(){
  const out = (o) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
  if (!SB_SECRET || !RESEND_KEY || !FROM) { console.error('[task-reminders-cron] configuration absente (clé Supabase / Resend / MAIL_FROM)'); return out({ ok: false, sent: 0 }); }
  const now = new Date(), min = new Date(now.getTime() - 3600000).toISOString();
  let due;
  try { due = await rest('GET', 'hn_task_reminders?select=*&sent_at=is.null&remind_at=lte.' + encodeURIComponent(now.toISOString()) + '&due_utc=gt.' + encodeURIComponent(min) + '&order=remind_at.asc&limit=100'); }
  catch (e) { console.error('[task-reminders-cron] lecture impossible : ' + (e && e.message)); return out({ ok: false, sent: 0 }); }
  let sent = 0, failed = 0;
  for (const r of (Array.isArray(due) ? due : [])) {
    try {
      const claimed = await rest('PATCH', 'hn_task_reminders?rkey=eq.' + encodeURIComponent(r.rkey) + '&sent_at=is.null', { sent_at: new Date().toISOString() }, { Prefer: 'return=representation' });
      if (!Array.isArray(claimed) || !claimed.length) continue;
      const lead = LAB[r.minutes] || 'Rappel';
      const text = 'Bonjour,\n\n' + lead + ' : « ' + r.title + ' »\nPrévu : ' + whenText(r) + '.\n\nCe rappel a été programmé dans HelpNaud (Planifier une tâche). Gérez vos tâches sur https://helpnaud.ai\n\nHelpNaud.ai — propulsé par FINECIA GROUPE';
      const html = '<p>Bonjour,</p><p><b>' + esc(lead) + '</b> : « ' + esc(r.title) + ' »<br>Prévu : ' + esc(whenText(r)) + '.</p><p style="color:#667">Ce rappel a été programmé dans HelpNaud (Planifier une tâche). <a href="https://helpnaud.ai">Ouvrir HelpNaud</a></p><p style="color:#889;font-size:12px">HelpNaud.ai — propulsé par FINECIA GROUPE</p>';
      const resp = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [r.email], subject: '🔔 Rappel HelpNaud : ' + r.title.slice(0, 120), text, html }) });
      if (resp.ok) sent++;
      else { failed++; const d = await resp.text().catch(() => ''); await rest('PATCH', 'hn_task_reminders?rkey=eq.' + encodeURIComponent(r.rkey), { sent_at: null, error: ('resend ' + resp.status + ' ' + d).slice(0, 300) }, { Prefer: 'return=minimal' }).catch(() => {}); }
    } catch (e) { failed++; console.error('[task-reminders-cron] échec : ' + (e && e.message)); }
  }
  console.log('[task-reminders-cron] envoyés=' + sent + ' échecs=' + failed);
  return out({ ok: true, sent, failed });
};
