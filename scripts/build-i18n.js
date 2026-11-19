#!/usr/bin/env node
/* HelpNaud.ai — préparation des traductions de l'interface (hors ligne, avant mise en ligne).
   Les traductions sont fabriquées ICI, puis publiées comme fichiers statiques /i18n/<langue>.json.
   Le site n'appelle plus aucun service de traduction pendant l'utilisation.

   Usage :
     ANTHROPIC_API_KEY=… node scripts/build-i18n.js en            # une langue
     ANTHROPIC_API_KEY=… node scripts/build-i18n.js en de es-419  # plusieurs
     node scripts/build-i18n.js --check                           # sans clé : manques / obsolètes / langues prêtes (pour CI)
   Options : --force (retraduit tout), --model=claude-haiku-4-5, --concurrency=4
   Variables : ANTHROPIC_API_KEY (jamais dans un fichier), ANTHROPIC_BASE_URL (tests), PRICE_IN / PRICE_OUT ($ par million de jetons).

   Fichiers :
     i18n/source.json            phrases françaises (node scripts/extract-i18n.js)
     i18n/<lang>.json            { lang, v, tr:{ phrase française: traduction } }
     i18n/glossary-<lang>.json   corrections validées par un humain : PRIORITAIRES, jamais écrasées
     i18n/review.json            { <lang>: { reviewer, date, sensible: true } }  → langue « Vérifiée » seulement si présent
     i18n/manifest.json          état publié (v, langues, statut, nombre de phrases manquantes)
     i18n/cost-report.json       jetons et coût RÉELS mesurés lors des exécutions
   Renouvellement : la clé est le texte français lui-même. Si un texte change, l'ancienne entrée devient obsolète (retirée)
   et la nouvelle est traduite à la prochaine exécution ; rien d'autre n'est retraduit. */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DIR = path.join(__dirname, '..', 'i18n');
const NAMES = { en:'English (United States)', 'es-419':'Latin American Spanish', 'es-ES':'Spanish (Spain)', de:'German', it:'Italian', 'pt-BR':'Brazilian Portuguese', 'pt-PT':'European Portuguese', nl:'Dutch', ar:'Arabic', he:'Hebrew', fa:'Persian', ur:'Urdu', 'zh-Hans':'Simplified Chinese', 'zh-Hant':'Traditional Chinese', ja:'Japanese', ko:'Korean', hi:'Hindi', ru:'Russian', uk:'Ukrainian', pl:'Polish', tr:'Turkish', vi:'Vietnamese', id:'Indonesian', th:'Thai', sv:'Swedish', da:'Danish', nb:'Norwegian Bokmål', fi:'Finnish', el:'Greek', cs:'Czech', sk:'Slovak', ro:'Romanian', hu:'Hungarian', bg:'Bulgarian', hr:'Croatian', sl:'Slovenian', sr:'Serbian (Cyrillic)', ca:'Catalan', lt:'Lithuanian', lv:'Latvian', et:'Estonian', ms:'Malay', fil:'Filipino', bn:'Bangla (Bengali)', ta:'Tamil', te:'Telugu', mr:'Marathi', gu:'Gujarati', kn:'Kannada', ml:'Malayalam', pa:'Punjabi', sw:'Swahili', ha:'Hausa', am:'Amharic', bho:'Bhojpuri' };
const BRANDS = ['HelpNaud', 'HelpNaud.ai', 'FINECIA', 'Stripe', 'Consult', 'Image IA', 'Design', 'Dessiner', 'Supabase', 'Claude'];
const args = process.argv.slice(2), flag = (n) => args.includes('--' + n), opt = (n, d) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : d; };
const langs = args.filter((a) => !a.startsWith('--'));
const MODEL = opt('model', process.env.TRANSLATE_MODEL || 'claude-haiku-4-5'), CONC = +opt('concurrency', 4);
if (!Number.isInteger(CONC) || CONC < 1 || CONC > 16) { console.error('--concurrency doit être un entier de 1 à 16'); process.exit(1); }
const PRICE_IN = +(process.env.PRICE_IN || 1), PRICE_OUT = +(process.env.PRICE_OUT || 5); // $/M jetons — À VÉRIFIER sur la grille tarifaire en vigueur
const BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { return d; } };
const wr = (f, o) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(o));
const wrp = (f, o) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(o, null, 2));
const source = rd('source.json', []);
if (!source.length) { console.error('i18n/source.json absent : lancez d\'abord  node scripts/extract-i18n.js'); process.exit(1); }
const srcVersion = crypto.createHash('sha1').update(source.join('\n')).digest('hex').slice(0, 10);

/* contrôle d'intégrité : ce qui ne doit pas changer doit rester identique */
function tokens(s){
  const t = [];
  t.push('n:' + s.replace(/\D/g, '')); // suite de chiffres inchangée (les séparateurs 1 250 / 1,250 peuvent s'adapter à la langue)
  (s.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).forEach((x) => t.push('e:' + x.toLowerCase()));
  (s.match(/https?:\/\/[^\s)»"']+/g) || []).forEach((x) => t.push('u:' + x));
  (s.match(/\{[^}]*\}|%[sd]|\$\{[^}]*\}/g) || []).forEach((x) => t.push('p:' + x));
  BRANDS.forEach((b) => { if (new RegExp('\\b' + b.replace('.', '\\.') + '\\b').test(s)) t.push('b:' + b); });
  return t.sort().join('|');
}
function valid(src, tr){
  if (typeof tr !== 'string' || !tr.trim()) return 'vide';
  if (tr.length > src.length * 4 + 40) return 'trop long';
  if (tokens(src) !== tokens(tr)) return 'chiffres/adresses/marques modifiés';
  if (/^\s|\s$/.test(src) !== /^\s|\s$/.test(tr) && false) return 'espaces';
  return null;
}

async function callApi(lang, items, stats){
  const sys = 'You translate the user-interface strings of HelpNaud.ai (a French-language AI assistant for finance, business and personal-finance work) from French into ' + NAMES[lang] + '.\n' +
    'Rules: translate meaning naturally for a UI; keep the length reasonable; keep every number, currency amount, e-mail address, URL, placeholder ({…}, %s), emoji and punctuation such as "…" and ":" where meaningful; keep these names untranslated: ' + BRANDS.join(', ') + '. ' +
    'Never translate or alter proper nouns of people or companies. Strings may be fragments of a longer sentence (leading/trailing space, ending with a colon or an opening quote): keep fragments as fragments and keep their leading/trailing spaces. Use Western digits (0-9). Legal, billing, credit, payment, deletion and permission wording must be precise and literal, never softened.\n' +
    'Input: a JSON array of strings. Output: ONLY a JSON array of the same length, same order, each item the translation of the item at the same index. No commentary.';
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(BASE + '/v1/messages', { method: 'POST', signal: AbortSignal.timeout(120000), headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 8000, temperature: 0, system: sys, messages: [{ role: 'user', content: JSON.stringify(items) }] }) });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const d = await r.json(); stats.in += (d.usage && d.usage.input_tokens) || 0; stats.out += (d.usage && d.usage.output_tokens) || 0; stats.calls++;
      if (d.stop_reason === 'max_tokens') { const e = new Error('réponse tronquée (max_tokens)'); e.splitBatch = true; throw e; }
      const txt = (d.content || []).filter((c) => c.type === 'text' || (!c.type && typeof c.text === 'string')).map((c) => c.text || '').join('').trim();
      // Accepter un tableau strict, éventuellement entouré d'une clôture Markdown.
      // Ne jamais réparer silencieusement des guillemets ou du contenu traduit.
      const clean = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      let arr;
      try { arr = JSON.parse(clean); }
      catch (_) { const e = new Error('JSON de traduction invalide'); e.splitBatch = true; throw e; }
      if (!Array.isArray(arr) || arr.length !== items.length) { const e = new Error('réponse de longueur inattendue'); e.splitBatch = true; throw e; }
      return arr;
    } catch (e) { if (e.splitBatch || /^HTTP 4(?!29)/.test(e.message) || t === 3) throw e; await new Promise((ok) => setTimeout(ok, 1500 * (t + 1))); }
  }
}

function batches(list){ const out = []; let cur = [], n = 0; list.forEach((s) => { if (cur.length >= 50 || n + s.length > 6000) { out.push(cur); cur = []; n = 0; } cur.push(s); n += s.length; }); if (cur.length) out.push(cur); return out; }

async function build(lang){
  if (!NAMES[lang]) { console.error('Langue non prévue : ' + lang); return null; }
  const cur = rd(lang + '.json', { tr: {} }), gloss = rd('glossary-' + lang + '.json', {}), tr = {};
  const live = new Set(source);
  Object.keys(cur.tr || {}).forEach((k) => { if (live.has(k) && !flag('force')) tr[k] = cur.tr[k]; });
  Object.keys(gloss).forEach((k) => { if (live.has(k)) tr[k] = gloss[k]; });
  const obsolete = Object.keys(cur.tr || {}).filter((k) => !live.has(k)).length;
  const todo = source.filter((s) => !tr[s]);
  const stats = { in: 0, out: 0, calls: 0 }, errors = {};
  console.log(lang + ' : ' + Object.keys(tr).length + ' déjà prêtes, ' + todo.length + ' à traduire, ' + obsolete + ' obsolètes retirées');
  if (todo.length) {
    if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY absente : traduction impossible (variable d\'environnement uniquement, jamais dans un fichier).'); return null; }
    const bs = batches(todo); let i = 0, done = 0, fatal = null;
    const checkpoint = () => {
      const ordered = {}; source.forEach((s) => { if (tr[s]) ordered[s] = tr[s]; });
      const target = path.join(DIR, lang + '.json'), temp = target + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({ lang, v: srcVersion, tr: ordered }));
      fs.renameSync(temp, target);
    };
    async function translateBatch(b) {
      if (fatal) return;
      let res;
      try { res = await callApi(lang, b, stats); }
      catch (e) {
        if (/^HTTP 4(?!29)/.test(e.message)) fatal = e;
        if (e.splitBatch && b.length > 1 && !fatal) {
          const mid = Math.ceil(b.length / 2);
          await translateBatch(b.slice(0, mid));
          await translateBatch(b.slice(mid));
          return;
        }
        // Une dernière tentative isolée, sans boucle illimitée.
        if (e.splitBatch && b.length === 1) {
          try { res = await callApi(lang, b, stats); }
          catch (last) { errors[b[0]] = String(last.message || last); if (/^HTTP 4(?!29)/.test(last.message)) fatal = last; return; }
        } else { b.forEach((s) => { errors[s] = String(e.message || e); }); return; }
      }
      for (let k = 0; k < b.length; k++) {
        const s = b[k], why = valid(s, res[k]);
        if (!why) { tr[s] = res[k]; delete errors[s]; continue; }
        if (fatal) { errors[s] = why; continue; }
        try {
          const r2 = await callApi(lang, [s], stats), w2 = valid(s, r2[0]);
          if (!w2) { tr[s] = r2[0]; delete errors[s]; } else errors[s] = w2;
        } catch (e) {
          errors[s] = String(e.message || e);
          if (/^HTTP 4(?!29)/.test(e.message)) fatal = e;
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (i < bs.length && !fatal) {
        const b = bs[i++];
        await translateBatch(b);
        checkpoint();
        done += b.length; process.stdout.write('\r' + lang + ' : ' + done + '/' + todo.length);
      }
    }));
    if (fatal) {
      todo.forEach((s) => { if (!tr[s] && !errors[s]) errors[s] = 'Non traité après arrêt : ' + fatal.message; });
      console.error('\nArrêt des nouveaux lots : ' + fatal.message);
      process.exitCode = 1;
    }
    process.stdout.write('\n');
  }
  const ordered = {}; source.forEach((s) => { if (tr[s]) ordered[s] = tr[s]; });
  wr(lang + '.json', { lang, v: srcVersion, tr: ordered });
  if (Object.keys(errors).length) wrp(lang + '.errors.json', errors); else try { fs.unlinkSync(path.join(DIR, lang + '.errors.json')); } catch (e) {}
  const cost = (stats.in * PRICE_IN + stats.out * PRICE_OUT) / 1e6;
  if (stats.calls) { const rep = rd('cost-report.json', { runs: [] }); rep.runs.push({ lang, date: new Date().toISOString(), model: MODEL, phrases: todo.length, appels: stats.calls, jetons_entree: stats.in, jetons_sortie: stats.out, prix_entree_par_M: PRICE_IN, prix_sortie_par_M: PRICE_OUT, cout_usd: +cost.toFixed(4) }); wrp('cost-report.json', rep);
    console.log(lang + ' : ' + stats.calls + ' appels, ' + stats.in + ' jetons en entrée, ' + stats.out + ' en sortie → ' + cost.toFixed(2) + ' $ (au tarif configuré)'); }
  if (Object.keys(errors).length) console.log(lang + ' : ' + Object.keys(errors).length + ' phrases non traduites (erreur API, JSON ou contrôle ; restent en français) → i18n/' + lang + '.errors.json');
  return lang;
}

function manifest(){
  const review = rd('review.json', {}), m = { v: srcVersion, total: source.length, sensitive: (rd('sensible.json', []) || []).length, langs: {}, built: new Date().toISOString() };
  fs.readdirSync(DIR).filter((f) => /^[a-zA-Z0-9-]+\.json$/.test(f) && !['source', 'sensible', 'manifest', 'review', 'cost-report'].includes(f.replace('.json', '')) && !f.startsWith('glossary-') && !f.endsWith('.errors.json')).forEach((f) => {
    const lang = f.replace('.json', ''), d = rd(f, null); if (!d || !d.tr) return;
    const live = new Set(source), have = Object.keys(d.tr).filter((k) => live.has(k)).length, missing = source.length - have;
    const sens = rd('sensible.json', []), sensMissing = sens.filter((k) => !d.tr[k]).length;
    const ready = have / source.length >= 0.98 && sensMissing === 0;
    const rv = review[lang];
    m.langs[lang] = { status: !ready ? 'partielle' : (rv && rv.sensible && rv.reviewer && rv.v === srcVersion) ? 'verifiee' : 'automatique', phrases: have, manquantes: missing, sensibles_manquantes: sensMissing, v: d.v, revue: rv ? { par: rv.reviewer, date: rv.date, v: rv.v } : null };
  });
  wrp('manifest.json', m); return m;
}

function csvq(t){ return '"' + String(t == null ? '' : t).replace(/"/g, '""') + '"'; }
(async () => {
  if (flag('review')) { // fichier de relecture des textes sensibles (tarifs, crédits, paiements, suppressions, permissions, erreurs)
    const l = langs[0]; const d = rd(l + '.json', null); if (!d) { console.error('Langue absente : ' + l); process.exit(1); }
    const rows = [['Français (source)', 'Traduction ' + l, 'Verdict (OK / à corriger)', 'Correction']].concat(rd('sensible.json', []).map((k) => [k, d.tr[k] || '', '', '']));
    fs.writeFileSync(path.join(DIR, 'revue-' + l + '.csv'), '\ufeff' + rows.map((r) => r.map(csvq).join(',')).join('\n'));
    console.log(rows.length - 1 + ' phrases sensibles à relire → i18n/revue-' + l + '.csv\nCorrigez dans i18n/glossary-' + l + '.json ({"phrase française":"traduction validée"}), relancez le script pour ' + l + ', puis : node scripts/build-i18n.js --approve=' + l + ' --reviewer="Nom"'); process.exit(0);
  }
  const ap = args.find((a) => a.startsWith('--approve='));
  if (ap) { const l = ap.split('=')[1], who = opt('reviewer', ''); if (!who) { console.error('--reviewer="Nom" obligatoire'); process.exit(1); }
    const rv = rd('review.json', {}); rv[l] = { reviewer: who, date: new Date().toISOString().slice(0, 10), sensible: true, v: srcVersion }; wrp('review.json', rv); const m = manifest(); console.log(l + ' : ' + (m.langs[l] ? m.langs[l].status : 'absente') + ' (la revue ne vaut que pour la version ' + srcVersion + ' des textes)'); process.exit(0); }
  if (flag('check') || !langs.length) {
    const m = manifest(); console.log('Version des textes : ' + m.v + ' — ' + m.total + ' phrases (' + m.sensitive + ' sensibles)');
    Object.keys(m.langs).forEach((l) => { const x = m.langs[l]; console.log('  ' + l + ' : ' + x.status + ' (' + x.phrases + ' prêtes, ' + x.manquantes + ' manquantes, ' + x.sensibles_manquantes + ' sensibles manquantes)' + (x.v !== m.v ? ' — textes modifiés depuis, à rebâtir' : '')); });
    if (!Object.keys(m.langs).length) console.log('  aucune langue préparée.');
    process.exit(0);
  }
  for (const l of langs) await build(l);
  const m = manifest(); console.log('manifest.json mis à jour (v ' + m.v + ')');
})().catch((e) => { console.error(e); process.exit(1); });
