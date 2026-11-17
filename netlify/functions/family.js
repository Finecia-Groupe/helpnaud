/* HelpNaud.ai — contrôle parental + contact de confiance (serveur).
   Accès base : clé service (tables protégées par RLS, sans politique publique).
   Courriels : Resend (RESEND_API_KEY_FINECIA ou RESEND_API_KEY ; expéditeur MAIL_FROM_FINECIA ou MAIL_FROM).
   Jamais de contenu de conversation dans une notification. */
const crypto = require('crypto');
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SITE = (process.env.SITE_URL || 'https://helpnaud.ai').replace(/\/+$/, '');
const MAIL_KEY = process.env.RESEND_API_KEY_FINECIA || process.env.RESEND_API_KEY || '';
const MAIL_FROM = (function(){ const v = String(process.env.MAIL_FROM_FINECIA || process.env.MAIL_FROM || '').trim(); if (!v) return ''; return v.indexOf('<') !== -1 ? v : 'HelpNaud <' + v + '>'; })();
const DEFAULTS = { sensitive: true, web: true, images: true, voice: true, code: true, improve: true, quiet: [] };
const BOOL_KEYS = ['sensitive', 'web', 'images', 'voice', 'code', 'improve'];

function reply(status, obj){ return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) }; }
function hdr(){ const h = { 'Content-Type': 'application/json', apikey: SB_SECRET }; if (!SB_SECRET.startsWith('sb_secret_')) h.Authorization = 'Bearer ' + SB_SECRET; return h; }
async function rest(method, path, body, prefer){
  const h = hdr(); if (prefer) h.Prefer = prefer;
  const res = await fetch(SB_URL + '/rest/v1/' + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
  const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  if (!res.ok) { const e = new Error('db ' + res.status); e.status = res.status; e.data = d; throw e; }
  return d;
}
async function rpc(fn, args){ const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: hdr(), body: JSON.stringify(args || {}) }); if (!res.ok) throw new Error('rpc ' + res.status); const t = await res.text(); try { return t ? JSON.parse(t) : null; } catch (e) { return t; } }
async function authUser(token){
  if (!token || token.length > 4000) return null;
  const res = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!res.ok) return null; const u = await res.json().catch(() => null);
  return u && /^[0-9a-f-]{36}$/i.test(u.id || '') && u.email ? { id: u.id, email: String(u.email).toLowerCase() } : null;
}
async function userInfo(id){
  try { const res = await fetch(SB_URL + '/auth/v1/admin/users/' + id, { headers: hdr() }); if (!res.ok) return null; const u = await res.json(); return { email: String(u.email || '').toLowerCase(), name: (u.user_metadata && (u.user_metadata.first_name || u.user_metadata.name)) || '' }; } catch (e) { return null; }
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/;
function mask(e){ e = String(e || ''); const i = e.indexOf('@'); if (i < 1) return ''; return e.slice(0, 1) + '•••' + e.slice(i); }
async function sendMail(to, subject, text){
  if (!MAIL_KEY || !MAIL_FROM || !to) return false;
  try { const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + MAIL_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text: text + '\n\n—\nHelpNaud, un service de FINECIA GROUPE\nPolitique de contrôle parental : ' + SITE + '/fr-fr/politique-contrôle-parental' }) }); return r.ok; } catch (e) { return false; }
}
const hits = new Map();
function limited(key, max, win){ const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < win); a.push(now); hits.set(key, a); return a.length > max; }

function cleanSettings(s, base){
  const out = Object.assign({}, DEFAULTS, base || {}); if (!s || typeof s !== 'object') return out;
  BOOL_KEYS.forEach(k => { if (typeof s[k] === 'boolean') out[k] = s[k]; });
  if (Array.isArray(s.quiet)) out.quiet = s.quiet.slice(0, 5).filter(q => q && /^\d{2}:\d{2}$/.test(q.from) && /^\d{2}:\d{2}$/.test(q.to)).map(q => ({ from: q.from, to: q.to }));
  if (typeof s.tz === 'string' && /^[A-Za-z_\/+\-0-9]{1,40}$/.test(s.tz)) out.tz = s.tz;
  return out;
}

exports.handler = async function(event){
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, message: 'Méthode non permise.' });
  if (!SB_SECRET) return reply(503, { ok: false, message: 'Service non configuré sur le serveur.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { ok: false, message: 'Requête invalide.' }); }
  const action = String(b.action || '');
  const ip = String((event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || '?').split(',')[0].trim();

  /* ----- Actions publiques : réponse du contact de confiance (jeton à usage unique reçu par courriel) ----- */
  if (action === 'trust_confirm' || action === 'trust_decline' || action === 'trust_peek') {
    if (limited('ip:' + ip, 20, 60000)) return reply(429, { ok: false, message: 'Trop de demandes.' });
    const tok = String(b.token || ''); if (!/^[0-9a-f]{48}$/.test(tok)) return reply(400, { ok: false, message: 'Lien invalide.' });
    try {
      const rows = await rest('GET', 'trusted_contacts?token_hash=eq.' + sha(tok) + '&status=eq.pending&select=user_id,name,created_at');
      if (!rows || !rows[0]) return reply(404, { ok: false, message: 'Ce lien n’est plus valide (déjà utilisé, retiré ou expiré).' });
      const row = rows[0];
      if (Date.now() - new Date(row.created_at).getTime() > 14 * 864e5) return reply(410, { ok: false, message: 'Ce lien a expiré.' });
      const ui = await userInfo(row.user_id);
      if (action === 'trust_peek') return reply(200, { ok: true, who: (ui && ui.name) || 'Une personne', contactName: row.name });
      if (action === 'trust_confirm') {
        if (b.adult !== true) return reply(400, { ok: false, message: 'Vous devez confirmer avoir au moins 18 ans.' });
        await rest('PATCH', 'trusted_contacts?user_id=eq.' + row.user_id, { status: 'confirmed', confirmed_at: new Date().toISOString() });
        if (ui && ui.email) await sendMail(ui.email, 'Votre contact de confiance a accepté', row.name + ' a accepté d’être votre contact de confiance dans HelpNaud.');
        return reply(200, { ok: true, status: 'confirmed' });
      }
      await rest('PATCH', 'trusted_contacts?user_id=eq.' + row.user_id, { status: 'revoked' });
      return reply(200, { ok: true, status: 'revoked' });
    } catch (e) { return reply(500, { ok: false, message: 'Erreur du serveur.' }); }
  }

  /* ----- Actions authentifiées ----- */
  const m = /^Bearer\s+(.+)$/i.exec((event.headers && (event.headers.authorization || event.headers.Authorization)) || '');
  let me = null; try { me = await authUser(m ? m[1].trim() : ''); } catch (e) { return reply(502, { ok: false, message: 'Vérification de la session impossible.' }); }
  if (!me) return reply(401, { ok: false, message: 'Connectez-vous pour continuer.' });
  if (limited('u:' + me.id, 40, 60000)) return reply(429, { ok: false, message: 'Trop de demandes : patientez quelques secondes.' });

  try {
    if (action === 'overview') {
      const q = 'family_links?or=' + encodeURIComponent('(parent_id.eq.' + me.id + ',teen_id.eq.' + me.id + ',and(invite_email.eq.' + me.email + ',status.eq.pending))') + '&status=in.(pending,active)&order=created_at.desc&limit=60&select=*';
      const rows = (await rest('GET', q)) || [];
      const family = [], incoming = [];
      for (const r of rows) {
        const mine = r.parent_id === me.id || r.teen_id === me.id;
        if (r.status === 'pending' && new Date(r.expires_at) < new Date()) continue;
        if (!mine) { const inv = await userInfo(r.invited_by); incoming.push({ id: r.id, from: mask(inv && inv.email), role: r.direction === 'parent_invites' ? 'teen' : 'parent' }); continue; }
        const role = r.parent_id === me.id ? 'parent' : 'teen';
        let other = r.invite_email;
        if (r.status === 'active') { const o = await userInfo(role === 'parent' ? r.teen_id : r.parent_id); other = o && o.email || ''; }
        family.push({ id: r.id, role, status: r.status, other: mask(other), mine: r.invited_by === me.id, settings: cleanSettings(r.settings), expires_at: r.expires_at });
      }
      const tc = ((await rest('GET', 'trusted_contacts?user_id=eq.' + me.id + '&status=in.(pending,confirmed)&select=name,email,status')) || [])[0];
      return reply(200, { ok: true, family, incoming, trusted: tc ? { name: tc.name, email: mask(tc.email), status: tc.status } : null, mailReady: !!(MAIL_KEY && MAIL_FROM) });
    }

    if (action === 'invite' || action === 'resend') {
      let row, token = newToken();
      if (action === 'invite') {
        const kind = b.kind === 'parent' ? 'parent' : 'teen', email = String(b.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return reply(400, { ok: false, message: 'Courriel invalide. L’invitation par téléphone n’est pas encore disponible.' });
        if (email === me.email) return reply(400, { ok: false, message: 'Vous ne pouvez pas vous inviter vous-même.' });
        if (kind === 'parent') { const act = await rest('GET', 'family_links?teen_id=eq.' + me.id + '&status=eq.active&select=id'); if (act && act.length) return reply(409, { ok: false, message: 'Votre compte est déjà associé à un parent ou tuteur.' }); }
        const pend = (await rest('GET', 'family_links?invited_by=eq.' + me.id + '&status=eq.pending&select=id,invite_email')) || [];
        if (pend.length >= 10) return reply(429, { ok: false, message: 'Trop d’invitations en attente : annulez-en avant d’en envoyer.' });
        if (pend.some(p => p.invite_email === email)) return reply(409, { ok: false, message: 'Une invitation est déjà en attente pour ce courriel (utilisez « Renvoyer »).' });
        row = (await rest('POST', 'family_links', { parent_id: kind === 'teen' ? me.id : null, teen_id: kind === 'parent' ? me.id : null, invited_by: me.id, direction: kind === 'teen' ? 'parent_invites' : 'teen_invites', invite_email: email, token_hash: sha(token), settings: DEFAULTS }, 'return=representation'))[0];
      } else {
        if (limited('rs:' + me.id, 3, 60000)) return reply(429, { ok: false, message: 'Patientez avant de renvoyer.' });
        row = ((await rest('GET', 'family_links?id=eq.' + encodeURIComponent(String(b.id || '')) + '&invited_by=eq.' + me.id + '&status=eq.pending&select=*')) || [])[0];
        if (!row) return reply(404, { ok: false, message: 'Invitation introuvable.' });
        await rest('PATCH', 'family_links?id=eq.' + row.id, { token_hash: sha(token), expires_at: new Date(Date.now() + 7 * 864e5).toISOString() });
      }
      const link = SITE + '/?famille=' + token;
      const txt = row.direction === 'parent_invites'
        ? me.email + ' vous invite à associer son compte HelpNaud au vôtre (contrôle parental : il est le parent ou tuteur, vous êtes l’adolescent).\n\nCette association ne donne JAMAIS accès à vos conversations. Vous pouvez la dissocier à tout moment.\n\nPour accepter, connectez-vous (ou créez un compte) avec cette adresse courriel, puis ouvrez :\n' + link + '\n\nLe lien est valable 7 jours. Si vous ne connaissez pas cette personne, ignorez ce message.'
        : me.email + ' (adolescent) vous invite à devenir son parent ou tuteur dans HelpNaud (contrôle parental). Cette association ne donne jamais accès à ses conversations ; elle permet de régler certaines fonctions et de recevoir des notifications de sécurité limitées.\n\nPour accepter, connectez-vous (ou créez un compte) avec cette adresse courriel, puis ouvrez :\n' + link + '\n\nLe lien est valable 7 jours. Si vous ne connaissez pas cette personne, ignorez ce message.';
      const emailed = await sendMail(row.invite_email, 'Invitation de contrôle parental HelpNaud', txt);
      return reply(200, { ok: true, emailed, link: emailed ? undefined : link });
    }

    if (action === 'accept') {
      let row;
      if (b.token) { if (!/^[0-9a-f]{48}$/.test(String(b.token))) return reply(400, { ok: false, message: 'Lien invalide.' }); row = ((await rest('GET', 'family_links?token_hash=eq.' + sha(b.token) + '&status=eq.pending&select=*')) || [])[0]; }
      else row = ((await rest('GET', 'family_links?id=eq.' + encodeURIComponent(String(b.id || '')) + '&status=eq.pending&select=*')) || [])[0];
      if (!row) return reply(404, { ok: false, message: 'Invitation introuvable ou déjà utilisée.' });
      if (new Date(row.expires_at) < new Date()) { await rest('PATCH', 'family_links?id=eq.' + row.id, { status: 'expired' }); return reply(410, { ok: false, message: 'Invitation expirée : demandez-en une nouvelle.' }); }
      if (row.invite_email !== me.email) return reply(403, { ok: false, message: 'Cette invitation est destinée à une autre adresse courriel. Connectez-vous avec le compte invité.' });
      if (row.invited_by === me.id) return reply(403, { ok: false, message: 'Vous ne pouvez pas accepter votre propre invitation.' });
      const patch = row.direction === 'parent_invites' ? { teen_id: me.id } : { parent_id: me.id };
      if (patch.teen_id) { const act = await rest('GET', 'family_links?teen_id=eq.' + me.id + '&status=eq.active&select=id'); if (act && act.length) return reply(409, { ok: false, message: 'Votre compte est déjà associé à un parent ou tuteur.' }); }
      try { await rest('PATCH', 'family_links?id=eq.' + row.id + '&status=eq.pending', Object.assign(patch, { status: 'active', accepted_at: new Date().toISOString(), token_hash: sha(newToken()) })); }
      catch (e) { return reply(409, { ok: false, message: 'Association impossible : un parent ou tuteur est déjà associé à ce compte.' }); }
      const inv = await userInfo(row.invited_by); if (inv && inv.email) await sendMail(inv.email, 'Invitation acceptée', me.email + ' a accepté votre invitation de contrôle parental HelpNaud.');
      return reply(200, { ok: true });
    }

    if (action === 'cancel' || action === 'decline') {
      const f = action === 'cancel' ? 'invited_by=eq.' + me.id : 'invite_email=eq.' + encodeURIComponent(me.email);
      await rest('PATCH', 'family_links?id=eq.' + encodeURIComponent(String(b.id || '')) + '&status=eq.pending&' + f, { status: 'cancelled', ended_at: new Date().toISOString() });
      return reply(200, { ok: true });
    }

    if (action === 'unlink') {
      const row = ((await rest('GET', 'family_links?id=eq.' + encodeURIComponent(String(b.id || '')) + '&status=eq.active&or=(parent_id.eq.' + me.id + ',teen_id.eq.' + me.id + ')&select=*')) || [])[0];
      if (!row) return reply(404, { ok: false, message: 'Association introuvable.' });
      await rest('PATCH', 'family_links?id=eq.' + row.id, { status: 'unlinked', ended_at: new Date().toISOString() });
      const otherId = row.parent_id === me.id ? row.teen_id : row.parent_id, o = await userInfo(otherId);
      if (o && o.email) await sendMail(o.email, 'Comptes dissociés', me.email + ' a dissocié vos comptes HelpNaud. Le contrôle parental et les notifications de sécurité liés à cette association sont terminés.');
      return reply(200, { ok: true });
    }

    if (action === 'settings') {
      const row = ((await rest('GET', 'family_links?id=eq.' + encodeURIComponent(String(b.id || '')) + '&status=eq.active&parent_id=eq.' + me.id + '&select=id,settings')) || [])[0];
      if (!row) return reply(403, { ok: false, message: 'Seul le parent ou tuteur associé peut modifier ces réglages.' });
      const st = cleanSettings(b.settings, row.settings);
      await rest('PATCH', 'family_links?id=eq.' + row.id, { settings: st });
      return reply(200, { ok: true, settings: st });
    }

    if (action === 'trust_set') {
      const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 80);
      if (!name || !EMAIL_RE.test(email)) return reply(400, { ok: false, message: 'Indiquez un nom et un courriel valides.' });
      if (email === me.email) return reply(400, { ok: false, message: 'Choisissez une autre personne que vous.' });
      if (b.adult !== true) return reply(400, { ok: false, message: 'Confirmez que cette personne a au moins 18 ans.' });
      if (limited('ts:' + me.id, 5, 3600000)) return reply(429, { ok: false, message: 'Trop de demandes : réessayez plus tard.' });
      const token = newToken();
      await rest('POST', 'trusted_contacts?on_conflict=user_id', { user_id: me.id, name, email, token_hash: sha(token), status: 'pending', created_at: new Date().toISOString(), confirmed_at: null }, 'resolution=merge-duplicates');
      const link = SITE + '/contact-confiance?t=' + token;
      const emailed = await sendMail(email, 'Voulez-vous être contact de confiance sur HelpNaud ?', 'Bonjour ' + name + ',\n\n' + me.email + ' souhaite vous désigner comme contact de confiance dans HelpNaud.\n\nSi une conversation de cette personne laisse craindre un risque grave pour sa sécurité lié au suicide, nous pourrions vous en avertir afin que vous preniez de ses nouvelles. Vous ne recevriez jamais le contenu de ses conversations. Il faut avoir au moins 18 ans.\n\nAccepter ou refuser : ' + link + '\n\nLe lien est valable 14 jours. Si vous ne connaissez pas cette personne, ignorez ce message.');
      return reply(200, { ok: true, emailed, link: emailed ? undefined : link });
    }
    if (action === 'trust_remove') { await rest('DELETE', 'trusted_contacts?user_id=eq.' + me.id); return reply(200, { ok: true }); }

    /* Notification de sécurité : envoyée UNIQUEMENT par un membre actif de l'équipe, après examen humain. Aucun contenu de conversation. */
    if (action === 'safety_notify') {
      let team = false; try { team = (await rpc('svc_is_team_member', { p_uid: me.id })) === true; } catch (e) {}
      if (!team) return reply(403, { ok: false, message: 'Réservé à l’équipe.' });
      const uid = String(b.user_id || ''), kind = String(b.kind || '');
      if (!/^[0-9a-f-]{36}$/i.test(uid) || ['self_harm', 'eating', 'violence_closure', 'violence_pause'].indexOf(kind) < 0) return reply(400, { ok: false, message: 'Paramètres invalides.' });
      const MSG = { self_harm: 'HelpNaud a identifié, après examen, une préoccupation grave pour la sécurité de la personne concernée (risque d’automutilation ou de suicide).', eating: 'HelpNaud a identifié, après examen, des signes pouvant être associés à un trouble du comportement alimentaire.', violence_closure: 'Le compte a été définitivement fermé à la suite de propos violents contraires aux Conditions d’utilisation de HelpNaud.', violence_pause: 'Le compte a été temporairement suspendu en raison de préoccupations graves liées à la violence.' };
      const body = (who) => 'Bonjour,\n\n' + MSG[kind] + '\n\nCette notification ne contient aucune conversation. Prenez des nouvelles de la personne, écoutez-la sans juger et aidez-la à joindre une personne de confiance, un professionnel ou une ligne d’écoute. Si quelqu’un est en danger immédiat, appelez les services d’urgence de votre région.\n\nPour toute question : supportbusiness@fineciagroupe.com';
      const sent = [];
      const links = ((await rest('GET', 'family_links?teen_id=eq.' + uid + '&status=eq.active&notify_parent=eq.true&select=parent_id')) || []);
      for (const l of links) { const p = await userInfo(l.parent_id); if (p && p.email) { const ok = await sendMail(p.email, 'Notification de sécurité HelpNaud', body()); await rest('POST', 'safety_alerts', { user_id: uid, kind, recipient: 'parent', recipient_email: p.email, sent: ok, sent_by: me.id }); sent.push('parent'); } }
      if (kind === 'self_harm' && !links.length) { const tc = ((await rest('GET', 'trusted_contacts?user_id=eq.' + uid + '&status=eq.confirmed&select=email')) || [])[0]; if (tc) { const ok = await sendMail(tc.email, 'Notification de sécurité HelpNaud', body()); await rest('POST', 'safety_alerts', { user_id: uid, kind, recipient: 'trusted_contact', recipient_email: tc.email, sent: ok, sent_by: me.id }); sent.push('trusted_contact'); } }
      return reply(200, { ok: true, recipients: sent });
    }
    return reply(400, { ok: false, message: 'Action inconnue.' });
  } catch (e) {
    if (e && e.status === 404 || e && e.data && /relation .* does not exist|Could not find the table/i.test(JSON.stringify(e.data))) return reply(503, { ok: false, message: 'Service pas encore installé (exécutez supabase-famille.sql).' });
    return reply(500, { ok: false, message: 'Erreur du serveur.' });
  }
};
