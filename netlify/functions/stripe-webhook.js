/* HelpNaud.ai — webhook Stripe (Netlify Function). Fichier : netlify/functions/stripe-webhook.js
 * URL à déclarer dans Stripe : https://helpnaud.ai/.netlify/functions/stripe-webhook
 * Événements : checkout.session.completed, checkout.session.async_payment_succeeded, customer.subscription.created,
 *   customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed, charge.refunded.
 * Variables Netlify : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (whsec_…), SUPABASE_SECRET_KEY.
 * Sécurité : signature vérifiée (HMAC-SHA256, tolérance 5 min) ; chaque événement n'est traité qu'une fois (table stripe_events). */
'use strict';
const crypto = require('crypto');
const L = require('./stripe-lib.js');
const { reply, stripe, rest, rpc, eq } = L;

function verify(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = {}; String(header).split(',').forEach(p => { const i = p.indexOf('='); if (i > 0) (parts[p.slice(0, i).trim()] = parts[p.slice(0, i).trim()] || []).push(p.slice(i + 1).trim()); });
  const t = Number((parts.t || [])[0]); if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const exp = crypto.createHmac('sha256', secret).update(t + '.' + raw, 'utf8').digest('hex');
  return (parts.v1 || []).some(s => s.length === exp.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp)));
}
const iso = s => s ? new Date(s * 1000).toISOString() : null;
async function rowByCustomer(cid) { const r = await rest('GET', 'stripe_customers?stripe_customer_id=eq.' + eq(cid) + '&select=*', null); return r && r[0] || null; }
async function rowByUser(uid) { const r = await rest('GET', 'stripe_customers?user_id=eq.' + eq(uid) + '&select=*', null); return r && r[0] || null; }
const upsert = row => rest('POST', 'stripe_customers?on_conflict=user_id', Object.assign({ updated_at: new Date().toISOString() }, row), { Prefer: 'resolution=merge-duplicates,return=minimal' });

/* Applique l'état d'un abonnement Stripe au compte HelpNaud. */
async function applySubscription(sub) {
  const md = sub.metadata || {}, customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
  let uid = md.uid || null, stored = null;
  if (customerId) stored = await rowByCustomer(customerId);
  if (!uid && stored) uid = stored.user_id;
  if (!uid) throw new Error('abonnement sans utilisateur : ' + sub.id);
  if (!stored) stored = await rowByUser(uid);
  const pi = L.planFromSubscription(sub);
  const st = sub.status, live = st === 'active' || st === 'trialing', dead = st === 'canceled' || st === 'unpaid' || st === 'incomplete_expired';
  const base = { user_id: uid, stripe_customer_id: customerId || undefined, subscription_id: sub.id, status: st, current_period_end: iso(sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end)),
    cancel_at_period_end: !!(sub.cancel_at_period_end || sub.cancel_at), meta: md };   // l'API récente renseigne « cancel_at » (date) pour une annulation programmée
  if (live) {
    if (!pi.plan) throw new Error('forfait introuvable pour ' + sub.id);
    await rpc('svc_stripe_set_plan', { p_uid: uid, p_plan: pi.plan });
    await upsert(Object.assign(base, { plan: pi.plan, billing_interval: pi.interval, needs_review: pi.plan === 'institution' }));
    return 'plan ' + pi.plan;
  }
  if (dead) {
    // Un ancien abonnement qui se termine ne doit pas rétrograder un abonnement plus récent encore actif.
    if (stored && stored.subscription_id && stored.subscription_id !== sub.id && ['active', 'trialing', 'past_due'].indexOf(stored.status) >= 0) return 'ancien abonnement ignoré';
    await rpc('svc_stripe_set_plan', { p_uid: uid, p_plan: 'gratuit' });
    await upsert(Object.assign(base, { plan: 'gratuit' }));
    return 'retour au forfait gratuit';
  }
  await upsert(base);   // past_due, incomplete… : on garde le forfait actuel (période de grâce gérée par Stripe) et on note l'état
  return 'état ' + st;
}

async function handle(ev) {
  const o = ev.data.object;
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const uid = o.client_reference_id || (o.metadata && o.metadata.uid);
      if (!uid) throw new Error('session sans utilisateur : ' + o.id);
      if (o.customer) await upsert({ user_id: uid, stripe_customer_id: o.customer });
      if (o.mode === 'subscription' && o.subscription) return applySubscription(await stripe('GET', 'subscriptions/' + o.subscription, {}));
      if (o.mode === 'payment') {
        if (o.payment_status !== 'paid') return 'paiement non encore reçu';
        const credits = Number(o.metadata && o.metadata.credits);
        if (L.PACKS.indexOf(credits) < 0) throw new Error('pack inconnu : ' + (o.metadata && o.metadata.credits));
        const added = await rpc('svc_stripe_add_pack', { p_uid: uid, p_credits: credits, p_session: o.id, p_months: 12 });
        return added ? credits + ' crédits ajoutés' : 'pack déjà ajouté';
      }
      return 'rien à faire';
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return applySubscription(ev.type === 'customer.subscription.deleted' ? Object.assign({}, o, { status: 'canceled' }) : o);
    case 'invoice.payment_failed': {
      if (o.customer) { const r = await rowByCustomer(o.customer); if (r) await upsert({ user_id: r.user_id, status: 'past_due' }); }
      return 'paiement échoué noté';
    }
    case 'invoice.paid': {
      const sid = o.subscription || (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription);
      if (sid) return applySubscription(await stripe('GET', 'subscriptions/' + sid, {}));
      return 'facture sans abonnement';
    }
    case 'charge.refunded': {
      // Remboursement total d'un pack : les crédits restants du pack sont retirés (les crédits déjà utilisés ne peuvent pas être repris).
      if (!o.payment_intent) return 'remboursement sans paiement associé';
      if (!(o.refunded || (o.amount_refunded && o.amount_refunded >= o.amount))) return 'remboursement partiel : aucun crédit retiré';
      const list = await stripe('GET', 'checkout/sessions', { payment_intent: o.payment_intent, limit: 1 });
      const sess = list && list.data && list.data[0];
      if (!sess || sess.mode !== 'payment') return 'remboursement hors pack';
      const removed = await rpc('svc_stripe_revoke_pack', { p_session: sess.id });
      return removed + ' crédits retirés (pack remboursé)';
    }
    default: return 'ignoré';
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret || !L.SB_SECRET || !process.env.STRIPE_SECRET_KEY) return reply(503, { error: 'not_configured' });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const sig = event.headers && (event.headers['stripe-signature'] || event.headers['Stripe-Signature']);
  if (!verify(raw, sig, secret)) return reply(400, { error: 'signature' });
  let ev; try { ev = JSON.parse(raw); } catch (e) { return reply(400, { error: 'json' }); }
  try {
    const ins = await rest('POST', 'stripe_events?on_conflict=event_id', { event_id: ev.id, type: ev.type }, { Prefer: 'resolution=ignore-duplicates,return=representation' });
    if (!ins || !ins.length) return reply(200, { ok: true, duplicate: true });
  } catch (e) { console.error('[stripe-webhook] journal ' + e.message); return reply(500, { error: 'store' }); }
  try {
    const what = await handle(ev);
    console.log('[stripe-webhook] ' + ev.type + ' ' + ev.id + ' → ' + what);
    return reply(200, { ok: true, result: what });
  } catch (e) {
    console.error('[stripe-webhook] ' + ev.type + ' ' + ev.id + ' ÉCHEC ' + (e && e.message) + ' ' + ((e && e.detail) || ''));
    try { await rest('DELETE', 'stripe_events?event_id=eq.' + eq(ev.id), null, { Prefer: 'return=minimal' }); } catch (e2) {}   // Stripe réessaiera
    return reply(500, { error: 'handler' });
  }
};
