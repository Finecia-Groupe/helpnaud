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
async function sendQueued(mailId){
  if (!mailId || !/^fghml-[a-f0-9]{14}$/.test(mailId)) return;
  try {
    if (!RESEND_KEY || !MAIL_FROM) return;           // reste en file d'attente
    const m = await svcRpc('svc_outbox_get', { p_id: mailId });
    if (!m || !m.to_email) return;
    const res = await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_KEY },
      body: JSON.stringify({ from: MAIL_FROM, to: [m.to_email], subject: m.subject, text: m.body }) });
    await svcRpc('svc_outbox_mark', { p_id: mailId, p_ok: res.ok, p_error: res.ok ? null : ('HTTP ' + res.status) });
  } catch (e) { try { await svcRpc('svc_outbox_mark', { p_id: mailId, p_ok: false, p_error: 'exception' }); } catch (x) {} }
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
  const writes = ['invite-signup', 'book', 'interest', 'academie-register'];
  const docWrites = ['partner-doc-put', 'partner-doc-delete'];
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
      const slot = str(p.slotId, 80), name = str(p.name, 120), contact = str(p.contact, 140);
      if (!okId(slot)) return out(400, { error: 'Créneau invalide.' });
      if (name.length < 2 || contact.length < 3) return out(400, { error: 'Indiquez votre nom et un moyen de vous joindre.' });
      const r = await svcRpc('svc_book_slot', { p_slot_id: slot, p_name: name, p_contact: contact, p_motif: str(p.motif, 200) });
      if (!r || r.ok !== true) return out(409, { error: r && r.error === 'taken' ? 'Ce créneau vient d’être réservé. Choisissez-en un autre.' : 'Réservation impossible.' });
      return out(200, { ok: true });
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
