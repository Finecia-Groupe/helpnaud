/* HelpNaud.ai — rappels de rendez-vous 24 h avant (fonction planifiée Netlify, toutes les heures).
 * Lit la table fgh_rdv_reminders (voir supabase-rdv-reminders.sql), envoie au client un courriel de rappel avec le fichier
 * d'agenda (.ics) puis marque le rappel comme envoyé. Chaque rappel est « réclamé » avant l'envoi : aucun doublon, même si la
 * fonction se déclenche deux fois. Sans clé Resend (RESEND_API_KEY_FINECIA), rien n'est envoyé et rien n'est marqué.
 * Planification : voir netlify.toml ([functions."rdv-reminders"] schedule). */
'use strict';
const R = require('./public-intake.js')._rdv;

exports.handler = async function(){
  const out = (o) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(o) });
  if (!R.RESEND_KEY || !R.FROM_ADDR) { console.error('[rdv-reminders] clé Resend absente (RESEND_API_KEY_FINECIA) : aucun rappel envoyé'); return out({ ok: false, reason: 'not_configured', sent: 0 }); }
  const nowIso = new Date().toISOString();
  let due;
  try {
    due = await R.sbRest('GET', 'fgh_rdv_reminders?select=slot_id,name,email,motif,slot_date,slot_start,slot_end&sent_at=is.null&canceled=is.false&remind_at=lte.' + encodeURIComponent(nowIso) + '&start_utc=gt.' + encodeURIComponent(nowIso) + '&order=remind_at.asc&limit=50');
  } catch (e) { console.error('[rdv-reminders] lecture impossible : ' + (e && e.message) + ' ' + ((e && e.detail) || '')); return out({ ok: false, reason: 'read_error', sent: 0 }); }
  let sent = 0, failed = 0;
  for (const r of (Array.isArray(due) ? due : [])) {
    try {
      // Réclamation : seul l'appel qui voit encore « sent_at null » obtient la ligne en retour.
      const claimed = await R.sbRest('PATCH', 'fgh_rdv_reminders?slot_id=eq.' + encodeURIComponent(r.slot_id) + '&sent_at=is.null&canceled=is.false', { sent_at: new Date().toISOString() }, { Prefer: 'return=representation' });
      if (!Array.isArray(claimed) || !claimed.length) continue;
      const info = { id: r.slot_id, date: r.slot_date, start: r.slot_start, end: r.slot_end };
      const payload = { from: R.FROM_ADDR, reply_to: R.REPLY_DEFAULT, to: [r.email], subject: 'Rappel : votre rendez-vous demain — FINECIA GROUPE',
        text: 'Bonjour ' + r.name + ',\n\nCeci est un rappel de votre rendez-vous : ' + R.whenText(info) + (r.motif ? ' (' + String(r.motif).slice(0, 200) + ')' : '') + '.\n\nPour le déplacer ou l’annuler, répondez simplement à ce courriel.\n\nCordialement,\nFINECIA GROUPE' };
      const ics = R.makeIcs(info, r.name, r.motif);
      if (ics) payload.attachments = [{ filename: 'rendez-vous.ics', content: Buffer.from(ics, 'utf-8').toString('base64') }];
      let res = await R.resendTry(payload);
      if (res !== 'ok' && ics) { delete payload.attachments; res = await R.resendTry(payload); }
      if (res === 'ok') { sent++; }
      else { failed++; await R.sbRest('PATCH', 'fgh_rdv_reminders?slot_id=eq.' + encodeURIComponent(r.slot_id), { sent_at: null, error: res }, { Prefer: 'return=minimal' }).catch(() => {}); }
    } catch (e) { failed++; console.error('[rdv-reminders] échec pour un rappel : ' + (e && e.message)); }
  }
  console.log('[rdv-reminders] envoyés=' + sent + ' échecs=' + failed);
  return out({ ok: true, sent, failed });
};
