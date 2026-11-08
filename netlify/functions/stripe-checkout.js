/* HelpNaud.ai — Stripe côté navigateur (Netlify Function, HTTP POST, JSON). Fichier : netlify/functions/stripe-checkout.js
 * Actions : prices (public) · status · checkout (abonnement ou pack de crédits) · portal (gérer l'abonnement, factures, carte).
 * Le navigateur envoie le jeton de session Supabase ; l'identité vient toujours de Supabase, jamais du navigateur.
 * Variables Netlify : STRIPE_SECRET_KEY, SUPABASE_SECRET_KEY (déjà présente), SITE_URL (facultatif). */
'use strict';
const L = require('./stripe-lib.js');
const { reply, stripe, rest, eq } = L;
const hits = new Map();
function limited(k) { const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < 60000); a.push(n); hits.set(k, a); return a.length > 20; }
let priceCache = { at: 0, data: null };

async function publicPrices() {
  if (priceCache.data && Date.now() - priceCache.at < 300000) return priceCache.data;
  const p = await L.fetchPrices(L.ALL_KEYS), amt = k => p[k] ? { amount: p[k].unit_amount, currency: p[k].currency } : null;
  const data = { plans: {}, packs: {}, institution: amt(L.INSTITUTION_KEY) };
  L.PLANS.forEach(pl => { data.plans[pl] = { mensuel: amt(L.planKey(pl, 'mensuel')), annuel: amt(L.planKey(pl, 'annuel')) }; });
  L.PACKS.forEach(c => { data.packs[c] = amt(L.packKey(c)); });
  priceCache = { at: Date.now(), data };
  return data;
}
async function getRow(uid) {
  const rows = await rest('GET', 'stripe_customers?user_id=eq.' + eq(uid) + '&select=*', null);
  return rows && rows[0] || null;
}
async function ensureCustomer(user) {
  const row = await getRow(user.id);
  if (row && row.stripe_customer_id) return { id: row.stripe_customer_id, row };
  const c = await stripe('POST', 'customers', { email: user.email, metadata: { uid: user.id } });
  await rest('POST', 'stripe_customers?on_conflict=user_id', { user_id: user.id, stripe_customer_id: c.id, updated_at: new Date().toISOString() }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  return { id: c.id, row: row || null };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });
  if (!process.env.STRIPE_SECRET_KEY || !L.SB_SECRET) return reply(503, { error: 'not_configured', message: 'Le paiement en ligne n’est pas encore configuré sur le serveur.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad_request' }); }
  const action = String(body.action || '');
  try {
    if (action === 'prices') return reply(200, { ok: true, prices: await publicPrices() });

    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = /^Bearer\s+(.+)$/i.exec(auth) ? RegExp.$1.trim() : '';
    if (!token) return reply(401, { error: 'auth', message: 'Connectez-vous pour continuer.' });
    const user = await L.userFromToken(token);
    if (!user) return reply(401, { error: 'auth', message: 'Session expirée : reconnectez-vous.' });
    if (limited(user.id)) return reply(429, { error: 'rate' });

    if (action === 'status') {
      const row = await getRow(user.id);
      const acc = await rest('GET', 'ai_accounts?user_id=eq.' + eq(user.id) + '&select=plan,used,extra,period', null);
      const packs = await rest('GET', 'credit_packs?user_id=eq.' + eq(user.id) + '&remaining=gt.0&expires_at=gt.' + eq(new Date().toISOString()) + '&select=remaining,expires_at&order=expires_at', null) || [];
      return reply(200, { ok: true, plan: (acc && acc[0] && acc[0].plan) || 'gratuit', used: acc && acc[0] ? acc[0].used : 0,
        subscription: row && row.subscription_id ? { plan: row.plan, interval: row.billing_interval, status: row.status, renews: row.current_period_end, cancels: !!row.cancel_at_period_end } : null,
        hasCustomer: !!(row && row.stripe_customer_id), packCredits: packs.reduce((s, p) => s + p.remaining, 0), packExpires: packs[0] ? packs[0].expires_at : null });
    }

    if (action === 'portal') {
      const row = await getRow(user.id);
      if (!row || !row.stripe_customer_id) return reply(404, { error: 'no_customer', message: 'Aucun abonnement ni achat à gérer pour ce compte.' });
      const s = await stripe('POST', 'billing_portal/sessions', { customer: row.stripe_customer_id, return_url: L.SITE + '/?stripe=portal' });
      return reply(200, { ok: true, url: s.url });
    }

    if (action === 'checkout') {
      const kind = String(body.kind || '');
      const cust = await ensureCustomer(user);
      const base = { customer: cust.id, client_reference_id: user.id, allow_promotion_codes: true, billing_address_collection: 'auto',
        success_url: L.SITE + '/?stripe=success&kind=' + kind, cancel_url: L.SITE + '/?stripe=cancel' };
      if (kind === 'plan') {
        const plan = String(body.plan || ''), interval = String(body.interval || '');
        if (plan === 'institution') return reply(400, { error: 'quote', message: 'Le forfait Institution se fait sur devis : contactez FINECIA GROUPE.' });
        if (L.PLANS.indexOf(plan) < 0 || L.INTERVALS.indexOf(interval) < 0) return reply(400, { error: 'bad_request' });
        const row = cust.row;
        if (row && row.subscription_id && ['active', 'trialing', 'past_due'].indexOf(row.status) >= 0)
          return reply(409, { error: 'already_subscribed', message: 'Vous avez déjà un abonnement : utilisez « Gérer mon abonnement » pour changer de forfait.' });
        const key = L.planKey(plan, interval), prices = await L.fetchPrices([key]);
        if (!prices[key]) return reply(502, { error: 'price_missing', message: 'Tarif introuvable (' + key + ').' });
        const md = { uid: user.id, plan, interval };
        const s = await stripe('POST', 'checkout/sessions', Object.assign(base, { mode: 'subscription', line_items: [{ price: prices[key].id, quantity: 1 }], metadata: md, subscription_data: { metadata: md } }));
        return reply(200, { ok: true, url: s.url });
      }
      if (kind === 'pack') {
        const credits = Number(body.credits);
        if (L.PACKS.indexOf(credits) < 0) return reply(400, { error: 'bad_request' });
        const key = L.packKey(credits), prices = await L.fetchPrices([key]);
        if (!prices[key]) return reply(502, { error: 'price_missing', message: 'Tarif introuvable (' + key + ').' });
        const md = { uid: user.id, credits: String(credits) };
        const s = await stripe('POST', 'checkout/sessions', Object.assign(base, { mode: 'payment', line_items: [{ price: prices[key].id, quantity: 1 }], metadata: md, payment_intent_data: { metadata: md } }));
        return reply(200, { ok: true, url: s.url });
      }
      return reply(400, { error: 'bad_request' });
    }
    return reply(400, { error: 'bad_action' });
  } catch (e) {
    console.error('[stripe-checkout] ' + action + ' ' + (e && e.message) + ' ' + ((e && e.detail) || ''));
    return reply(502, { error: 'stripe', message: 'Le service de paiement est momentanément indisponible. Réessayez dans un instant.' });
  }
};
