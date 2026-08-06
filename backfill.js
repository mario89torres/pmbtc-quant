'use strict';

// Recalcula ref/cierre/outcome de las velas ya grabadas a partir de `underlying`.
// Es idempotente: se puede correr las veces que haga falta.
//
//   node pmbtc/backfill.js           -> aplica
//   node pmbtc/backfill.js --dry-run -> solo informa
//
// Recupera tres situaciones distintas:
//   1. El tick existe en la DB pero collect.js no lo usó (descartaba el cierre
//      si faltaba la ref, y consultaba antes de que el tick hubiera llegado).
//   2. Hay un hueco corto del feed y sirve el tick vecino, con su desfase anotado.
//   3. Encadenado: el cierre de una vela y la ref de la siguiente son el mismo
//      número (el precio en la frontera común), así que uno rellena al otro.

const { open } = require('./src/db');
const { resolvePrice, priceBounds } = require('./src/prices');
const { BUCKET, bucketStart } = require('./src/gamma');

const dry = process.argv.includes('--dry-run');
const db = open();
const iso = (ms) => new Date(ms).toISOString().slice(11, 19);

const buckets = db.prepare('SELECT * FROM buckets ORDER BY start_ts').all();
const live = bucketStart();

// Estado en memoria para poder encadenar antes de escribir.
const st = new Map();
for (const b of buckets) {
  st.set(b.start_ts, {
    startTs: b.start_ts,
    ref: b.ref_price, refOff: b.ref_offset_ms, refSrc: b.ref_source,
    fin: b.final_price, finOff: b.final_offset_ms, finSrc: b.final_source,
    outcome: b.outcome, outSrc: b.outcome_source,
    settled: b.settled_up,
  });
}

const changes = [];

// --- paso 1: releer del feed lo que falte --------------------------------------

for (const s of st.values()) {
  if (s.ref == null) {
    const r = resolvePrice(db, s.startTs * 1000);
    if (r) {
      s.ref = r.price; s.refOff = r.offsetMs; s.refSrc = 'feed';
      changes.push(`${iso(s.startTs * 1000)} ref <- feed ${r.price.toFixed(2)} (${r.offsetMs >= 0 ? '+' : ''}${r.offsetMs}ms)`);
    }
  }
  // El cierre se resuelve aunque falte la ref: es un dato válido por sí mismo y
  // además es la ref de la vela siguiente.
  if (s.fin == null && s.startTs !== live) {
    const r = resolvePrice(db, (s.startTs + BUCKET) * 1000);
    if (r) {
      s.fin = r.price; s.finOff = r.offsetMs; s.finSrc = 'feed';
      changes.push(`${iso(s.startTs * 1000)} cierre <- feed ${r.price.toFixed(2)} (${r.offsetMs >= 0 ? '+' : ''}${r.offsetMs}ms)`);
    }
  }
}

// --- paso 2: encadenado entre velas contiguas ----------------------------------
// Solo se propaga desde un dato medido ('feed'), nunca desde otro inferido, para
// no encadenar aproximaciones sobre aproximaciones.

for (const s of st.values()) {
  const next = st.get(s.startTs + BUCKET);
  if (!next) continue;
  if (s.fin == null && next.ref != null && next.refSrc === 'feed') {
    s.fin = next.ref; s.finOff = next.refOff; s.finSrc = 'chain';
    changes.push(`${iso(s.startTs * 1000)} cierre <- encadenado desde ref de ${iso(next.startTs * 1000)}`);
  }
  if (next.ref == null && s.fin != null && s.finSrc === 'feed') {
    next.ref = s.fin; next.refOff = s.finOff; next.refSrc = 'chain';
    changes.push(`${iso(next.startTs * 1000)} ref <- encadenado desde cierre de ${iso(s.startTs * 1000)}`);
  }
}

// --- paso 3: outcome ------------------------------------------------------------

for (const s of st.values()) {
  if (s.ref == null || s.fin == null) continue;
  const want = s.fin >= s.ref ? 'Up' : 'Down';

  // Si algún extremo es aproximado, el valor real de la frontera está dentro de
  // una horquilla. El outcome solo se acepta si aguanta en el peor caso de esa
  // horquilla; si el hueco basta para voltearlo, la vela queda indeterminada.
  if (s.refOff || s.finOff) {
    const rb = priceBounds(db, s.startTs * 1000);
    const fb = priceBounds(db, (s.startTs + BUCKET) * 1000);
    if (rb && fb) {
      const peor = fb.lo >= rb.hi ? 'Up' : fb.hi < rb.lo ? 'Down' : null;
      if (peor !== want) {
        changes.push(`${iso(s.startTs * 1000)} outcome INDETERMINADO: el hueco del feed (ref ${rb.lo.toFixed(2)}–${rb.hi.toFixed(2)}, cierre ${fb.lo.toFixed(2)}–${fb.hi.toFixed(2)}) puede voltearlo`);
        s.outcome = null;
        continue;
      }
    }
  }

  if (want !== s.outcome) {
    changes.push(`${iso(s.startTs * 1000)} outcome ${s.outcome || '-'} -> ${want} (mov ${(s.fin - s.ref >= 0 ? '+' : '') + (s.fin - s.ref).toFixed(2)})`);
    s.outcome = want;
    s.outSrc = 'computed';
  }
}

// --- paso 4: settlement de Polymarket ------------------------------------------
// Es ground truth y no necesita precios locales, así que rescata velas cuyo corte
// se perdió. Gamma deja de servir los mercados viejos por slug, pero el valor que
// guardó `verifySettlement` en su momento sigue en la DB.

for (const s of st.values()) {
  if (s.settled == null) continue;
  const real = s.settled >= 0.99 ? 'Up' : s.settled <= 0.01 ? 'Down' : null;
  if (!real) continue;

  if (s.outcome && s.outcome !== real) {
    // Si esto salta, la extracción del corte está mal: manda el settlement.
    changes.push(`${iso(s.startTs * 1000)} DISCREPANCIA: calculado ${s.outcome}, settlement ${real} -> se impone el settlement`);
  } else if (!s.outcome) {
    changes.push(`${iso(s.startTs * 1000)} outcome <- settlement ${real} (sin precios locales)`);
  }
  s.outcome = real;
  s.outSrc = 'settlement';
}

// --- escritura ------------------------------------------------------------------

if (!changes.length) {
  console.log('nada que recuperar');
} else {
  console.log(changes.join('\n'));
  console.log(`\n${changes.length} cambios${dry ? ' (dry-run, no escrito)' : ''}`);
}

if (!dry && changes.length) {
  const upd = db.prepare(`
    UPDATE buckets SET ref_price=@ref, ref_offset_ms=@refOff, ref_source=@refSrc,
                       final_price=@fin, final_offset_ms=@finOff, final_source=@finSrc,
                       outcome=@outcome, outcome_source=@outSrc
    WHERE start_ts=@startTs
  `);
  db.transaction((rows) => { for (const r of rows) upd.run(r); })([...st.values()]);
}

// --- informe --------------------------------------------------------------------

console.log('\nestado:');
let ok = 0, partial = 0;
for (const s of [...st.values()].sort((a, b) => a.startTs - b.startTs)) {
  const isLive = s.startTs === live;
  if (s.outcome) ok++; else if (!isLive) partial++;
  const q = [s.refOff, s.finOff].some((o) => o != null && o !== 0) ? ' ~aprox' : '';
  const src = [s.refSrc, s.finSrc].includes('chain') ? ' (encadenado)'
    : s.outSrc === 'settlement' ? ' (settlement)' : '';
  console.log(
    `  ${iso(s.startTs * 1000)}  ref ${s.ref ? s.ref.toFixed(2) : '—'.padStart(8)}` +
    `  cierre ${s.fin ? s.fin.toFixed(2) : '—'.padStart(8)}` +
    `  ${(s.outcome || (isLive ? 'EN CURSO' : '—')).padEnd(8)}${q}${src}`
  );
}
console.log(`\n${ok} velas con outcome, ${partial} irrecuperables (feed caído en el corte)`);
