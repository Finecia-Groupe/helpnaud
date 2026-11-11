/* HelpNaud.ai — utilitaires Stripe partagés (aucune dépendance npm). Fichier : netlify/functions/stripe-lib.js */
'use strict';
const SB_URL = (process.env.SUPABASE_URL || 'https://elzdsyfxpeqnrhlxbgbk.supabase.co').replace(/\/+$/, '');
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_5ZLQ6FIGJMATE6YslnS_Dw_D9x8TL7P';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SITE = (process.env.SITE_URL || 'https://helpnaud.ai').replace(/\/+$/, '');

const PLANS = ['essentiel', 'avancee', 'pro', 'affaires'];
const INTERVALS = ['mensuel', 'annuel'];
const PACKS = [100, 200, 500, 1000];
const INSTITUTION_KEY = 'helpnaud_institution_mensuel_base';
const planKey = (plan, interval) => 'helpnaud_' + plan + '_' + interval;
const packKey = credits => 'helpnaud_credits_' + credits;
const ALL_KEYS = [].concat(
  PLANS.reduce((a, p) => a.concat(INTERVALS.map(i => planKey(p, i))), []), PACKS.map(packKey), [INSTITUTION_KEY]);

/* TAISO / iTAF : abonnement par organisation (clés de recherche ops_…) */
const OPS_PLANS = ['taiso', 'itaf', 'suite'];
const opsPlanKey = (plan, interval) => 'ops_' + plan + '_' + interval;
const opsSeatKey = interval => 'ops_utilisateur_' + interval;
const OPS_LOTS = { taiso: { key: 'ops_lot_taiso_100', doc: 100, ai: 0 }, itaf: { key: 'ops_lot_itaf_10', doc: 0, ai: 10 }, suite: { key: 'ops_lot_suite', doc: 100, ai: 10 } };
const OPS_MAX_EXTRA_SEATS = 10;   // 5 inclus + 10 = 15 ; au-delà : Institution sur devis
const OPS_KEYS = [].concat(OPS_PLANS.reduce((a, p) => a.concat(INTERVALS.map(i => opsPlanKey(p, i))), []), INTERVALS.map(opsSeatKey), Object.keys(OPS_LOTS).map(k => OPS_LOTS[k].key));

const reply = (code, o) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(o) });

/* Corps « formulaire » de Stripe : { a: { b: 1 }, c: [x, y] } → a[b]=1&c[0]=x&c[1]=y */
function enc(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(k => {
    const v = obj[k]; if (v === undefined || v === null) return;
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object') ? enc(x, key + '[' + i + ']', out) : out.push(encodeURIComponent(key + '[' + i + ']') + '=' + encodeURIComponent(x)));
    else if (typeof v === 'object') enc(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
  });
  return out;
}
async function stripe(method, path, params) {
  const sk = process.env.STRIPE_SECRET_KEY || '';
  if (!sk) { const e = new Error('STRIPE_SECRET_KEY manquante'); e.code = 'not_configured'; throw e; }
  const qs = params ? enc(params).join('&') : '';
  const isGet = method === 'GET';
  const r = await fetch('https://api.stripe.com/v1/' + path + (isGet && qs ? (path.includes('?') ? '&' : '?') + qs : ''), {
    method, headers: Object.assign({ Authorization: 'Bearer ' + sk }, isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: isGet ? undefined : qs });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ('stripe ' + r.status)); e.status = r.status; e.stripe = j.error; throw e; }
  return j;
}

async function userFromToken(token) {
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_PUB, Authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id && u.email ? { id: u.id, email: u.email } : null;
}
async function rest(method, path, body, extra) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, { method, headers: Object.assign({ apikey: SB_SECRET, Authorization: 'Bearer ' + SB_SECRET, 'Content-Type': 'application/json' }, extra || {}), body: body == null ? undefined : JSON.stringify(body) });
  if (!r.ok) { const e = new Error('rest ' + r.status); e.detail = await r.text().catch(() => ''); throw e; }
  return r.status === 204 ? null : r.json().catch(() => null);
}
const rpc = (name, args) => rest('POST', 'rpc/' + name, args);
const eq = v => encodeURIComponent(v);

/* Prix publiés dans Stripe, trouvés par clé de recherche (lookup_key) — 10 clés maximum par requête. */
async function fetchPrices(keys) {
  const out = {};
  for (let i = 0; i < keys.length; i += 10) {
    const j = await stripe('GET', 'prices', { lookup_keys: keys.slice(i, i + 10), active: true, limit: 20 });
    (j.data || []).forEach(p => { out[p.lookup_key] = p; });
  }
  return out;
}
/* Forfait et rythme de facturation à partir d'un abonnement Stripe. */
function planFromSubscription(sub) {
  const item = sub && sub.items && sub.items.data && sub.items.data[0], price = item && item.price, lk = (price && price.lookup_key) || '';
  let plan = null, interval = null, m;
  if (lk === INSTITUTION_KEY) { plan = 'institution'; interval = 'mensuel'; }
  else if ((m = /^helpnaud_([a-z]+)_(mensuel|annuel)$/.exec(lk)) && PLANS.indexOf(m[1]) >= 0) { plan = m[1]; interval = m[2]; }
  const md = (sub && sub.metadata) || {};
  if (!plan && md.plan && (PLANS.indexOf(md.plan) >= 0 || md.plan === 'institution')) plan = md.plan;
  if (!interval) interval = price && price.recurring ? (price.recurring.interval === 'year' ? 'annuel' : 'mensuel') : (md.interval || null);
  return { plan, interval };
}
/* Forfait d'organisation, rythme et sièges supplémentaires à partir d'un abonnement Stripe. */
function opsFromSubscription(sub) {
  const items = (sub && sub.items && sub.items.data) || [];
  let plan = null, interval = null, extra = 0, m;
  items.forEach(it => {
    const lk = (it.price && it.price.lookup_key) || '';
    if ((m = /^ops_(taiso|itaf|suite)_(mensuel|annuel)$/.exec(lk))) { plan = m[1]; interval = m[2]; }
    else if (/^ops_utilisateur_(mensuel|annuel)$/.test(lk)) extra += Number(it.quantity || 0);
  });
  return { plan, interval, extra };
}
const isOpsSubscription = sub => !!((sub && sub.metadata && sub.metadata.org_id) || ((sub && sub.items && sub.items.data) || []).some(it => /^ops_/.test((it.price && it.price.lookup_key) || '')));

/* Case obligatoire « J'accepte les conditions d'utilisation » au paiement (URL des conditions à déclarer dans Stripe).
 * Désactivable sans changer le code : variable Netlify STRIPE_REQUIRE_TERMS = 0. */
const CONSENT = process.env.STRIPE_REQUIRE_TERMS === '0' ? {} : { consent_collection: { terms_of_service: 'required' } };

module.exports = { CONSENT, OPS_PLANS, OPS_LOTS, OPS_KEYS, OPS_MAX_EXTRA_SEATS, opsPlanKey, opsSeatKey, opsFromSubscription, isOpsSubscription, SB_URL, SB_PUB, SB_SECRET, SITE, PLANS, INTERVALS, PACKS, INSTITUTION_KEY, ALL_KEYS, planKey, packKey, reply, stripe, userFromToken, rest, rpc, eq, fetchPrices, planFromSubscription };
