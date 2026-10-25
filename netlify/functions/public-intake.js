/* HelpNaud.ai — fonction serveur « pages publiques » (Netlify Function)
 *
 * Reçoit les actions de la page publique (public.html) : inscription par lien d'invitation, prise de
 * rendez-vous, catalogue de véhicules et « client intéressé ». Toute la logique et les contrôles sont
 * dans des fonctions SQL réservées au serveur (voir supabase-phase3.sql) ; ici : validation des
 * entrées, limitation de débit et appel avec la clé SECRÈTE (variable Netlify SUPABASE_SECRET_KEY,
 * jamais dans index.html). Aucune dépendance npm.
 */
'use strict';

const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function reply(status, obj){
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}
function str(v, max){ return (typeof v === 'string' ? v : '').trim().slice(0, max); }
function isEmail(v){ return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(v) && v.length <= 254; }
function okToken(v){ return /^[A-Za-z0-9]{6,40}$/.test(v); }
function okId(v){ return /^[A-Za-z0-9_-]{1,80}$/.test(v); }

/* Limitation de débit simple (mémoire de l'instance : suffisant contre les abus ordinaires). */
const hits = new Map();
function limited(ip, max, windowMs){
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) { for (const k of hits.keys()) { if (!(hits.get(k) || []).some(t => now - t < windowMs)) hits.delete(k); } }
  return arr.length > max;
}

async function svcRpc(fn, args){
  const headers = { 'Content-Type': 'application/json', apikey: SB_SECRET };
  if (!SB_SECRET.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + SB_SECRET;
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify(args || {}) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) { const err = new Error('rpc ' + fn); err.status = res.status; throw err; }
  return data;
}


/* Envoi de courriel : la base met le message en file (fgh_outbox) ; si un service d'envoi est configuré dans
   Netlify (RESEND_API_KEY + MAIL_FROM), il part tout de suite, sinon il reste « en attente » et l'équipe le voit. */
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
// Les réponses des destinataires arrivent à l'assistance (l'expéditeur noreply@ n'a pas de boîte).
/* Adresses FINECIA GROUPE (marque mère) : tous les courriels FGH-Colab y répondent. Surcharge possible : MAIL_REPLY_TO_FINECIA (Netlify). */
const REPLY_DEFAULT = process.env.MAIL_REPLY_TO_FINECIA || 'contacts@fineciagroupe.com';
function replyFor(m){
  if (process.env.MAIL_REPLY_TO_FINECIA) return process.env.MAIL_REPLY_TO_FINECIA;
  if (m && m.kind === 'support') return 'supportbusiness@fineciagroupe.com';
  if (m && m.partner_id) return 'partnersinfo@fineciagroupe.com';
  return 'contacts@fineciagroupe.com';
}
/* Expéditeur : MAIL_FROM_FINECIA si le domaine fineciagroupe.com est vérifié dans Resend, sinon MAIL_FROM (noreply@helpnaud.ai). */
const FROM_ADDR = process.env.MAIL_FROM_FINECIA || process.env.MAIL_FROM || '';
async function sendQueued(mailId){
  if (!mailId || !/^fghml-[a-f0-9]{14}$/.test(mailId)) return;
  try {
    if (!RESEND_KEY || !FROM_ADDR) return;           // reste en file d'attente
    const m = await svcRpc('svc_outbox_get', { p_id: mailId });
    if (!m || !m.to_email) return;
    const res = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY },
      body: JSON.stringify({ from: FROM_ADDR, reply_to: replyFor(m), to: [m.to_email], subject: m.subject, text: m.body }) });
    await svcRpc('svc_outbox_mark', { p_id: mailId, p_ok: res.ok, p_error: res.ok ? null : ('HTTP ' + res.status) });
  } catch (e) { try { await svcRpc('svc_outbox_mark', { p_id: mailId, p_ok: false, p_error: 'exception' }); } catch (x) {} }
}

/* Courriels de réservation (envoi direct par Resend ; sans RESEND_API_KEY + expéditeur, rien ne part et la réservation reste valide).
   - au client : confirmation avec pièce jointe .ics, si son contact est un courriel ;
   - à l'équipe : avis de nouvelle réservation (MAIL_TO_RDV, sinon contacts@fineciagroupe.com). */
function esc(t){ return String(t == null ? '' : t).replace(/[<>&"]/g, ''); }
function icsText(t){ return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function makeIcs(info, name, motif){
  if (!info || !/^\d{4}-\d{2}-\d{2}$/.test(info.date || '') || !/^\d{2}:\d{2}$/.test(info.start || '') || !/^\d{2}:\d{2}$/.test(info.end || '')) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dt = (d, t) => d.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HelpNaud.ai//RDV//FR', 'BEGIN:VEVENT', 'UID:' + esc(info.id) + '@helpnaud.ai', 'DTSTAMP:' + stamp,
    'DTSTART:' + dt(info.date, info.start), 'DTEND:' + dt(info.date, info.end), 'SUMMARY:' + icsText('Rendez-vous FINECIA GROUPE'),
    'DESCRIPTION:' + icsText((motif ? 'Motif : ' + motif + '\n' : '') + 'Pour déplacer ou annuler, répondez au courriel de confirmation.'), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
async function resendSend(payload){
  const res = await fetch('https://api.resend.com/emails', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY }, body: JSON.stringify(payload) });
  return res.ok;
}
async function resendTry(payload){
  try {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY }, body: JSON.stringify(payload) });
    if (res.ok) return 'ok';
    let msg = ''; try { msg = (await res.text()).slice(0, 300); } catch (e) {}
    console.error('[rdv-mail] Resend HTTP ' + res.status + ' : ' + msg);
    return 'resend_' + res.status;
  } catch (e) { console.error('[rdv-mail] exception : ' + (e && e.message)); return 'exception'; }
}
async function sendClientConfirmation(info, name, email, motif){
  if (!RESEND_KEY) { console.error('[rdv-mail] RESEND_API_KEY absente'); return 'no_key'; }
  if (!FROM_ADDR) { console.error('[rdv-mail] expéditeur absent : définir MAIL_FROM (ou MAIL_FROM_FINECIA)'); return 'no_from'; }
  if (!isEmail(email)) return 'no_email';
  const when = info && info.date ? (info.date + ' de ' + info.start + ' à ' + info.end) : 'le créneau choisi';
  const payload = { from: FROM_ADDR, reply_to: REPLY_DEFAULT, to: [email], subject: 'Confirmation de votre rendez-vous — FINECIA GROUPE',
    text: 'Bonjour ' + name + ',\n\nVotre rendez-vous est enregistré : ' + when + (motif ? ' (' + motif + ')' : '') + '.\n\nNotre équipe vous contactera si des précisions sont nécessaires. Pour déplacer ou annuler, répondez simplement à ce courriel.\n\nCordialement,\nFINECIA GROUPE' };
  const ics = makeIcs(info, name, motif);
  if (ics) {
    const r1 = await resendTry(Object.assign({}, payload, { attachments: [{ filename: 'rendez-vous.ics', content: Buffer.from(ics, 'utf-8').toString('base64') }] }));
    if (r1 === 'ok') return 'ok';
    return await resendTry(payload);   // nouvel essai sans la pièce jointe
  }
  return await resendTry(payload);
}
async function notifyBooking(info, name, email, phone, motif, country, city){
  const when = info ? (info.date + ' de ' + info.start + ' à ' + info.end) : 'le créneau choisi';
  const team = process.env.MAIL_TO_RDV || 'contacts@fineciagroupe.com';
  let teamRes = 'skipped';
  if (RESEND_KEY && FROM_ADDR) {
    teamRes = await resendTry({ from: FROM_ADDR, reply_to: REPLY_DEFAULT, to: [team], subject: 'Nouveau rendez-vous : ' + name + ' — ' + (info ? info.date + ' ' + info.start : ''),
      text: 'Nouvelle réservation via la page publique.\n\nClient : ' + name + '\nCourriel : ' + (email || '—') + '\nTéléphone : ' + (phone || '—') + '\nPays : ' + (country || '—') + '\nVille : ' + (city || '—') + '\nCréneau : ' + when + (motif ? '\nMotif : ' + motif : '') + '\n\nElle apparaît dans FGH-Colab > Rendez-vous (registre et calendrier).' });
  }
  const client = isEmail(email) ? await sendClientConfirmation(info, name, email, motif) : 'no_email';
  console.log('[rdv-mail] client=' + client + ' team=' + teamRes);
  return { client, team: teamRes };
}
function okNumber(v){ return /^[0-9]{10}$/.test(v); }

exports.handler = async function(event){
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  const out = (st, o) => { const r = reply(st, o); r.headers = Object.assign({}, r.headers, cors); return r; };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return out(405, { error: 'Méthode non permise.' });
  if (!SB_SECRET) return out(503, { error: 'Le serveur n’est pas configuré.', code: 'not_configured' });
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return out(400, { error: 'Requête invalide.' }); }
  if (!p || typeof p !== 'object') return out(400, { error: 'Requête invalide.' });
  const h = event.headers || {};
  const ip = String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const action = str(p.action, 40);
  const writes = ['invite-signup', 'book', 'interest', 'academie-register', 'coproject-register'];
  const docWrites = ['partner-doc-put', 'partner-doc-delete', 'coproject-doc-put', 'coproject-doc-delete'];
  const espaceActions = ['espace-enter', 'espace-exit', 'espace-update', 'espace-support', 'espace-notices'];
  if (action === 'espace-enter') {
    if (limited(ip + ':e', 12, 10 * 60 * 1000)) return out(429, { error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  } else if (espaceActions.includes(action)) {
    if (limited(ip + ':eu', 40, 10 * 60 * 1000)) return out(429, { error: 'Trop de demandes. Réessayez dans quelques minutes.' });
  } else if (docWrites.includes(action)) {
    if (limited(ip + ':d', 40, 10 * 60 * 1000)) return out(429, { error: 'Trop de demandes. Réessayez dans quelques minutes.' });
  } else if (limited(ip + (writes.includes(action) ? ':w' : ':r'), writes.includes(action) ? 8 : 60, 10 * 60 * 1000)) {
    return out(429, { error: 'Trop de demandes. Réessayez dans quelques minutes.' });
  }
  if (str(p.website, 50)) return out(200, { ok: true }); // champ piège : les robots le remplissent
  try {
    if (action === 'invite-info') {
      const token = str(p.token, 40);
      if (!okToken(token)) return out(200, { ok: false });
      return out(200, await svcRpc('svc_invite_info', { p_token: token }));
    }
    if (action === 'invite-signup') {
      const token = str(p.token, 40), name = str(p.name, 120), email = str(p.email, 140).toLowerCase();
      if (!okToken(token)) return out(400, { error: 'Lien d’invitation invalide.' });
      if (name.length < 2) return out(400, { error: 'Indiquez le nom de votre organisation ou votre nom.' });
      if (!isEmail(email)) return out(400, { error: 'Courriel invalide.' });
      if (p.policy !== true) return out(400, { error: 'Veuillez lire et accepter la politique de confidentialité et de conduite pour vous inscrire.' });
      const r = await svcRpc('svc_invite_signup', { p_token: token, p: { name, email, contact: str(p.contact, 100), phone: str(p.phone, 40), message: str(p.message, 600), policy: 'true' } });
      if (!r || r.ok !== true) return out(400, { error: r && r.error === 'invalid' ? 'Ce lien d’invitation n’est plus valide.' : (r && r.error === 'busy' ? 'Trop d’inscriptions en attente, réessayez plus tard.' : (r && r.error === 'policy' ? 'Veuillez accepter la politique pour vous inscrire.' : 'Vérifiez les informations saisies.')) });
      await sendQueued(r.mailId);
      return out(200, { ok: true, docToken: (r.docToken && okToken(r.docToken)) ? r.docToken : null, partnerNumber: okNumber(String(r.partnerNumber || '')) ? r.partnerNumber : null });
    }
    if (action === 'partner-doc-info') {
      const token = str(p.token, 40);
      if (!okToken(token) || token.length < 16) return out(200, { ok: false });
      return out(200, await svcRpc('svc_partner_doc_info', { p_token: token }));
    }
    if (action === 'partner-doc-put') {
      const token = str(p.token, 40), name = str(p.name, 200), kind = str(p.kind, 80), mime = str(p.mime, 40), data = typeof p.data === 'string' ? p.data : '';
      if (!okToken(token) || token.length < 16) return out(400, { error: 'Lien invalide.' });
      if (!name) return out(400, { error: 'Nom du fichier manquant.' });
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mime)) return out(400, { error: 'Formats acceptés : PDF, JPEG ou PNG.' });
      if (data.length < 100 || data.length > 3000000) return out(400, { error: 'Fichier trop volumineux (2 Mo maximum).' });
      if (!/^data:(application\/pdf|image\/jpeg|image\/png);base64,[A-Za-z0-9+\/=]+$/.test(data)) return out(400, { error: 'Fichier invalide.' });
      const r = await svcRpc('svc_partner_doc_put', { p_token: token, p_kind: kind || 'Autre', p_name: name, p_mime: mime, p_data: data });
      if (!r || r.ok !== true) return out(400, { error: r && r.error === 'blocked' ? 'Votre compte est suspendu : le téléversement est désactivé.' : (r && r.error === 'limit' ? 'Nombre maximal de documents atteint (15).' : 'Téléversement impossible.') });
      return out(200, { ok: true });
    }
    if (action === 'partner-doc-delete') {
      const token = str(p.token, 40), id = str(p.id, 80);
      if (!okToken(token) || token.length < 16 || !okId(id)) return out(400, { error: 'Demande invalide.' });
      return out(200, await svcRpc('svc_partner_doc_delete', { p_token: token, p_id: id }));
    }
    if (action === 'coproject-info') {
      const token = str(p.token, 40);
      if (!okToken(token)) return out(200, { ok: false });
      return out(200, await svcRpc('svc_coproject_link_info', { p_token: token }));
    }
    if (action === 'coproject-register') {
      const token = str(p.token, 40), client = str(p.client, 100), email = str(p.email, 140).toLowerCase(), title = str(p.title, 100);
      if (!okToken(token)) return out(400, { error: 'Lien invalide.' });
      if (client.length < 2) return out(400, { error: 'Indiquez votre nom ou celui de votre organisation.' });
      if (!isEmail(email)) return out(400, { error: 'Courriel invalide.' });
      if (title.length < 3) return out(400, { error: 'Indiquez le titre de votre projet.' });
      if (p.consent !== true) return out(400, { error: 'Veuillez accepter l’utilisation de vos informations pour envoyer la demande.' });
      const budget = str(String(p.budget == null ? '' : p.budget), 20).replace(/\s+/g, '').replace(',', '.');
      const r = await svcRpc('svc_coproject_register', { p_token: token, p: { client, email, title, consent: 'true',
        phone: str(p.phone, 40), nRue: str(p.nRue, 20), rue: str(p.rue, 120), bp: str(p.bp, 30), cp: str(p.cp, 20), ville: str(p.ville, 80), pays: str(p.pays, 80),
        idType: str(p.idType, 60), idNumber: str(p.idNumber, 60), typeProjet: str(p.typeProjet, 100), typeProjetAutre: str(p.typeProjetAutre, 100),
        bailleur: str(p.bailleur, 140), budget, echeance: str(p.echeance, 10), description: str(p.description, 1500) } });
      if (!r || r.ok !== true) return out(400, { error: r && r.error === 'invalid' ? 'Ce lien n’est plus valide.' : (r && r.error === 'busy' ? 'Trop de demandes en attente, réessayez plus tard.' : 'Vérifiez les informations saisies.') });
      await sendQueued(r.mailId);
      return out(200, { ok: true, duplicate: !!r.duplicate, docToken: (r.docToken && okToken(r.docToken)) ? r.docToken : null,
        clientNumber: r.clientNumber || null, partnerNumber: r.partnerNumber || null, projectNumber: r.projectNumber || null, dealNumber: r.dealNumber || null });
    }
    if (action === 'coproject-doc-info') {
      const token = str(p.token, 40);
      if (!okToken(token) || token.length < 16) return out(200, { ok: false });
      return out(200, await svcRpc('svc_coproject_doc_info', { p_token: token }));
    }
    if (action === 'coproject-doc-put') {
      const token = str(p.token, 40), name = str(p.name, 200), kind = str(p.kind, 80), mime = str(p.mime, 40), data = typeof p.data === 'string' ? p.data : '';
      if (!okToken(token) || token.length < 16) return out(400, { error: 'Lien invalide.' });
      if (!name) return out(400, { error: 'Nom du fichier manquant.' });
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mime)) return out(400, { error: 'Formats acceptés : PDF, JPEG ou PNG.' });
      if (data.length < 100 || data.length > 3000000) return out(400, { error: 'Fichier trop volumineux (2 Mo maximum).' });
      if (!/^data:(application\/pdf|image\/jpeg|image\/png);base64,[A-Za-z0-9+\/=]+$/.test(data)) return out(400, { error: 'Fichier invalide.' });
      const r = await svcRpc('svc_coproject_doc_put', { p_token: token, p_kind: kind || 'Autre', p_name: name, p_mime: mime, p_data: data });
      if (!r || r.ok !== true) return out(400, { error: r && r.error === 'limit' ? 'Nombre maximal de documents atteint (25).' : 'Téléversement impossible.' });
      return out(200, { ok: true });
    }
    if (action === 'coproject-doc-delete') {
      const token = str(p.token, 40), id = str(p.id, 80);
      if (!okToken(token) || token.length < 16 || !okId(id)) return out(400, { error: 'Demande invalide.' });
      return out(200, await svcRpc('svc_coproject_doc_delete', { p_token: token, p_doc: id }));
    }
    if (action === 'espace-enter') {
      const num = str(p.number, 20).replace(/\s+/g, '');
      if (!okNumber(num)) return out(400, { error: 'Le numéro de partenaire compte 10 chiffres.' });
      const r = await svcRpc('svc_partner_enter', { p_number: num });
      if (!r || r.ok !== true) return out(200, { ok: false, error: r && r.error === 'locked' ? 'locked' : 'unknown', name: r && r.name ? r.name : undefined });
      return out(200, r);
    }
    if (action === 'espace-exit') {
      const token = str(p.token, 40);
      if (!okToken(token) || token.length < 16) return out(200, { ok: true });
      return out(200, await svcRpc('svc_partner_exit', { p_token: token }));
    }
    if (action === 'espace-notices') {
      const token = str(p.token, 40);
      if (!okToken(token) || token.length < 16) return out(200, { ok: false });
      return out(200, await svcRpc('svc_partner_notices_read', { p_token: token }));
    }
    if (action === 'espace-update') {
      const token = str(p.token, 40);
      if (!okToken(token) || token.length < 16) return out(400, { error: 'Session expirée. Identifiez-vous de nouveau.', code: 'session' });
      const ch = (p.changes && typeof p.changes === 'object') ? p.changes : {};
      const docs = Array.isArray(p.docs) ? p.docs.slice(0, 3) : [];
      const del = (Array.isArray(p.deleteDocs) ? p.deleteDocs : []).map(x => str(x, 80)).filter(okId).slice(0, 15);
      let total = 0;
      const cleanDocs = [];
      for (const d of docs) {
        const name = str(d && d.name, 200), kind = str(d && d.kind, 80), mime = str(d && d.mime, 40), data = typeof (d && d.data) === 'string' ? d.data : '';
        if (!name || !['application/pdf', 'image/jpeg', 'image/png'].includes(mime)) return out(400, { error: 'Formats acceptés : PDF, JPEG ou PNG.' });
        if (data.length < 100 || data.length > 3000000 || !/^data:(application\/pdf|image\/jpeg|image\/png);base64,[A-Za-z0-9+\/=]+$/.test(data)) return out(400, { error: 'Fichier invalide ou trop volumineux (2 Mo maximum).' });
        total += data.length; cleanDocs.push({ name, kind: kind || 'Autre', mime, data });
      }
      if (total > 4200000) return out(400, { error: 'Les fichiers sont trop volumineux pour un seul envoi (4 Mo au total). Envoyez-les en deux fois.' });
      const r = await svcRpc('svc_partner_update', { p_token: token, p: { nom: str(p.nom, 80), prenom: str(p.prenom, 80), email: str(p.email, 140).toLowerCase(),
        changes: { contact: str(ch.contact, 100), phone: str(ch.phone, 40), address: str(ch.address, 200) }, docs: cleanDocs, deleteDocs: del } });
      if (r && r.mailId) await sendQueued(r.mailId);
      if (!r || r.ok !== true) return out(200, { ok: false, error: (r && r.error) || 'failed', attempts: r && r.attempts, remaining: r && r.remaining });
      return out(200, { ok: true, view: r.view });
    }
    if (action === 'espace-support') {
      const num = str(p.number, 20).replace(/\s+/g, '');
      if (!okNumber(num)) return out(400, { error: 'Numéro invalide.' });
      const msg = str(p.message, 1000);
      if (msg.length < 10) return out(400, { error: 'Décrivez brièvement le problème (10 caractères au moins).' });
      const r = await svcRpc('svc_partner_support', { p_number: num, p: { message: msg, name: str(p.name, 120), contact: str(p.contact, 140) } });
      if (!r || r.ok !== true) return out(400, { error: r && r.error === 'limit' ? 'Vous avez déjà envoyé plusieurs demandes aujourd’hui. Nous vous répondrons dès que possible.' : 'Demande impossible pour le moment.' });
      return out(200, { ok: true });
    }
    if (action === 'academie-catalogue') return out(200, { ok: true, formations: await svcRpc('svc_academie_catalogue', {}) });
    if (action === 'academie-register') {
      const name = str(p.name, 120), email = str(p.email, 140).toLowerCase();
      if (name.length < 2) return out(400, { error: 'Indiquez votre nom.' });
      if (!isEmail(email)) return out(400, { error: 'Courriel invalide.' });
      if (p.consent !== true) return out(400, { error: 'Veuillez accepter l\u2019utilisation de vos informations pour envoyer la demande.' });
      if (str(p.country, 80).length < 2) return out(400, { error: 'Indiquez votre pays de résidence.' });
      const fid = str(p.formationId, 80), other = str(p.formationOther, 120);
      if (fid ? !okId(fid) : other.length < 2) return out(400, { error: 'Choisissez une formation (ou précisez-la).' });
      const r = await svcRpc('svc_academie_register', { p: { name, email, phone: str(p.phone, 40), formationId: fid || null, formationOther: other, format: str(p.format, 80), duration: str(p.duration, 60), message: str(p.message, 600), consent: 'true', country: str(p.country, 80), province: str(p.province, 80), city: str(p.city, 80), region: str(p.region, 80), organisation: str(p.organisation, 120) } });
      if (!r || r.ok !== true) return out(400, { error: r && r.error === 'busy' ? 'Trop d\u2019inscriptions en attente, réessayez plus tard.' : 'Vérifiez les informations saisies.' });
      return out(200, { ok: true });
    }
    if (action === 'slots') return out(200, { ok: true, slots: await svcRpc('svc_public_slots', {}) });
    if (action === 'book') {
      const slot = str(p.slotId, 80), name = str(p.name, 120);
      let email = str(p.email, 140).toLowerCase(), phone = str(p.phone, 40);
      const country = str(p.country, 80), city = str(p.city, 80);
      if (!email && !phone && str(p.contact, 140)) { const c = str(p.contact, 140); if (isEmail(c.toLowerCase())) email = c.toLowerCase(); else phone = c; } // ancienne page en cache
      if (!okId(slot)) return out(400, { error: 'Créneau invalide.' });
      if (name.length < 2) return out(400, { error: 'Indiquez votre nom et prénom.' });
      if (!isEmail(email) && phone.length < 5) return out(400, { error: 'Indiquez un courriel valide.' });
      if (str(p.contact, 140) === '' && (country.length < 2 || city.length < 2)) return out(400, { error: 'Indiquez votre pays et votre ville de résidence.' });
      const contact = [email, phone].filter(Boolean).join(' · ').slice(0, 140);
      const place = (country || city) ? 'Pays : ' + country + ' · Ville : ' + city : '';
      const motif = str(p.motif, 100);
      const motifFull = [motif, place].filter(Boolean).join(' · ').slice(0, 200);
      let info = null;
      try { const all = await svcRpc('svc_public_slots', {}); info = (Array.isArray(all) ? all : []).find(x => x && x.id === slot) || null; } catch (e) { info = null; }
      const r = await svcRpc('svc_book_slot', { p_slot_id: slot, p_name: name, p_contact: contact, p_motif: motifFull });
      if (!r || r.ok !== true) return out(409, { error: r && r.error === 'taken' ? 'Ce créneau vient d’être réservé. Choisissez-en un autre.' : 'Réservation impossible.' });
      const mail = await notifyBooking(info, name, email, phone, motif, country, city);
      return out(200, { ok: true, emailed: mail.client === 'ok', mail: mail.client });
    }
    if (action === 'rdv-confirm') {
      /* Confirmation envoyée depuis FGH-Colab par un membre connecté (jeton de connexion vérifié auprès de Supabase). */
      const auth = String((h.authorization || h.Authorization || '')).replace(/^Bearer\s+/i, '');
      if (!auth) return out(401, { error: 'Connexion requise.' });
      if (limited(ip + ':cf', 30, 60 * 60 * 1000)) return out(429, { error: 'Trop d’envois. Réessayez plus tard.' });
      let okUser = false;
      try {
        const ur = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P', Authorization: 'Bearer ' + auth } });
        okUser = ur.ok;
      } catch (e) { okUser = false; }
      if (!okUser) return out(401, { error: 'Connexion requise.' });
      const to = str(p.to, 140).toLowerCase(), cname = str(p.name, 120), date = str(p.date, 10), start = str(p.start, 5), end = str(p.end, 5), cmotif = str(p.motif, 200);
      if (!isEmail(to) || cname.length < 2) return out(400, { error: 'Courriel ou nom invalide.' });
      const info2 = { id: 'conf-' + Date.now().toString(36), date, start, end };
      const res = await sendClientConfirmation(info2, cname, to, cmotif);
      return out(200, { ok: res === 'ok', mail: res });
    }
    if (action === 'catalogue') {
      const token = str(p.token, 40);
      if (!okToken(token)) return out(200, { ok: false });
      return out(200, await svcRpc('svc_public_catalogue', { p_token: token }));
    }
    if (action === 'photos') {
      const token = str(p.token, 40), vid = str(p.vehicleId, 80);
      if (!okToken(token) || !okId(vid)) return out(200, { ok: false });
      return out(200, await svcRpc('svc_public_photos', { p_token: token, p_vehicle_id: vid }));
    }
    if (action === 'interest') {
      const token = str(p.token, 40), vid = str(p.vehicleId, 80), name = str(p.name, 100), contact = str(p.contact, 140);
      if (!okToken(token) || !okId(vid)) return out(400, { error: 'Demande invalide.' });
      if (name.length < 2 || contact.length < 3) return out(400, { error: 'Indiquez votre nom et un moyen de vous joindre.' });
      const r = await svcRpc('svc_vehicle_interest', { p_token: token, p_vehicle_id: vid, p_name: name, p_contact: contact });
      if (!r || r.ok !== true) return out(400, { error: r && r.error === 'unavailable' ? 'Ce véhicule n’est plus disponible.' : 'Demande impossible pour le moment.' });
      return out(200, { ok: true });
    }
    return out(400, { error: 'Action inconnue.' });
  } catch (e) {
    return out(502, { error: 'Service momentanément indisponible.' });
  }
};
