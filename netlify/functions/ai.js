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
  interne: { cost: 1, band: 'mid',  max: 1600 },   // F-i-Stat (équipe interne) : 1 crédit de base, modèle de gamme moyenne
  mediane: { cost: 2, band: 'mid',  max: 1600 },
  medium2: { cost: 2, band: 'mid',  max: 1600 },
  idee:    { cost: 2, band: 'mid',  max: 1600 },
  cover:   { cost: 2, band: 'mid',  max: 1600 },
  top:     { cost: 3, band: 'mid',  max: 2000 },
  premium: { cost: 3, band: 'mid',  max: 2000 },
  pretium: { cost: 4, band: 'high', max: 2800 },
  plafond: { cost: 5, band: 'high', max: 3500 }
};
const MAX_PROMPT_CHARS = 60000;
const MAX_IMAGE_B64 = 4500000;
const MAX_IMAGES = 8;
const MAX_IMAGES_TOTAL_B64 = 5200000;
/* Pièces jointes : supplément de crédits selon le « Mo équivalent » réellement traité (images envoyées + texte extrait des documents).
   1 Mo équivalent = 1 Mo d'images = 12 000 caractères de texte de document. 1 crédit par Mo équivalent commencé, jusqu'à 8 ; moins de 0,1 Mo est inclus. */
const DOC_CHARS_PER_MB = 12000, ATTACH_MIN_MB = 0.1, ATTACH_MAX_EXTRA = 8;
const DOC_MARK = '[Contenu extrait du fichier joint';
function attachExtra(images, msgs) {
  let bytes = 0; for (const im of images || []) bytes += Math.floor(im.data.length * 3 / 4);
  let chars = 0; for (const m of msgs || []) { const c = String(m.content || ''), i = c.indexOf(DOC_MARK); if (i >= 0) chars += c.length - i; }
  const mb = bytes / 1048576 + chars / DOC_CHARS_PER_MB;
  return mb < ATTACH_MIN_MB ? 0 : Math.min(ATTACH_MAX_EXTRA, Math.ceil(mb));
}   // la requête entière doit rester sous ~6 Mo (limite des fonctions Netlify)
/* ---------- Recherche adaptée / Web ----------
 * body.research = { adapted, web, public, deep, multi, strict } (validé par liste blanche).
 * Recherche web = outil web_search d'Anthropic (ANTHROPIC_API_KEY ; à activer dans la Console Anthropic).
 *  - domaine ≠ général : recherche LIMITÉE à des sources institutionnelles du domaine ;
 *  - « Web en temps réel » : Internet ouvert ; - « Données publiques » : institutions statistiques/financières.
 * Réglages facultatifs : AI_COST_ADAPTED (2), AI_COST_WEB (2), AI_WEB_MAX_USES (3), AI_RESEARCH_DOMAINS (JSON). */
const RESEARCH_PROFILES = {
  finance:    { label: 'Finance & investissement', hint: 'analyse financière, valorisation, structure de capital, risque de crédit, marchés' },
  economie:   { label: 'Économie', hint: 'macroéconomie, microéconomie, politiques économiques, indicateurs' },
  compta:     { label: 'Comptabilité, contrôle & audit', hint: 'normes IFRS et SYSCOHADA, contrôle interne, audit, états financiers' },
  droit:      { label: 'Droit des affaires & fiscalité', hint: 'droit des sociétés, contrats, fiscalité des entreprises' },
  stats:      { label: 'Statistiques & données', hint: 'méthodes statistiques, économétrie, qualité des données' },
  politiques: { label: 'Politiques publiques & développement', hint: 'évaluation de politiques, stratégies publiques, développement international' },
  entreprise: { label: 'Entreprise, PME & projets', hint: 'plan d’affaires, montage de projet, financement des PME, gestion' }
};
const INSTITUTIONS = ['bankofcanada.ca', 'statcan.gc.ca', 'finance.gc.ca', 'imf.org', 'worldbank.org', 'oecd.org', 'bis.org', 'ecb.europa.eu', 'federalreserve.gov', 'bceao.int', 'un.org'];
const RESEARCH_DOMAINS = Object.assign({
  finance:    ['bankofcanada.ca', 'finance.gc.ca', 'imf.org', 'worldbank.org', 'bis.org', 'oecd.org', 'ecb.europa.eu', 'federalreserve.gov', 'sec.gov', 'sedarplus.ca', 'lautorite.qc.ca', 'amf-france.org', 'bceao.int'],
  economie:   ['bankofcanada.ca', 'statcan.gc.ca', 'finance.gc.ca', 'imf.org', 'worldbank.org', 'oecd.org', 'wto.org', 'un.org', 'ecb.europa.eu', 'insee.fr', 'bceao.int', 'afdb.org'],
  compta:     ['ifrs.org', 'ifac.org', 'cpacanada.ca', 'ohada.org', 'iaasb.org', 'pcaobus.org', 'aicpa.org', 'revenuquebec.ca', 'canada.ca'],
  droit:      ['canlii.org', 'laws-lois.justice.gc.ca', 'legisquebec.gouv.qc.ca', 'canada.ca', 'revenuquebec.ca', 'ohada.org', 'legifrance.gouv.fr', 'service-public.fr', 'eur-lex.europa.eu', 'irs.gov'],
  stats:      ['statcan.gc.ca', 'stat.gouv.qc.ca', 'insee.fr', 'ec.europa.eu', 'data.worldbank.org', 'oecd.org', 'imf.org', 'un.org', 'census.gov'],
  politiques: ['un.org', 'undp.org', 'oecd.org', 'worldbank.org', 'afdb.org', 'imf.org', 'unesco.org', 'who.int', 'international.gc.ca', 'canada.ca', 'ec.europa.eu', 'afd.fr'],
  entreprise: ['canada.ca', 'bdc.ca', 'edc.ca', 'quebec.ca', 'revenuquebec.ca', 'oecd.org', 'worldbank.org', 'ifc.org', 'bpifrance.fr', 'service-public.fr']
}, (function(){ try { return JSON.parse(process.env.AI_RESEARCH_DOMAINS || '{}'); } catch (e) { return {}; } })());
const COST_ADAPTED = Number(process.env.AI_COST_ADAPTED) || 2, COST_WEB = Number(process.env.AI_COST_WEB) || 2, COST_PUBLIC = Number(process.env.AI_COST_PUBLIC) || 2, COST_DEEP = 4, COST_MULTI = 1;
const WEB_MAX_USES = Math.max(1, Math.min(8, Number(process.env.AI_WEB_MAX_USES) || 3));
const SEARCH_MICRO = 10000;   // ≈ 0,01 $ par recherche web
function parseResearch(raw){
  const r = raw && typeof raw === 'object' ? raw : {};
  const adapted = Object.prototype.hasOwnProperty.call(RESEARCH_PROFILES, r.adapted) ? r.adapted : 'general';
  return { adapted, web: r.web === true, pub: r.public === true, deep: r.deep === true, multi: r.multi === true, strict: r.strict === true, mode: (r.mode === 'consultant' || r.mode === 'statisticien') ? r.mode : '' };
}
function researchPlan(r){
  if (r.web) return { domains: null };
  if (r.adapted !== 'general') return { domains: RESEARCH_DOMAINS[r.adapted] || INSTITUTIONS };
  if (r.pub) return { domains: INSTITUTIONS };
  return null;
}
function researchSystem(r, searching){
  const parts = [];
  if (r.adapted !== 'general' && r.strict) {
    const p = RESEARCH_PROFILES[r.adapted];
    parts.push('MODE RECHERCHE ADAPTÉE — domaine « ' + p.label + ' » (' + p.hint + '). Réponds UNIQUEMENT aux questions qui relèvent de ce domaine. Si la question n’en relève pas, ne réponds pas sur le fond : explique en une ou deux phrases qu’elle sort du domaine choisi et invite à choisir « Générale » ou un autre domaine (ou à décocher « Limiter au domaine »).');
  }
  if (r.adapted !== 'general' && !r.strict) {
    const p = RESEARCH_PROFILES[r.adapted];
    parts.push('RECHERCHE ADAPTÉE — domaine « ' + p.label + ' ». Privilégie les sources spécialisées de ce domaine et son vocabulaire ; tu peux néanmoins répondre à une question hors domaine, en le signalant brièvement.');
  }
  if (r.web && r.adapted !== 'general') parts.push('Privilégie les sources du domaine (institutions, organismes officiels) avant les sources généralistes.');
  if (searching) parts.push('Tu disposes d’un outil de recherche web et de deux outils de données officielles (Banque mondiale, Banque du Canada) : pour un chiffre précis (PIB, inflation, taux directeur, change), utilise-les en priorité. Utilise la recherche web pour les informations récentes, chiffrées ou à vérifier ; appuie tes affirmations importantes sur les sources trouvées et indique clairement ce qui n’a pas pu être confirmé. Résume et cite, sans recopier de longs passages.');
  if (r.mode === 'consultant') parts.push('POSTURE DE CONSULTANT SENIOR. Quand la question le justifie, structure ainsi : 1) recommandation principale en tête ; 2) analyse et hypothèses annoncées ; 3) données et sources (origine et date de chaque chiffre) ; 4) risques, limites et points à vérifier ; 5) prochaines étapes concrètes. Distingue les faits sourcés, les estimations et ton opinion. Ne présente jamais comme vérifié ce que la recherche n’a pas confirmé.');
  if (r.mode === 'statisticien') parts.push('RIGUEUR DE STATISTICIEN. Précise pour chaque chiffre : définition, unité, période, source et date ; indique la méthode et les incertitudes ; distingue corrélation et causalité ; ne compare pas des séries non comparables sans le signaler ; propose des vérifications reproductibles. Ne présente jamais comme vérifié ce que la recherche n’a pas confirmé.');
  if (r.deep) parts.push('Fais une analyse approfondie et structurée.');
  if (r.multi) parts.push('Croise plusieurs sources et signale les divergences.');
  return parts.length ? ' ' + parts.join(' ') : '';
}

/* ---------- Connecteurs de données officielles (API réellement interrogées) ----------
 * 1) Banque mondiale — API Indicateurs (api.worldbank.org, gratuite, sans clé).
 * 2) Banque du Canada — API Valet (bankofcanada.ca/valet, gratuite, sans clé).
 * L'IA les appelle comme des outils ; les sources affichées sont celles réellement interrogées. */
const CONNECTOR_TOOLS = [
  { name: 'worldbank_indicator', description: 'Dernières valeurs annuelles d’un indicateur de la Banque mondiale pour un pays (ex. NY.GDP.MKTP.KD.ZG croissance du PIB, FP.CPI.TOTL.ZG inflation, SL.UEM.TOTL.ZS chômage, NY.GDP.MKTP.CD PIB courant). country : code ISO (CA, FR, SN, CI, WLD…).',
    input_schema: { type: 'object', properties: { country: { type: 'string' }, indicator: { type: 'string' }, years: { type: 'integer', description: 'nombre de valeurs récentes, 1 à 10' } }, required: ['country', 'indicator'] } },
  { name: 'bankofcanada_series', description: 'Dernières observations d’une série de la Banque du Canada (Valet). Exemples : V39079 = taux cible du financement à un jour ; FXUSDCAD = taux de change USD/CAD ; FXEURCAD = EUR/CAD.',
    input_schema: { type: 'object', properties: { series: { type: 'string' }, count: { type: 'integer', description: '1 à 12' } }, required: ['series'] } }
];
async function getJson(url, signal){
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}
async function runConnector(name, input, signal){
  input = input && typeof input === 'object' ? input : {};
  if (name === 'worldbank_indicator') {
    const c = String(input.country || ''), ind = String(input.indicator || ''), n = Math.max(1, Math.min(10, parseInt(input.years, 10) || 5));
    if (!/^[A-Za-z]{2,3}$/.test(c) || !/^[A-Za-z0-9._]{3,40}$/.test(ind)) throw new Error('paramètres invalides');
    const j = await getJson('https://api.worldbank.org/v2/country/' + c + '/indicator/' + ind + '?format=json&mrv=' + n + '&per_page=' + n, signal);
    const rows = Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [];
    if (!rows.length) throw new Error('aucune donnée');
    const lab = (rows[0].indicator && rows[0].indicator.value) || ind, pays = (rows[0].country && rows[0].country.value) || c;
    return { text: JSON.stringify({ source: 'Banque mondiale', indicateur: lab, pays, observations: rows.map(x => ({ annee: x.date, valeur: x.value })) }),
      source: { url: 'https://data.worldbank.org/indicator/' + ind + '?locations=' + c, title: 'Banque mondiale — ' + lab + ' (' + pays + ')' } };
  }
  if (name === 'bankofcanada_series') {
    const sr = String(input.series || ''), n = Math.max(1, Math.min(12, parseInt(input.count, 10) || 5));
    if (!/^[A-Za-z0-9_.]{2,40}$/.test(sr)) throw new Error('paramètres invalides');
    const j = await getJson('https://www.bankofcanada.ca/valet/observations/' + sr + '/json?recent=' + n, signal);
    const obs = Array.isArray(j && j.observations) ? j.observations : [];
    if (!obs.length) throw new Error('aucune donnée');
    const lab = (j.seriesDetail && j.seriesDetail[sr] && j.seriesDetail[sr].label) || sr;
    return { text: JSON.stringify({ source: 'Banque du Canada', serie: sr, libelle: lab, observations: obs.map(x => ({ date: x.d, valeur: x[sr] && x[sr].v })) }),
      source: { url: 'https://www.bankofcanada.ca/valet/observations/' + sr + '/json?recent=' + n, title: 'Banque du Canada — ' + lab } };
  }
  throw new Error('outil inconnu');
}
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
  return salvageReponse(t);
}
/* Réponse longue coupée par la limite de longueur au milieu de {"reponse": "…" : on referme proprement la chaîne et l'objet
   et on garde le texte reçu (mieux qu'une erreur « bad_json »). Ne s'applique qu'à ce format précis. */
function salvageReponse(t){
  const m = /^\s*\{\s*"reponse"\s*:\s*"/.exec(t);
  if (!m) return undefined;
  let body = t.slice(m[0].length), out = '', esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') break;
    out += c;
  }
  if (esc) out = out.slice(0, -1);               // antislash final orphelin
  try { const v = JSON.parse('"' + out + '"'); return v && v.trim() ? { reponse: v } : undefined; } catch (e) { return undefined; }
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
    if (o.images && o.images.length) { const last = msgs[msgs.length - 1];
      last.content = o.images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } })).concat([{ type: 'text', text: last.content }]); }
    const p = { model: o.model, max_tokens: o.max, messages: msgs }; if (o.system) p.system = o.system;
    p.tools = [];
    if (o.web) p.tools.push(Object.assign({ type: 'web_search_20250305', name: 'web_search', max_uses: o.web.maxUses }, o.web.domains && o.web.domains.length ? { allowed_domains: o.web.domains } : {}));
    if (o.connectors) CONNECTOR_TOOLS.forEach(t => p.tools.push(t));
    if (!p.tools.length) delete p.tools;
    const H = { 'x-api-key': KEYS.anthropic, 'anthropic-version': '2023-06-01' };
    let j = await postJson('https://api.anthropic.com/v1/messages', H, p, o.signal);
    let blocks = (Array.isArray(j.content) ? j.content : []).slice();
    let tin = 0, tout = 0, searches = 0, connCalls = 0;
    const connSources = [];
    const add = () => { const u = j.usage || {}; tin += u.input_tokens || 0; tout += u.output_tokens || 0; searches += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0; };
    add();
    for (let k = 0; k < 5 && (j.stop_reason === 'pause_turn' || j.stop_reason === 'tool_use'); k++) {
      const follow = p.messages.concat([{ role: 'assistant', content: j.content }]);
      if (j.stop_reason === 'tool_use') {
        const results = [];
        for (const b of (j.content || [])) {
          if (!b || b.type !== 'tool_use') continue;
          try { const r = await runConnector(b.name, b.input, o.signal); connCalls++; if (!connSources.some(x => x.url === r.source.url)) connSources.push(r.source); results.push({ type: 'tool_result', tool_use_id: b.id, content: r.text }); }
          catch (e) { if (e && e.name === 'AbortError') throw e; results.push({ type: 'tool_result', tool_use_id: b.id, content: 'Donnée indisponible (' + (e && e.message || 'erreur') + ').', is_error: true }); }
        }
        follow.push({ role: 'user', content: results });
      }
      p.messages = follow;
      j = await postJson('https://api.anthropic.com/v1/messages', H, p, o.signal);
      blocks = blocks.concat(Array.isArray(j.content) ? j.content : []); add();
    }
    const text = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
    const cited = [], found = [];
    const push = (arr, u, t) => { if (u && /^https?:\/\//i.test(u) && !arr.some(x => x.url === u)) arr.push({ url: u, title: String(t || u).slice(0, 140) }); };
    for (const b of blocks) {
      if (b && b.type === 'text' && Array.isArray(b.citations)) b.citations.forEach(c => push(cited, c && c.url, c && c.title));
      if (b && b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach(c => push(found, c && c.url, c && c.title));
    }
    connSources.forEach(c => push(cited, c.url, c.title));
    return { text, tin, tout, cut: j.stop_reason === 'max_tokens', why: String(j.stop_reason || ''), sources: cited.slice(0, 8), found: found.slice(0, 6), searches, connCalls };
  },
  async openai(o){ return openaiLike(o, 'https://api.openai.com/v1/chat/completions', KEYS.openai, true); },
  async mistral(o){ return openaiLike(o, 'https://api.mistral.ai/v1/chat/completions', KEYS.mistral, false); },
  async google(o){
    const contents = o.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    if (o.images && o.images.length) contents[contents.length - 1].parts.unshift(...o.images.map(im => ({ inline_data: { mime_type: im.type, data: im.data } })));
    const p = { contents, generationConfig: { maxOutputTokens: o.max } };
    if (o.system) p.systemInstruction = { parts: [{ text: o.system }] };
    const j = await postJson('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(o.model) + ':generateContent', { 'x-goog-api-key': KEYS.google }, p, o.signal);
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || [];
    const u = j.usageMetadata || {};
    return { text: parts.map(x => x.text || '').join('').trim(), tin: u.promptTokenCount || 0, tout: u.candidatesTokenCount || 0, cut: !!(j.candidates && j.candidates[0] && j.candidates[0].finishReason === 'MAX_TOKENS'), why: String((j.candidates && j.candidates[0] && j.candidates[0].finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || '') };
  }
};
async function openaiLike(o, url, key, images){
  const msgs = [];
  if (o.system) msgs.push({ role: 'system', content: o.system });
  o.messages.forEach(m => msgs.push({ role: m.role, content: m.content }));
  if (o.images && o.images.length && images) { const last = msgs[msgs.length - 1];
    last.content = [{ type: 'text', text: last.content }].concat(o.images.map(im => ({ type: 'image_url', image_url: { url: 'data:' + im.type + ';base64,' + im.data } }))); }
  const j = await postJson(url, { Authorization: 'Bearer ' + key }, { model: o.model, max_tokens: o.max, messages: msgs }, o.signal);
  const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const u = j.usage || {};
  return { text: (typeof c === 'string' ? c : '').trim(), tin: u.prompt_tokens || 0, tout: u.completion_tokens || 0, cut: !!(j.choices && j.choices[0] && j.choices[0].finish_reason === 'length'), why: String((j.choices && j.choices[0] && j.choices[0].finish_reason) || '') };
}


/* Alerte administrative (courriel Resend) : une fois par mois et par palier. */
async function alertAdmin(level, spent, soft, hard){
  try {
    const isNew = await svcRpc('svc_ai_alert_mark', { p_level: level });
    const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM_FINECIA || process.env.MAIL_FROM;
    if (isNew !== true || !key || !from) return;
    const to = process.env.AI_ALERT_EMAIL || 'contacts@fineciagroupe.com';
    const usd = (m) => (m / 1000000).toFixed(2) + ' $';
    const txt = { '70': 'Palier 70 % du plafond souple atteint.', '90': 'Palier 90 % atteint : les comptes gratuits sont suspendus, les abonnés continuent.', 'soft': 'Plafond souple atteint : les comptes gratuits sont suspendus, les abonnés continuent.', 'hard90': 'Attention : 90 % du plafond d’urgence atteint. Une suspension générale approche.' }[level];
    const resp = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: 'HelpNaud IA — alerte de consommation (' + level + ')', text: txt + '\n\nDépensé ce mois-ci : ' + usd(spent) + '\nPlafond souple : ' + usd(soft) + '\nPlafond d’urgence : ' + usd(hard) + '\n\nAjustez AI_GLOBAL_BUDGET_USD / AI_HARD_BUDGET_USD dans Netlify si nécessaire.' }) });
    if (!resp.ok) await svcRpc('svc_ai_alert_unmark', { p_level: level });
  } catch (e) { try { await svcRpc('svc_ai_alert_unmark', { p_level: level }); } catch (e2) {} /* l'alerte ne doit jamais bloquer une requête */ }
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

  /* Images jointes : `images` (liste, 6 max) ou, pour les anciennes versions de l'application, `image` (une seule). */
  let images = [];
  const rawImgs = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
  if (rawImgs.length > MAX_IMAGES) return reply(400, { error: 'image_rejected', message: 'Trop d\u2019images jointes (maximum ' + MAX_IMAGES + ').' });
  let totalB64 = 0;
  for (const im of rawImgs) {
    const d = im && typeof im.data === 'string' ? im.data : '';
    const t = im && im.type;
    if (!IMG_TYPES.includes(t) || !d || d.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(d)) return reply(400, { error: 'image_rejected', message: 'Image refusée (format ou taille).' });
    totalB64 += d.length;
    images.push({ type: t, data: d });
  }
  if (totalB64 > MAX_IMAGES_TOTAL_B64) return reply(413, { error: 'image_rejected', message: 'Les images jointes sont trop lourdes au total. Joignez-en moins ou des images plus petites.' });
  const image = images.length ? images : null;
  const wantJson = body.json === true;
  const research = parseResearch(body.research);
  let rplan = researchPlan(research);
  if (rplan && (wantJson || !available('anthropic'))) rplan = null;   // recherche web : Anthropic seulement, pas en mode JSON

  /* Choix du fournisseur (avant de toucher aux crédits) : principal de la gamme, puis secours éventuel. */
  let primary = providerForBand(tier.band);
  if (rplan) primary = 'anthropic';
  if (image && !SUPPORTS_IMAGES[primary]) primary = PROVIDER_ORDER.find(p => available(p) && SUPPORTS_IMAGES[p]) || null;
  if (!primary) return reply(400, { error: 'images_unavailable', message: 'Les images ne sont pas prises en charge par le fournisseur actuel.' });
  const attempts = [primary];
  const fb = fallbackFor(primary); if (fb && (!image || SUPPORTS_IMAGES[fb])) attempts.push(fb);

  // Membres de l'équipe : les outils HelpNaud exigent une autorisation en cours et une journée commencée (SQL 3t).
  // Les outils FGH-Colab restent libres. Si la fonction SQL n'est pas installée, la vérification est ignorée.
  try {
    const tool = typeof body.tool === 'string' ? body.tool.slice(0, 30) : '';
    if (tool) {
      const tk = await svcRpc('svc_member_tool_ok', { p_uid: uid, p_tool: tool });
      if (tk && tk.ok === false) {
        const msg = tk.error === 'no_workday'
          ? 'Commencez votre journée (Réglages › Ma journée) pour utiliser cet outil au nom de Finecia. En dehors des heures de travail, utilisez votre compte client personnel.'
          : 'Vous n’avez pas d’autorisation en cours pour cet outil. Demandez-la au propriétaire, ou utilisez votre compte client personnel.';
        return reply(403, { error: tk.error === 'no_workday' ? 'no_workday' : 'no_grant', message: msg });
      }
    }
  } catch (e) { /* vérification indisponible : les plafonds du pot restent actifs */ }

  // Plafond global à paliers (SQL 3q + 3y). AI_GLOBAL_BUDGET_USD = plafond souple (100 $ par défaut),
  // AI_HARD_BUDGET_USD = plafond d'urgence (3 × le souple par défaut).
  //   70 % et 90 % du souple : courriel d'alerte (une fois par mois) ;
  //   ≥ 90 % du souple : comptes gratuits suspendus, les abonnés (et l'équipe) continuent ;
  //   ≥ plafond d'urgence : suspension générale.
  try {
    const soft = Number(process.env.AI_GLOBAL_BUDGET_USD || 100) * 1000000;
    const hard = Number(process.env.AI_HARD_BUDGET_USD || 0) * 1000000 || soft * 3;
    const spent = Number(await svcRpc('svc_ai_global_cost', {}));
    if (isFinite(spent) && soft > 0) {
      const stop = (msg) => reply(503, { error: 'global_budget', message: msg });
      let level = '';
      if (spent >= hard * 0.9) level = 'hard90'; else if (spent >= soft) level = 'soft'; else if (spent >= soft * 0.9) level = '90'; else if (spent >= soft * 0.7) level = '70';
      if (level) await alertAdmin(level, spent, soft, hard);
      if (spent >= hard) return stop('Le service IA est temporairement suspendu (limite globale mensuelle atteinte). Il reprendra au début du mois.');
      if (spent >= soft * 0.9) {
        let cls = 'paid';
        try { cls = String(await svcRpc('svc_ai_caller_class', { p_uid: uid })) || 'paid'; } catch (e) { cls = 'free'; }   // 3y absent : ancien comportement (tous bloqués au plafond)
        if (cls === 'free' && spent >= soft * 0.9) return stop('L’assistant IA gratuit est momentanément suspendu (forte demande ce mois-ci). Les forfaits payants restent actifs ; il reprendra au début du mois.');
      }
    }
  } catch (e) { /* si la fonction SQL 3q n'est pas installée, les plafonds par compte restent actifs */ }

  let r;
  const rSearch = (rplan ? (research.web ? COST_WEB : 0) + (research.adapted !== 'general' ? COST_ADAPTED : 0) + (research.pub ? COST_PUBLIC : 0) : 0) ;
  const rOther = (research.deep ? COST_DEEP : 0) + (research.multi ? COST_MULTI : 0);
  const extra = attachExtra(images, msgs) + rSearch + rOther, baseCost = body.tool === 'hstatis' ? 1 : tier.cost, cost = baseCost + extra;   // F-i-Stat (outil interne de l'équipe) : 1 crédit de base
  const wantedSearch = research.web || research.pub || research.adapted !== 'general';   // coût de base du palier + supplément pièces jointes
  try { r = await svcRpc('svc_ai_reserve', { p_uid: uid, p_cost: cost }); }
  catch (e) { return reply(502, { error: 'credits_unavailable', message: 'Compteur de crédits indisponible.' }); }
  if (!r || r.ok !== true) {
    if (r && r.error === 'quota') return reply(402, { error: 'quota', message: 'Crédits IA épuisés pour ce mois.', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && r.error === 'budget') return reply(402, { error: 'budget', message: 'Limite d’utilisation mensuelle atteinte pour votre forfait. Elle se réinitialise au début du mois.', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && r.error === 'pool_quota') return reply(402, { error: 'quota', message: 'Les crédits IA communs de l’équipe sont épuisés pour ce mois. Demandez au propriétaire de les augmenter.', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && r.error === 'pool_budget') return reply(402, { error: 'budget', message: 'Le budget IA commun de l’équipe est atteint pour ce mois. Demandez au propriétaire de l’augmenter.', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && r.error === 'member_quota') return reply(402, { error: 'quota', message: 'Votre quota IA individuel est atteint pour ce mois. Demandez au propriétaire de l’ajuster.', credits: { used: r.used, limit: r.limit, plan: r.plan } });
    if (r && r.error === 'not_member') return reply(403, { error: 'not_member', message: 'Créez votre compte HelpNaud (Réglages › Mon compte) pour utiliser l’assistant IA.' });
    if (r && r.error === 'suspended') return reply(403, { error: 'suspended', message: 'Compte suspendu : contactez le support.' });
    return reply(400, { error: 'bad_request', message: 'Demande refusée.' });
  }

  const refund = async () => { try { await svcRpc('svc_ai_refund', { p_uid: uid, p_cost: cost }); } catch (e) {} };
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const spaceId = typeof body.space === 'string' && uuidRe.test(body.space) ? body.space : null;
  const project = typeof body.project === 'string' ? body.project.slice(0, 80) : '';
  // Consommation identifiée par membre, espace et projet (SQL 3w). Le serveur vérifie l'appartenance à l'espace.
  const log = async (ok, label, tin, tout, micro) => {
    const base = { p_uid: uid, p_tier: tierId, p_cost: cost, p_model: label, p_in: tin || 0, p_out: tout || 0, p_ok: ok };
    try { await svcRpc('svc_ai_log', Object.assign({}, base, { p_space: spaceId, p_project: project || null, p_micro: micro || 0 })); }
    catch (e) { try { await svcRpc('svc_ai_log', base); } catch (e2) {} }   // 3w pas encore installé : journal simple
  };

  const system = wantJson ? 'Réponds UNIQUEMENT avec un JSON valide, sans texte avant ni après, sans bloc de code markdown.' : 'Réponds en français. Pour une question simple (calcul, définition, fait précis, salutation) : le résultat d’abord en une ligne, puis 2 à 4 lignes d’explication, sans titres ni tableau ni sections « application » ou « prochaine étape », et termine par une courte phrase proposant d’approfondir. Ne développe en détail que si l’utilisateur le demande ou si la question est complexe ; dans ce cas, reste concis (environ 600 mots maximum) et termine proprement. Mise en forme : Markdown simple (titres ##, listes, **gras**, tableaux). N’utilise jamais LaTeX ni $$ : écris les formules en texte simple (ex. moyenne = (10+15+20)/3 = 15).';
  const systemFull = system + (wantJson ? '' : researchSystem(research, !!rplan));
  const deadline = Date.now() + TIMEOUT_MS;
  let webFailed = false;
  let lastErr = null, label = attempts[0] + ':' + modelFor(attempts[0], tier.band);
  for (const provider of attempts) {
    const model = modelFor(provider, tier.band); label = provider + ':' + model;
    const left = deadline - Date.now(); if (left < 3000) break;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), left);
    try {
      const maxTok = extra > 0 ? Math.max(tier.max, research.deep ? 4000 : 3000, research.mode ? 3500 : 0) : tier.max;
      const call = async () => {
        const web = rplan && provider === 'anthropic' && !webFailed ? { domains: rplan.domains, maxUses: research.mode === 'statisticien' ? 1 : Math.min(8, WEB_MAX_USES + (research.deep ? 2 : 0) + (research.mode ? 2 : 0)) } : null;
        try { return await ADAPTERS[provider]({ model, max: maxTok, system: systemFull, messages: msgs, images, web, connectors: !!web, signal: ctl.signal }); }
        catch (we) { if (!web || (we && we.name === 'AbortError')) throw we; webFailed = true; return await ADAPTERS[provider]({ model, max: maxTok, system: system + (wantJson ? '' : researchSystem(research, false)), messages: msgs, images, web: null, signal: ctl.signal }); }
      };   // analyse de pièces jointes : réponse plus longue (moins de coupures)
      let out = await call();
      if (!out.text && Date.now() < deadline - 4000) {   // réponse vide : une seule nouvelle tentative
        console.log('ai empty (retry)', label, 'stop=' + out.why, 'in=' + out.tin, 'out=' + out.tout);
        out = await call();
      }
      if (!out.text) { console.log('ai empty', label, 'stop=' + out.why, 'in=' + out.tin, 'out=' + out.tout, 'imgs=' + images.length); lastErr = { code: 'empty', status: 502, message: 'L’analyse n’a pas abouti.' }; continue; }
      let data;
      if (wantJson) { data = parseJson(out.text); if (data === undefined) { lastErr = { code: 'bad_json', status: 502, message: 'Réponse illisible, réessayez.' }; continue; } }
      const micro = costMicro(model, out.tin, out.tout) + (out.searches || 0) * SEARCH_MICRO;
      try { await svcRpc('svc_ai_charge', { p_uid: uid, p_micro: micro }); } catch (e) {}
      await log(true, label, out.tin, out.tout, micro);
      /* Recherche : suppléments annulés si aucune source n'a réellement été consultée. */
      const consulted = !!rplan && !webFailed && ((out.sources && out.sources.length) || (out.found && out.found.length) || out.searches > 0 || out.connCalls > 0);
      let refundedSearch = 0, note = '';
      if (!wantJson && wantedSearch) {
        if (!consulted) {
          refundedSearch = rSearch;
          if (refundedSearch > 0) { try { await svcRpc('svc_ai_refund', { p_uid: uid, p_cost: refundedSearch }); } catch (e) { refundedSearch = 0; } }
          note = '\n\nℹ️ **Réponse sans recherche vérifiée** : aucune source n’a pu être consultée' + (refundedSearch ? ' ; le supplément de recherche (' + refundedSearch + ' crédit' + (refundedSearch > 1 ? 's' : '') + ') a été annulé.' : '.') + ' Vérifiez les informations récentes ou chiffrées.';
        }
      }
      let finalText = (!wantJson && out.cut) ? out.text + '\n\n…(réponse tronquée par la limite de longueur : écrivez « continue » pour obtenir la suite.)' : out.text;
      const lnk = x => '- [' + x.title.replace(/[\[\]]/g, '') + '](' + x.url + ')';
      if (!wantJson && out.sources && out.sources.length) finalText += '\n\n**Sources citées**\n' + out.sources.map(lnk).join('\n');
      else if (!wantJson && out.found && out.found.length) finalText += '\n\n**Pages examinées par la recherche (non citées dans le texte)**\n' + out.found.map(lnk).join('\n');
      finalText += note;
      return reply(200, { text: finalText, data, credits: { used: Math.max(0, r.used - refundedSearch), limit: r.limit, plan: r.plan }, attachExtra: extra, charged: { model: baseCost, attachments: extra - rSearch - rOther, search: rSearch - refundedSearch, deep: research.deep ? COST_DEEP : 0, multi: research.multi ? COST_MULTI : 0, total: cost - refundedSearch, refunded: refundedSearch } });
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? { code: 'timeout', status: 504, message: 'L’assistant IA a mis trop de temps à répondre.' } : { code: 'upstream', status: 502, message: 'L’assistant IA est momentanément indisponible.' };
    } finally { clearTimeout(timer); }
  }
  await refund(); await log(false, label, 0, 0);
  lastErr = lastErr || { code: 'timeout', status: 504, message: 'L’assistant IA a mis trop de temps à répondre.' };
  return reply(lastErr.status, { error: lastErr.code, message: lastErr.message });
};
