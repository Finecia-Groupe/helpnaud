/* HelpNaud.ai — « Image IA » côté serveur (Netlify Function)
 *
 * Génère ou transforme une image avec un MOTEUR D'IMAGES (Claude ne génère pas d'images : il faut un fournisseur d'images).
 * Fournisseur pris en charge ici : OpenAI Images (gpt-image-1). La clé reste dans les variables Netlify, jamais dans Git :
 *   IMAGE_API_KEY      (obligatoire)  clé du fournisseur d'images
 *   IMAGE_MODEL        (optionnel)    défaut « gpt-image-1 »
 *   IMAGE_QUALITY      (optionnel)    low | medium | high — défaut « medium »
 *   IMAGE_CREDITS      (optionnel)    crédits HelpNaud débités par image — défaut 15 (à définir selon votre tarification)
 *   IMAGE_CREDITS_TEAM (optionnel)    crédits débités pour l'équipe interne — défaut 5
 *   IMAGE_COST_USD     (optionnel)    coût réel estimé par image en $US pour le plafond global — défaut 0.05
 * Étapes : session Supabase vérifiée → crédits réservés → image générée → crédits remboursés en cas d'échec.
 */
'use strict';
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const KEY = process.env.IMAGE_API_KEY || '';
const MODEL = process.env.IMAGE_MODEL || 'gpt-image-1';
const QUALITY = ['low', 'medium', 'high'].includes(process.env.IMAGE_QUALITY) ? process.env.IMAGE_QUALITY : 'medium';
const CREDITS = Math.max(1, parseInt(process.env.IMAGE_CREDITS || '15', 10) || 15);
const CREDITS_TEAM = Math.max(1, parseInt(process.env.IMAGE_CREDITS_TEAM || '5', 10) || 5);   // tarif équipe (F-i-Stat)
const COST_MICRO = Math.round((parseFloat(process.env.IMAGE_COST_USD || '0.05') || 0.05) * 1000000);
const SIZES = { carre: '1024x1024', portrait: '1024x1536', paysage: '1536x1024' };
const hits = new Map();

function reply(status, obj){ return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) }; }
function svcHeaders(){ const h = { 'Content-Type': 'application/json', apikey: SB_SECRET }; if (!SB_SECRET.startsWith('sb_secret_')) h.Authorization = 'Bearer ' + SB_SECRET; return h; }
async function svcRpc(fn, args){
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: svcHeaders(), body: JSON.stringify(args || {}) });
  const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) { const err = new Error('rpc ' + fn); err.status = res.status; throw err; }
  return data;
}
async function userIdFromToken(token){
  if (!token || token.length > 4000) return null;
  const res = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return u && /^[0-9a-f-]{36}$/i.test(u.id || '') ? u.id : null;
}
function limited(key, max, windowMs){
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < windowMs); arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
function dataUrlToBlob(u){
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(u || ''); if (!m) return null;
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > 4 * 1024 * 1024) return null;
  return new Blob([buf], { type: m[1] });
}

exports.handler = async function(event){
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method', message: 'Méthode non permise.' });
  if (!SB_SECRET) return reply(503, { error: 'not_configured', message: 'Le serveur n’est pas configuré.' });
  if (!KEY) return reply(503, { error: 'image_not_configured', message: 'Le moteur d’images n’est pas encore branché sur le serveur (variable IMAGE_API_KEY). Design, Dessiner et Templates Creators fonctionnent déjà.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad_request', message: 'Requête invalide.' }); }
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = /^Bearer\s+(.+)$/i.exec(auth) ? RegExp.$1.trim() : '';
  let uid = null;
  try { uid = await userIdFromToken(token); } catch (e) { return reply(502, { error: 'auth_unavailable', message: 'Vérification de la session impossible.' }); }
  if (!uid) return reply(401, { error: 'auth', message: 'Connectez-vous pour créer une image.' });
  if (limited('img:' + uid, 6, 60 * 1000)) return reply(429, { error: 'rate', message: 'Trop de demandes : patientez quelques secondes.' });

  const prompt = String(body.prompt || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, 3000);
  if (prompt.length < 4) return reply(400, { error: 'bad_request', message: 'Décrivez l’image à créer.' });
  const size = SIZES[body.format] || SIZES.carre;
  let src = null;
  if (body.image) { src = dataUrlToBlob(body.image); if (!src) return reply(400, { error: 'image_rejected', message: 'Image importée refusée (PNG, JPEG ou WebP, 4 Mo maximum).' }); }

  let COST = CREDITS;
  if (body.fi === true) {   // tarif équipe : vérifié côté serveur
    let okTeam = false;
    try { okTeam = (await svcRpc('svc_is_team_member', { p_uid: uid })) === true; } catch (e) { okTeam = false; }
    if (!okTeam) return reply(403, { error: 'private_tool', message: 'Cet outil est réservé à l’équipe de FINECIA GROUPE.' });
    COST = CREDITS_TEAM;
  }
  // svc_ai_reserve n'accepte que 1 à 10 crédits par appel : on réserve par tranches (ex. 15 = 10 + 5) et on rembourse tout si une tranche échoue.
  const chunks = []; for (let left = COST; left > 0; left -= 10) chunks.push(Math.min(10, left));
  let r = null, reserved = 0;
  const undo = async () => { for (const c of chunks.slice(0, reserved)) { try { await svcRpc('svc_ai_refund', { p_uid: uid, p_cost: c }); } catch (e) {} } reserved = 0; };
  try {
    for (const c of chunks) { r = await svcRpc('svc_ai_reserve', { p_uid: uid, p_cost: c }); if (!r || r.ok !== true) break; reserved++; }
  } catch (e) { await undo(); return reply(502, { error: 'credits_unavailable', message: 'Compteur de crédits indisponible.' }); }
  if (!r || r.ok !== true) {
    await undo();
    if (r && (r.error === 'quota' || r.error === 'pool_quota' || r.error === 'member_quota')) return reply(402, { error: 'quota', message: 'Crédits IA insuffisants pour cette image (' + COST + ' crédits requis).', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && (r.error === 'budget' || r.error === 'pool_budget')) return reply(402, { error: 'budget', message: 'Limite d’utilisation mensuelle atteinte pour votre forfait.', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && r.error === 'suspended') return reply(403, { error: 'suspended', message: 'Compte suspendu : contactez le support.' });
    if (r && r.error === 'not_member') return reply(403, { error: 'not_member', message: 'Créez votre compte HelpNaud (Réglages › Mon compte) pour utiliser Image IA.' });
    return reply(400, { error: r && r.error || 'refused', message: 'Demande refusée par le compteur de crédits' + (r && r.error ? ' (' + r.error + ')' : '') + '.' });
  }
  const refund = undo;

  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 24000);
    let res;
    try {
      if (src) {
        const fd = new FormData(); fd.append('model', MODEL); fd.append('prompt', prompt); fd.append('size', size); fd.append('quality', QUALITY); fd.append('output_format', 'jpeg'); fd.append('output_compression', '85');
        fd.append('image', src, 'image.' + (src.type.split('/')[1] || 'png'));
        res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: fd, signal: ctl.signal });
      } else {
        res = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, prompt, size, quality: QUALITY, n: 1, output_format: 'jpeg', output_compression: 85 }), signal: ctl.signal });
      }
    } finally { clearTimeout(timer); }
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.data || !j.data[0] || !j.data[0].b64_json) {
      await refund();
      const blocked = j && j.error && /safety|moderation|content_policy/i.test(String(j.error.code || '') + ' ' + String(j.error.message || ''));
      return reply(blocked ? 422 : 502, { error: blocked ? 'blocked' : 'upstream', message: blocked ? 'Cette demande ne peut pas être traitée (contenu refusé par le moteur d’images). Reformulez-la.' : 'Le moteur d’images est momentanément indisponible. Vos crédits ont été remboursés.' });
    }
    try { await svcRpc('svc_ai_charge', { p_uid: uid, p_micro: COST_MICRO }); } catch (e) {}
    return reply(200, { image: 'data:image/jpeg;base64,' + j.data[0].b64_json, credits: { used: r.used, limit: r.limit, plan: r.plan }, cost: COST });
  } catch (e) {
    await refund();
    return reply(e && e.name === 'AbortError' ? 504 : 502, { error: e && e.name === 'AbortError' ? 'timeout' : 'upstream', message: e && e.name === 'AbortError' ? 'La génération a pris trop de temps. Vos crédits ont été remboursés ; réessayez.' : 'Le moteur d’images est momentanément indisponible. Vos crédits ont été remboursés.' });
  }
};
