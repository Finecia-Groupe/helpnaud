/* HelpNaud.ai — vérification de la configuration Stripe (Netlify Function, GET). Fichier : netlify/functions/stripe-check.js
 * Ouvrir https://helpnaud.ai/.netlify/functions/stripe-check : indique ce qui est configuré et quelles clés de tarif manquent.
 * Ne révèle aucune clé secrète. */
'use strict';
const L = require('./stripe-lib.js');
exports.handler = async function () {
  const out = { stripe_secret_key: !!process.env.STRIPE_SECRET_KEY, stripe_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET, supabase_secret_key: !!L.SB_SECRET,
    mode: /^[sr]k_live_/.test(process.env.STRIPE_SECRET_KEY || '') ? 'LIVE (réel)' : /^[sr]k_test_/.test(process.env.STRIPE_SECRET_KEY || '') ? 'TEST' : 'inconnu' };
  if (out.stripe_secret_key) {
    try { const p = await L.fetchPrices(L.ALL_KEYS); out.tarifs_trouves = Object.keys(p).length; out.tarifs_attendus = L.ALL_KEYS.length; out.tarifs_manquants = L.ALL_KEYS.filter(k => !p[k]); out.devises = Array.from(new Set(Object.values(p).map(x => x.currency))); }
    catch (e) { out.erreur_stripe = String(e.message).slice(0, 200); }
  }
  out.pret = out.stripe_secret_key && out.stripe_webhook_secret && out.supabase_secret_key && out.tarifs_manquants && out.tarifs_manquants.length === 0;
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(out, null, 2) };
};
