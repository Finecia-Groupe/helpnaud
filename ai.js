/* HelpNaud.ai — Assistant IA côté serveur (Netlify Function)
 *
 * Le navigateur envoie le jeton de session Supabase (Authorization: Bearer …) et un palier Hmodel. Le serveur :
 *   1) vérifie le jeton auprès de Supabase Auth (l'identité ne vient jamais du navigateur) ;
 *   2) réserve les crédits (svc_ai_reserve : membre actif uniquement, plafond mensuel selon le forfait) ;
 *   3) appelle le fournisseur d'IA choisi (Claude par défaut ; OpenAI, Gemini, Mistral possibles) avec sa clé secrète (variables Netlify — jamais dans GitHub) ;
 *   4) rembourse les crédits en cas d'échec, journalise l'usage (svc_ai_log) et renvoie { text, data, credits }.
 * Aucune dépendance npm.
 */
'use strict';
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
/* ---------- Fournisseurs d'IA ----------
 * Pour activer un fournisseur : ajouter sa clé dans Netlify (Environment variables) et relancer un déploiement.
 *   anthropic → ANTHROPIC_API_KEY   (Claude, fournisseur de départ)
 *   openai    → OPENAI_API_KEY
 *   google    → GEMINI_API_KEY      (Google Gemini)
 *   mistral   → MISTRAL_API_KEY
 * Réglages optionnels (Netlify) :
 *   AI_PROVIDER            fournisseur par défaut (sinon : le premier dont la clé existe, dans l'ordre ci-dessus)
 *   AI_PROVIDER_LOW / _MID / _HIGH   fournisseur par gamme de palier (1 crédit / 2-3 crédits / 4-5 crédits)
 *   AI_MODEL_LOW / _MID / _HIGH      modèle par gamme (doit exister chez le fournisseur choisi)
 *   AI_FALLBACK            fournisseur de secours si le principal est en panne
 * Aucune clé n'est jamais envoyée au navigateur. Sans aucune clé : « non configuré », rien n'est facturé.
 */
const KEYS = {
  anthropic: process.env.ANTHROPIC_API_KEY || '',
  openai:    process.env.OPENAI_API_KEY || '',
  google:    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  mistral:   process.env.MISTRAL_API_KEY || ''
};
const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'mistral'];
/* Modèles par défaut selon le fournisseur et la gamme. Les noms de modèles évoluent : on les corrige dans Netlify
   (AI_MODEL_LOW / _MID / _HIGH) sans toucher au code. */
const DEFAULT_MODELS = {
  anthropic: { low: 'claude-haiku-5-5', mid: 'claude-sonnet-5-5', high: 'claude-opus-5-5' },
  openai:    { low: 'gpt-4o-mini', mid: 'gpt-4o', high: 'gpt-4o' },
  google:    { low: 'gemini-2.0-flash', mid: 'gemini-2.5-flash', high: 'gemini-2.5-pro' },
  mistral:   { low: 'mistral-small-latest', mid: 'mistral-medium-latest', high: 'mistral-large-latest' }
};
/* Tarifs en USD par million de jetons (entrée / sortie) — vérifiés le 12 octobre 2026. Sert à calculer le COÛT RÉEL de chaque appel
   (enveloppe mensuelle en dollars par forfait, voir SQL 3o). Surcharge possible : AI_PRICES = {"modele":[entree,sortie]}.
   Modèle inconnu = tarif prudent de 3 / 15. Haiku 5,5 coûte 5 fois plus au-delà de 100 000 jetons d'entrée : sans objet ici (messages limités à 60 000 caractères). */
const PRICES = Object.assign({
  'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20]
}, (function(){ try { return JSON.parse(process.env.AI_PRICES || '{}'); } catch (e) { return {}; } })());
function costMicro(model, tin, tout){
  const p = PRICES[model] || [3, 15];
  return Math.ceil((tin || 0) * p[0] + (tout || 0) * p[1]); /* USD par million de jetons = millionièmes de dollar par jeton */
}
const SUPPORTS_IMAGES = { anthropic: true, openai: true, google: true, mistral: false };
const ENV_PROVIDER = String(process.env.AI_PROVIDER || '').toLowerCase();
const ENV_FALLBACK = String(process.env.AI_FALLBACK || '').toLowerCase();

function available(p){ return !!(p && KEYS[p]); }
function defaultProvider(){
  if (available(ENV_PROVIDER)) return ENV_PROVIDER;
  return PROVIDER_ORDER.find(available) || null;
}
/* band : 'low' | 'mid' | 'high' */
function providerForBand(band){
  const p = String(process.env['AI_PROVIDER_' + band.toUpperCase()] || '').toLowerCase();
  return available(p) ? p : defaultProvider();
}
function modelFor(provider, band){
  const e = process.env['AI_MODEL_' + band.toUpperCase()];
  /* Un modèle imposé dans Netlify ne s'applique qu'au fournisseur choisi pour cette gamme. */
  if (e && providerForBand(band) === provider) return e;
  return DEFAULT_MODELS[provider][band];
}
function fallbackFor(primary){
  return available(ENV_FALLBACK) && ENV_FALLBACK !== primary ? ENV_FALLBACK : null;
}

/* Gamme et coût de chaque palier Hmodel (identiques à l'application). */
const TIERS = {
  dure:    { cost: 1, band: 'low',  max: 700 },
  basse:   { cost: 1, band: 'low',  max: 700 },
  lumiere: { cost: 1, band: 'low',  max: 700 },
  mediane: { cost: 2, band: 'mid',  max: 1200 },
  medium2: { cost: 2, band: 'mid',  max: 1200 },
  idee:    { cost: 2, band: 'mid',  max: 1200 },
  cover:   { cost: 2, band: 'mid',  max: 1200 },
  top:     { cost: 3, band: 'mid',  max: 2000 },
  premium: { cost: 3, band: 'mid',  max: 2000 },
  pretium: { cost: 4, band: 'high', max: 2800 },
  plafond: { cost: 5, band: 'high', max: 3500 }
};
const MAX_PROMPT_CHARS = 60000;
const MAX_IMAGE_B64 = 4500000;
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 24000;

function reply(status, obj){
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}
function svcHeaders(){
  const h = { 'Content-Type': 'application/json', apikey: SB_SECRET };
  if (!SB_SECRET.startsWith('sb_secret_')) h.Authorization = 'Bearer ' + SB_SECRET;
  return h;
}
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

const hits = new Map();
function limited(key, max, windowMs){
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) { for (const k of hits.keys()) { if (!(hits.get(k) || []).some(t => now - t < windowMs)) hits.delete(k); } }
  return arr.length > max;
}

/* Normalise les messages : rôles user/assistant strictement alternés, le premier étant « user ». */
function buildMessages(body){
  let list = [];
  if (Array.isArray(body.messages)) {
    list = body.messages.map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: typeof (m && m.content) === 'string' ? m.content : '' }));
  } else if (typeof body.prompt === 'string') {
    list = [{ role: 'user', content: body.prompt }];
  }
  list = list.filter(m => m.content.trim());
  const out = [];
  for (const m of list) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}
function total(msgs){ return msgs.reduce((n, m) => n + m.content.length, 0); }

function parseJson(text){
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (e) {}
  const a = t.search(/[\[{]/); const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return undefined;
}

/* ---------- Adaptateurs : un par fournisseur, même entrée, même sortie { text, tin, tout } ---------- */
async function postJson(url, headers, payload, signal){
  const res = await fetch(url, { method: 'POST', signal, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(payload) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) { const err = new Error('upstream ' + res.status); err.status = res.status; throw err; }
  return j;
}
const ADAPTERS = {
  async anthropic(o){
    const msgs = o.messages.map(m => ({ role: m.role, content: m.content }));
    if (o.image) { const last = msgs[msgs.length - 1];
      last.content = [{ type: 'image', source: { type: 'base64', media_type: o.image.type, data: o.image.data } }, { type: 'text', text: last.content }]; }
    const p = { model: o.model, max_tokens: o.max, messages: msgs }; if (o.system) p.system = o.system;
    const j = await postJson('https://api.anthropic.com/v1/messages', { 'x-api-key': KEYS.anthropic, 'anthropic-version': '2023-06-01' }, p, o.signal);
    const text = (Array.isArray(j.content) ? j.content : []).filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
    const u = j.usage || {}; return { text, tin: u.input_tokens || 0, tout: u.output_tokens || 0 };
  },
  async openai(o){ return openaiLike(o, 'https://api.openai.com/v1/chat/completions', KEYS.openai, true); },
  async mistral(o){ return openaiLike(o, 'https://api.mistral.ai/v1/chat/completions', KEYS.mistral, false); },
  async google(o){
    const contents = o.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    if (o.image) contents[contents.length - 1].parts.unshift({ inline_data: { mime_type: o.image.type, data: o.image.data } });
    const p = { contents, generationConfig: { maxOutputTokens: o.max } };
    if (o.system) p.systemInstruction = { parts: [{ text: o.system }] };
    const j = await postJson('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(o.model) + ':generateContent', { 'x-goog-api-key': KEYS.google }, p, o.signal);
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || [];
    const u = j.usageMetadata || {};
    return { text: parts.map(x => x.text || '').join('').trim(), tin: u.promptTokenCount || 0, tout: u.candidatesTokenCount || 0 };
  }
};
async function openaiLike(o, url, key, images){
  const msgs = [];
  if (o.system) msgs.push({ role: 'system', content: o.system });
  o.messages.forEach(m => msgs.push({ role: m.role, content: m.content }));
  if (o.image && images) { const last = msgs[msgs.length - 1];
    last.content = [{ type: 'text', text: last.content }, { type: 'image_url', image_url: { url: 'data:' + o.image.type + ';base64,' + o.image.data } }]; }
  const j = await postJson(url, { Authorization: 'Bearer ' + key }, { model: o.model, max_tokens: o.max, messages: msgs }, o.signal);
  const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const u = j.usage || {};
  return { text: (typeof c === 'string' ? c : '').trim(), tin: u.prompt_tokens || 0, tout: u.completion_tokens || 0 };
}

exports.handler = async function(event){
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method', message: 'Méthode non permise.' });
  if (!SB_SECRET || !defaultProvider()) return reply(503, { error: 'not_configured', message: 'L’assistant IA n’est pas encore configuré sur le serveur.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad_request', message: 'Requête invalide.' }); }
  if (!body || typeof body !== 'object') return reply(400, { error: 'bad_request', message: 'Requête invalide.' });

  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = /^Bearer\s+(.+)$/i.exec(auth) ? RegExp.$1.trim() : '';
  let uid = null;
  try { uid = await userIdFromToken(token); } catch (e) { return reply(502, { error: 'auth_unavailable', message: 'Vérification de la session impossible.' }); }
  if (!uid) return reply(401, { error: 'auth', message: 'Connectez-vous avec votre compte FGH-Colab pour utiliser l’assistant IA.' });
  if (limited('u:' + uid, 20, 60 * 1000)) return reply(429, { error: 'rate', message: 'Trop de demandes : patientez quelques secondes.' });

  const tierId = Object.prototype.hasOwnProperty.call(TIERS, body.tier) ? body.tier : 'mediane';
  const tier = TIERS[tierId];
  const msgs = buildMessages(body);
  if (!msgs.length) return reply(400, { error: 'bad_request', message: 'Message vide.' });
  if (total(msgs) > MAX_PROMPT_CHARS) return reply(413, { error: 'too_long', message: 'Le message est trop long.' });

  let image = null;
  if (body.image) {
    const d = body.image && typeof body.image.data === 'string' ? body.image.data : '';
    const t = body.image && body.image.type;
    if (!IMG_TYPES.includes(t) || !d || d.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(d)) return reply(400, { error: 'image_rejected', message: 'Image refusée (format ou taille).' });
    image = { type: t, data: d };
  }
  const wantJson = body.json === true;

  /* Choix du fournisseur (avant de toucher aux crédits) : principal de la gamme, puis secours éventuel. */
  let primary = providerForBand(tier.band);
  if (image && !SUPPORTS_IMAGES[primary]) primary = PROVIDER_ORDER.find(p => available(p) && SUPPORTS_IMAGES[p]) || null;
  if (!primary) return reply(400, { error: 'images_unavailable', message: 'Les images ne sont pas prises en charge par le fournisseur actuel.' });
  const attempts = [primary];
  const fb = fallbackFor(primary); if (fb && (!image || SUPPORTS_IMAGES[fb])) attempts.push(fb);

  let r;
  try { r = await svcRpc('svc_ai_reserve', { p_uid: uid, p_cost: tier.cost }); }
  catch (e) { return reply(502, { error: 'credits_unavailable', message: 'Compteur de crédits indisponible.' }); }
  if (!r || r.ok !== true) {
    if (r && r.error === 'quota') return reply(402, { error: 'quota', message: 'Crédits IA épuisés pour ce mois.', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && r.error === 'budget') return reply(402, { error: 'budget', message: 'Limite d’utilisation mensuelle atteinte pour votre forfait. Elle se réinitialise au début du mois.', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && r.error === 'not_member') return reply(403, { error: 'not_member', message: 'Créez votre compte HelpNaud (Réglages › Mon compte) pour utiliser l’assistant IA.' });
    if (r && r.error === 'suspended') return reply(403, { error: 'suspended', message: 'Compte suspendu : contactez le support.' });
    return reply(400, { error: 'bad_request', message: 'Demande refusée.' });
  }

  const refund = async () => { try { await svcRpc('svc_ai_refund', { p_uid: uid, p_cost: tier.cost }); } catch (e) {} };
  const log = async (ok, label, tin, tout) => { try { await svcRpc('svc_ai_log', { p_uid: uid, p_tier: tierId, p_cost: tier.cost, p_model: label, p_in: tin || 0, p_out: tout || 0, p_ok: ok }); } catch (e) {} };

  const system = wantJson ? 'Réponds UNIQUEMENT avec un JSON valide, sans texte avant ni après, sans bloc de code markdown.' : '';
  const deadline = Date.now() + TIMEOUT_MS;
  let lastErr = null, label = attempts[0] + ':' + modelFor(attempts[0], tier.band);
  for (const provider of attempts) {
    const model = modelFor(provider, tier.band); label = provider + ':' + model;
    const left = deadline - Date.now(); if (left < 3000) break;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), left);
    try {
      const out = await ADAPTERS[provider]({ model, max: tier.max, system, messages: msgs, image, signal: ctl.signal });
      if (!out.text) { lastErr = { code: 'empty', status: 502, message: 'Réponse vide.' }; continue; }
      let data;
      if (wantJson) { data = parseJson(out.text); if (data === undefined) { lastErr = { code: 'bad_json', status: 502, message: 'Réponse illisible, réessayez.' }; continue; } }
      try { await svcRpc('svc_ai_charge', { p_uid: uid, p_micro: costMicro(model, out.tin, out.tout) }); } catch (e) {}
      await log(true, label, out.tin, out.tout);
      return reply(200, { text: out.text, data, credits: { used: r.used, limit: r.limit, plan: r.plan } });
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? { code: 'timeout', status: 504, message: 'L’assistant IA a mis trop de temps à répondre.' } : { code: 'upstream', status: 502, message: 'L’assistant IA est momentanément indisponible.' };
    } finally { clearTimeout(timer); }
  }
  await refund(); await log(false, label, 0, 0);
  lastErr = lastErr || { code: 'timeout', status: 504, message: 'L’assistant IA a mis trop de temps à répondre.' };
  return reply(lastErr.status, { error: lastErr.code, message: lastErr.message });
};
