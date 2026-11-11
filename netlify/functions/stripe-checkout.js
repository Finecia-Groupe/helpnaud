/* HelpNaud.ai — Stripe côté navigateur (Netlify Function, HTTP POST, JSON). Fichier : netlify/functions/stripe-checkout.js
 * Actions : prices (public) · status · checkout (abonnement ou pack de crédits) · portal (gérer l'abonnement, factures, carte)
 * · TAISO/iTAF (par organisation) : ops_prices (public) · ops_status · ops_checkout (abonnement ou lot) · ops_seats · ops_portal.
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

/* ---------- TAISO / iTAF : abonnement par organisation ---------- */
let opsPriceCache = { at: 0, data: null };
async function opsPublicPrices() {
  if (opsPriceCache.data && Date.now() - opsPriceCache.at < 300000) return opsPriceCache.data;
  const p = await L.fetchPrices(L.OPS_KEYS), amt = k => p[k] ? { amount: p[k].unit_amount, currency: p[k].currency } : null;
  const data = { plans: {}, seat: {}, lots: {} };
  L.OPS_PLANS.forEach(pl => { data.plans[pl] = { mensuel: amt(L.opsPlanKey(pl, 'mensuel')), annuel: amt(L.opsPlanKey(pl, 'annuel')) }; });
  L.INTERVALS.forEach(i => { data.seat[i] = amt(L.opsSeatKey(i)); });
  Object.keys(L.OPS_LOTS).forEach(k => { data.lots[k] = amt(L.OPS_LOTS[k].key); });
  opsPriceCache = { at: Date.now(), data };
  return data;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/* L'organisation doit exister et l'appelant en être administrateur actif (vérifié côté serveur, jamais d'après le navigateur). */
async function adminOrg(user, orgId) {
  if (!UUID.test(String(orgId || ''))) return null;
  const m = await rest('GET', 'ops_members?org_id=eq.' + eq(orgId) + '&user_id=eq.' + eq(user.id) + '&active=eq.true&role=eq.admin&select=id', null);
  if (!m || !m.length) return null;
  const o = await rest('GET', 'ops_orgs?id=eq.' + eq(orgId) + '&select=id,name,paid_until,stripe_subscription,stripe_customer,seats', null);
  return o && o[0] || null;
}
const orgActive = o => !!(o.stripe_subscription && o.paid_until && new Date(o.paid_until) > new Date());
async function opsAction(action, body, user) {
  const org = await adminOrg(user, body.org_id);
  if (!org) return reply(403, { error: 'forbidden', message: 'Réservé à l’administrateur de l’organisation.' });
  if (action === 'ops_status') return reply(200, { ok: true, subscribed: orgActive(org), hasCustomer: !!org.stripe_customer, seats: org.seats, extraSeats: Math.max(0, (org.seats || 5) - 5), paidUntil: org.paid_until });
  if (action === 'ops_portal') {
    if (!org.stripe_customer) return reply(404, { error: 'no_customer', message: 'Aucun abonnement à gérer pour cette organisation.' });
    const s = await stripe('POST', 'billing_portal/sessions', { customer: org.stripe_customer, return_url: L.SITE + '/?stripe=portal' });
    return reply(200, { ok: true, url: s.url });
  }
  if (action === 'ops_seats') {
    const extra = Math.floor(Number(body.extra));
    if (!(extra >= 0 && extra <= L.OPS_MAX_EXTRA_SEATS)) return reply(400, { error: 'seats', message: 'Jusqu’à ' + L.OPS_MAX_EXTRA_SEATS + ' utilisateurs supplémentaires (15 au total). Au-delà : offre Institution sur devis.' });
    if (!orgActive(org)) return reply(409, { error: 'no_subscription', message: 'Un abonnement actif est nécessaire pour ajouter des utilisateurs.' });
    const mem = await rest('GET', 'ops_members?org_id=eq.' + eq(org.id) + '&active=eq.true&user_id=not.is.null&select=id', null);
    if ((mem || []).length > 5 + extra) return reply(409, { error: 'members', message: 'Cette organisation compte déjà ' + mem.length + ' comptes actifs : retirez-en avant de réduire les utilisateurs.' });
    const sub = await stripe('GET', 'subscriptions/' + org.stripe_subscription, {});
    const pi = L.opsFromSubscription(sub);
    if (!pi.plan) return reply(409, { error: 'no_subscription', message: 'Abonnement TAISO/iTAF introuvable.' });
    const seatItem = ((sub.items && sub.items.data) || []).filter(it => /^ops_utilisateur_/.test((it.price && it.price.lookup_key) || ''))[0];
    let items;
    if (seatItem) items = extra === 0 ? [{ id: seatItem.id, deleted: true }] : [{ id: seatItem.id, quantity: extra }];
    else if (extra === 0) return reply(200, { ok: true, unchanged: true });
    else { const sk = L.opsSeatKey(pi.interval), pr = await L.fetchPrices([sk]); if (!pr[sk]) return reply(502, { error: 'price_missing', message: 'Tarif introuvable (' + sk + ').' }); items = [{ price: pr[sk].id, quantity: extra }]; }
    // Ajout : le prorata du temps restant est facturé et payé tout de suite (le changement échoue si le paiement échoue).
    // Réduction : aucun crédit ni remboursement (évite d'ajouter des utilisateurs puis de les retirer en fin de période).
    const up = extra > pi.extra ? { proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' } : { proration_behavior: 'none' };
    await stripe('POST', 'subscriptions/' + sub.id, Object.assign({ items }, up));
    return reply(200, { ok: true });   // le webhook met à jour le nombre de sièges de l'organisation
  }
  if (action === 'ops_checkout') {
    const kind = String(body.kind || ''), cust = await ensureCustomer(user);
    const base = { customer: cust.id, client_reference_id: user.id, allow_promotion_codes: true, billing_address_collection: 'auto', cancel_url: L.SITE + '/?stripe=cancel' };
    if (kind === 'plan') {
      const plan = String(body.plan || ''), interval = String(body.interval || ''), extra = Math.floor(Number(body.extra_seats || 0));
      if (L.OPS_PLANS.indexOf(plan) < 0 || L.INTERVALS.indexOf(interval) < 0 || !(extra >= 0 && extra <= L.OPS_MAX_EXTRA_SEATS)) return reply(400, { error: 'bad_request', message: 'Demande invalide (jusqu’à ' + L.OPS_MAX_EXTRA_SEATS + ' utilisateurs supplémentaires ; au-delà : Institution sur devis).' });
      if (orgActive(org)) return reply(409, { error: 'already_subscribed', message: 'Cette organisation a déjà un abonnement : utilisez « Gérer l’abonnement » pour le modifier.' });
      const keys = [L.opsPlanKey(plan, interval)].concat(extra > 0 ? [L.opsSeatKey(interval)] : []), prices = await L.fetchPrices(keys);
      const miss = keys.filter(k => !prices[k])[0]; if (miss) return reply(502, { error: 'price_missing', message: 'Tarif introuvable (' + miss + ').' });
      const li = [{ price: prices[keys[0]].id, quantity: 1 }].concat(extra > 0 ? [{ price: prices[keys[1]].id, quantity: extra }] : []);
      const md = { uid: user.id, org_id: org.id, plan, interval };
      const s = await stripe('POST', 'checkout/sessions', Object.assign(base, { mode: 'subscription', line_items: li, metadata: md, subscription_data: { metadata: md }, success_url: L.SITE + '/?stripe=success&kind=ops_plan' }));
      return reply(200, { ok: true, url: s.url });
    }
    if (kind === 'lot') {
      const lot = String(body.lot || ''), def = L.OPS_LOTS[lot];
      if (!def) return reply(400, { error: 'bad_request' });
      if (!orgActive(org)) return reply(409, { error: 'no_subscription', message: 'Les lots supplémentaires sont réservés aux organisations avec un abonnement actif.' });
      const prices = await L.fetchPrices([def.key]);
      if (!prices[def.key]) return reply(502, { error: 'price_missing', message: 'Tarif introuvable (' + def.key + ').' });
      const md = { uid: user.id, org_id: org.id, lot };
      const s = await stripe('POST', 'checkout/sessions', Object.assign(base, { mode: 'payment', line_items: [{ price: prices[def.key].id, quantity: 1 }], metadata: md, payment_intent_data: { metadata: md }, success_url: L.SITE + '/?stripe=success&kind=ops_lot' }));
      return reply(200, { ok: true, url: s.url });
    }
    return reply(400, { error: 'bad_request' });
  }
  return reply(400, { error: 'bad_action' });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });
  if (!process.env.STRIPE_SECRET_KEY || !L.SB_SECRET) return reply(503, { error: 'not_configured', message: 'Le paiement en ligne n’est pas encore configuré sur le serveur.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'bad_request' }); }
  const action = String(body.action || '');
  try {
    if (action === 'prices') return reply(200, { ok: true, prices: await publicPrices() });
    if (action === 'ops_prices') return reply(200, { ok: true, prices: await opsPublicPrices() });

    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = /^Bearer\s+(.+)$/i.exec(auth) ? RegExp.$1.trim() : '';
    if (!token) return reply(401, { error: 'auth', message: 'Connectez-vous pour continuer.' });
    const user = await L.userFromToken(token);
    if (!user) return reply(401, { error: 'auth', message: 'Session expirée : reconnectez-vous.' });
    if (limited(user.id)) return reply(429, { error: 'rate' });

    if (/^ops_/.test(action)) return opsAction(action, body, user);

    if (action === 'status') {
      const row = await getRow(user.id);
      const acc = await rest('GET', 'ai_accounts?user_id=eq.' + eq(user.id) + '&select=plan,used,extra,period', null);
      const packs = await rest('GET', 'credit_packs?user_id=eq.' + eq(user.id) + '&remaining=gt.0&expires_at=gt.' + eq(new Date().toISOString()) + '&select=remaining,expires_at&order=expires_at', null) || [];
      return reply(200, { ok: true, plan: (acc && acc[0] && acc[0].plan) || 'gratuit', used: acc && acc[0] ? acc[0].used : 0,
        subscription: row && row.subscription_id && ['active', 'trialing', 'past_due'].indexOf(row.status) >= 0 ? { plan: row.plan, interval: row.billing_interval, status: row.status, renews: row.current_period_end, cancels: !!row.cancel_at_period_end } : null,
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
