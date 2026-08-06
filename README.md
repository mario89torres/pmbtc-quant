# pmbtc — Bitcoin Up or Down 15m (Polymarket)

Fase 1: **entender la data**. Nada aquí opera ni firma órdenes.

## Cómo es el mercado

- Slug: `btc-updown-15m-<unix>` donde `<unix>` es el arranque de la vela alineado a 900s **UTC**.
  Ej.: `btc-updown-15m-1785400200` = 08:30–08:45 UTC (4:30–4:45 AM ET).
- Polymarket crea cada mercado **~24 h antes**, así que se puede pre-cargar el token id.
- Resuelve **Up si `precio_cierre >= precio_arranque`** (los empates van a Up).
- Dos outcomes con order book propio: `Up` y `Down`, tick de **$0.01**, orden mínima **5 shares**.
- `maker_base_fee` / `taker_base_fee` vienen en 1000 en gamma y en el CLOB. Revisé los 100
  mercados del volcado: **todos traen 1000/1000**, incluidos los de deportes. Que sea una
  constante global apunta a un campo nominal que no se cobra, no a un 10 % efectivo — pero
  sigue **pendiente de confirmar contra un fill real** antes de dimensionar nada.

## Fuente de resolución (la pieza clave)

El mercado resuelve con el **Chainlink BTC/USD data stream**, no con spot de exchange.
Polymarket lo publica en claro por websocket:

```
wss://ws-live-data.polymarket.com
{"action":"subscribe","subscriptions":[
  {"topic":"crypto_prices_chainlink","type":"*"},
  {"topic":"crypto_prices","type":"update","filters":"{\"symbol\":\"btcusdt\"}"}]}
```

- `crypto_prices_chainlink` / `btc/usd` → **es exactamente el número que resuelve**. ~1 tick/s.
- `crypto_prices` / `btcusdt` → Binance spot, misma cadencia y sin lag.

Ojo: los dos niveles **no son comparables**. En la primera medición Chainlink marcaba ~64 196 y
Binance ~64 287: unos 90 USD de basis. Binance sirve solo como **adelanto de la dirección**,
nunca como sustituto del nivel.

Consecuencia práctica: no se puede reconstruir historia. El precio de referencia de una vela
solo se conoce si el feed estaba conectado en el corte, así que la data hay que **acumularla
hacia adelante**.

## Endpoints REST usados

| Qué | Endpoint |
|---|---|
| Mercado por slug | `GET gamma-api.polymarket.com/markets?slug=<slug>` |
| Libro por token | `GET clob.polymarket.com/book?token_id=<id>` |
| Mid / spread | `GET clob.polymarket.com/midpoint?token_id=`, `/spread?token_id=` |
| Histórico de precio del mercado | `GET clob.polymarket.com/prices-history?market=<token>&interval=max&fidelity=1` |
| Trades ejecutados | `GET data-api.polymarket.com/trades?market=<conditionId>` |

Ninguno pidió API key para lectura.

## Visor web

```bash
node pmbtc/server.js
```

Abre **`http://localhost:8787`**. Solo lectura, refresca cada 5 s.

> **Ábrelo siempre por `http://localhost:8787`, nunca haciendo doble clic en
> `public/index.html`.** Por `file://` el navegador bloquea todas las llamadas a la API y el panel
> aparece vacío, con el feed en "—", como si la captura estuviera muerta cuando en realidad sigue
> corriendo. Algunos editores abren ese archivo solos al guardarlo, así que es fácil acabar
> mirando la pestaña equivocada. Ahora la página lo detecta y lo dice en vez de quedarse muda.

Muestra:

- **Subyacente** — chainlink y binance como *delta desde su propio valor al inicio de la vela*.
  Los niveles no son comparables (basis de ~60–90 USD), pero los movimientos sí: si binance
  gira antes que chainlink de forma sistemática, es visible ahí.
- **Probabilidad de Up** — precio del mercado (mid) contra el modelo GBM.
- **Libro** — bid/ask de Up y Down a lo largo de la vela.
- **Calibración** — separada por tiempo restante (>10 min / 5–10 min / <5 min).
- **Ticks** — la tabla cruda.

### Por qué la calibración va separada por franja

Agregando todos los ticks juntos aparece un sesgo enorme (+35 % y similares) que es **puro
artefacto**: la mayoría de los ticks de una vela ocurren cuando el resultado ya está decidido,
así que se estaría midiendo la vela resolviéndose, no una oportunidad. Y con pocas velas
resueltas la columna "real" solo puede valer 0 % o 100 %, porque todos los ticks de una vela
comparten outcome. **No leer esa tabla como edge hasta tener decenas de velas.**

## Verificación de que la extracción es correcta

Dos comprobaciones que ya pasaron:

1. **Encadenado de velas**: el `final_price` de una vela coincide exactamente con el `ref_price`
   de la siguiente (00:00 cierra en 64760.17 = ref de 00:15). Velas consecutivas comparten el
   precio de frontera, así que esto solo cuadra si la extracción del corte es correcta.
2. **Contra el settlement real**: la vela 05:15 dio `Down` en local y Polymarket la resolvió
   con `outcomePrices` de Up = 0.0015. Coincide.

Cuidado con `settled_up`: a los 2 min del cierre el mercado suele **seguir sin resolver**, y
`outcomePrices` devuelve el precio de mercado (0.46, 0.58…), no un settlement. `collect.js`
reintenta a 2/5/10/20/40 min y solo guarda el valor si el mercado está cerrado *y* el precio es
concluyente (≥0.99 o ≤0.01).

## Velas sin ref / sin cierre

El primer diagnóstico ("se cae el feed") resultó ser **falso en la mayoría de los casos**. Al
medir los huecos reales alrededor de cada corte fallido salieron tres causas distintas, y dos
eran bugs del colector, no del feed:

| Causa | Síntoma | ¿Recuperable? |
|---|---|---|
| El cierre se descartaba si faltaba la ref | tick exacto en la DB, sin usar | Sí, el dato ya estaba |
| Se consultaba a los 6 s y el tick llegaba a los 9 s | hueco de 12 s en el corte | Sí, con tolerancia |
| Proceso reiniciado a media vela | vela cortada por la mitad | Sí, desde `underlying` |
| Feed realmente caído | sin ticks en ±120 s | **No** |

Corregido en `collect.js`:

- El cierre se guarda **aunque falte la ref**: es un dato válido por sí mismo y además es la
  referencia de la vela siguiente.
- El corte se resuelve **reintentando** (hasta ~30 s) en vez de una consulta única.
- Ref y cierre se resuelven **en segundo plano**: la vela siguiente arranca en el mismo
  instante que cierra la anterior, así que esperar ahí le robaría sus primeras muestras.

### `backfill.js`

Recalcula ref/cierre/outcome de las velas ya grabadas a partir de `underlying`. Idempotente.

```bash
node pmbtc/backfill.js --dry-run
```

```bash
node pmbtc/backfill.js
```

Recupera por cuatro vías:

1. **Releer el feed** — el tick estaba en `underlying` y `collect.js` no lo usó.
2. **Tolerancia al hueco** — vecino más cercano, con el desfase anotado.
3. **Encadenado** — el cierre de una vela y la ref de la siguiente son el mismo número (el
   precio en la frontera común), así que uno rellena al otro. Solo se propaga desde un dato
   medido, nunca desde otro inferido, para no apilar aproximaciones.
4. **Settlement de Polymarket** — es ground truth y **no necesita precios locales**, así que
   rescata velas cuyo corte se perdió entero. Si el outcome calculado y el settlement
   discrepan, manda el settlement y se registra el aviso: una discrepancia significa que la
   extracción del corte está mal.

Subió de **4 a 9 velas resueltas** sobre 11. Las 2 restantes no tienen ni ticks ni settlement
guardado; son pérdida definitiva.

Ojo con la vía 4: gamma **deja de servir los mercados viejos por slug** (probado: 08:45, 01:15 y
05:00 devuelven vacío horas después). Solo funciona con el `settled_up` que `verifySettlement`
haya guardado en su momento. Si el colector no estaba vivo tras el cierre, ese dato no existe y
no hay forma de recuperarlo.

### Validación cruzada

En las velas donde hay outcome calculado *y* settlement, **coinciden todas**. El caso más fuerte
es 00:45: calculado desde un tick aproximado (−3 s) y confirmado por la resolución real de
Polymarket. La UI las marca con `✓stl`.

### Calidad del dato

Cuando no hay tick exacto en el corte se usa el vecino más cercano y se guarda el desfase en
`ref_offset_ms` / `final_offset_ms`. Importa: chainlink se mueve ~1–3 USD/s y σ de una vela ronda
los 60 USD, así que un tick a 3 s puede valer un 5–15 % de σ. El visor marca esas velas con
`~3s` en ámbar.

Además, si algún extremo es aproximado se comprueba que el hueco **no pueda voltear el
outcome**: se calcula el resultado en el peor caso de la horquilla y, si no coincide, la vela
queda indeterminada en vez de afirmar algo que el dato no sostiene.

Ejemplo real: en el corte de 01:00 el feed saltó de 00:59:57 (64665.93) a 01:00:09 (64698.39),
$32 de incertidumbre. Los movimientos de esas dos velas eran −68.97 y +461.65, muy por encima
de la horquilla, así que ambos outcomes se sostienen.

### Sobre σ y la vela de 01:00

Esa vela movió +461.65 USD, unas 7σ respecto a la media de 6 h. Verifiqué la serie: 979 ticks
continuos, es un movimiento real, no un artefacto. Confirma que **la vol dista mucho de ser
constante**, que es justo el supuesto que rompe el modelo GBM de `analyze.js`.

## Archivos

- `src/gamma.js` — slugs, mercado normalizado, libro, y `sweepCost()` para el precio real de
  barrer N dólares contra el libro (no el mejor precio, que es lo que engaña).
- `src/feed.js` — websocket con reconexión y backoff.
- `src/db.js` — esquema SQLite en `pmbtc/pmbtc.db` (aparte de `snapshots.db`).
- `collect.js` — arranca en el siguiente corte limpio de 15 min, graba libro cada 2 s + la serie
  de 1 s del subyacente, y al cierre calcula el outcome y lo **verifica contra la resolución
  real de gamma** 2 min después (loguea `DISCREPANCIA` si no coinciden).
- `src/model.js` — σ del subyacente y `fairUp()`, compartidos por `analyze.js` y el visor.
  La ventana de σ se ancla al **último dato, no al reloj**: si se anclara a `Date.now()`,
  analizar en frío horas después de capturar devolvería cero muestras.
- `analyze.js` — resumen, o detalle tick a tick con `node pmbtc/analyze.js <start_ts>`.
- `server.js` + `public/index.html` — visor web (ver arriba).
- `smoke.js` — prueba de 6 s de que feed, libro y DB responden.

## Esquema

- `buckets` — una fila por vela: tokens, `ref_price`, `final_price`, `outcome`, `settled_up`.
- `ticks` — muestreo del libro: mejores bid/ask de Up y Down, profundidad en USD del lado ask,
  precio chainlink y binance del momento, y segundos restantes.
- `underlying` — serie de 1 s de ambas fuentes, independiente del muestreo del libro.

## Correr

```bash
node pmbtc/collect.js
```

```bash
node pmbtc/analyze.js
```

## Modelo de referencia en `analyze.js`

Estimador puramente descriptivo, para tener con qué comparar el precio del mercado:

- `sigma` por segundo desde los retornos log de Chainlink, descartando huecos > 3 s del feed
  (si no, una reconexión infla la vol).
- `P(Up) = Phi( ln(P_t / P_ref) / (sigma * sqrt(T_restante)) )`, sin drift.

Es un GBM sin drift: ignora que el subyacente real tiene microestructura, que Chainlink está
suavizado y con lag, y que la vol no es constante dentro de la vela. Sirve para ver **si el
mercado se desvía**, no como precio justo.

Primera medida de sigma con ~50 retornos: `sigma_15min ≈ 0.089 %`, o sea **~57 USD de
desviación estándar** sobre 64 200. Muestra ridícula todavía; hay que rehacerla con horas de data.

## Arranque automático en Windows

pmbtc arranca solo en cada inicio de sesión. **No hay que lanzar nada a mano.**

El lanzador está en la carpeta de Inicio:
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\pmbtc.vbs`

Cuatro capas de protección, de dentro a fuera:

| Capa | Qué cubre |
|---|---|
| `supervise.js` | Relanza colector y visor por separado, con backoff |
| `run-pmbtc.cmd` | Relanza el supervisor si muere él mismo (10 s) |
| Carpeta de Inicio | Arranca todo en cada inicio de sesión |
| Tarea programada *(opcional)* | Reinicio gestionado por Windows: 10 intentos, 1 min |

### Mejora opcional: tarea programada

Clic derecho en `scripts/install-pmbtc-task.cmd` → **Ejecutar como administrador**.

Hace falta elevación: sin ella, Windows devuelve `Acceso denegado` al escribir en el Programador
de tareas (comprobado, y no es cosa del sandbox: falla igual con `schtasks` y con
`Register-ScheduledTask`). El instalador retira el lanzador de la carpeta de Inicio al terminar,
para no levantar dos instancias.

**Limitación de ambas vías:** arrancan al *iniciar sesión*, no al encender el equipo. Para que
corra sin nadie logueado haría falta un servicio real (NSSM o `sc create`), que también exige
admin y además guardar credenciales.

### Comandos

```bash
scripts\restart-pmbtc.cmd
```

Reinicio limpio tras cambiar código. Mata el bucle `cmd` **primero** (si no, relanzaría el
supervisor mientras lo estás matando) y luego relanza por la vía que esté instalada.

Log: `pmbtc/supervise.log` · Visor: `http://localhost:8787`

## Supervisor

```bash
node pmbtc/supervise.js
```

Mantiene vivos **el colector y el visor web**, cada uno con su propio backoff (2s → 60s, y reset
a 2s si aguantó más de 5 min, para no castigar una caída puntual como si fuera crashloop). Van
por separado a propósito: que se caiga el visor no debe tocar la captura, que es lo único cuyo
dato es irrecuperable.

Lanza `backfill.js` **tras cada reinicio del colector** y cada 15 min. Es la única defensa real
contra la pérdida definitiva de velas, porque reiniciar rápido acorta el hueco lo bastante para
que backfill rescate la vela interrumpida.

Probado matando el hijo: detectó la muerte, esperó 2 s, relanzó y corrió backfill.

**Y cazó un crash real a las pocas horas.** Un fallo de DNS transitorio
(`ENOTFOUND gamma-api.polymarket.com`) provocaba un rechazo de promesa no capturado que mataba
el colector: `fetchMarket` en `runBucket` no tenía try/catch. El supervisor lo relanzó en 2 s sin
perder ninguna vela, pero la causa está corregida en el colector:

- `fetchMarket` reintenta 3 veces antes de dar la vela por perdida.
- La resolución de la ref lleva `.catch()`.
- `process.on('unhandledRejection')` como última red, **registrando el aviso a gritos**: cada
  línea de esas es un sitio sin try/catch que hay que arreglar, no algo que normalizar.

El feed sigue cayéndose (`code 1006`) ~3 veces cada 6 h y reconectando solo; eso es normal y no
mata el proceso.

## Lag Chainlink ↔ Binance

```bash
node pmbtc/lag.js
```

Primera medición sobre 2.2 h de tramos contiguos con ambas fuentes.

### Binance adelanta ~1 segundo

Correlación cruzada de retornos de 1 s: pico nítido en **k=+1s con corr 0.710** (0.528 en k=0,
0.194 en k=2). El adelanto es real pero **corto**.

### El basis predice a chainlink, pero se agota rápido

`basis = ln(cl/bn)` desviado de su media móvil de 60 s. Correlación con el retorno futuro de
chainlink, negativa como se esperaba (chainlink va por detrás):

| Horizonte | corr | acierto de signo |
|---|---|---|
| 1 s | −0.615 | 56.1 % |
| 10 s | −0.166 | 52.6 % |
| 30 s | −0.134 | 48.5 % |
| 60 s | −0.085 | 48.2 % |

Más allá de 30 s no queda nada (incluso baja del 50 %).

### La señal vive solo en los extremos

Acierto por quintil de |z| a 10 s — aquí está lo interesante:

| Quintil |z| | Acierto | Movimiento a favor |
|---|---|---|
| 1/5 (más flojo) | 47.1 % | −$0.48 |
| 2/5 | 49.7 % | −$0.37 |
| 3/5 | 51.7 % | −$0.23 |
| 4/5 | 51.5 % | −$0.02 |
| **5/5 (extremo)** | **62.8 %** | **+$3.03** |

Los cuatro primeros quintiles son ruido. Toda la señal está en el 20 % de momentos con basis
extremo.

### ¿Es explotable? Sin resolver, y hay dos razones para dudar

**1. El adelanto de 1 s casi seguro no es ejecutable.** Requeriría colocar órdenes contra un
CLOB con quotes de 1 s de antigüedad. La señal a 10 s del quintil extremo es la única con
opciones realistas.

**2. La magnitud es fina.** Un movimiento de $3 a 10 s, a 10 min del cierre (σ restante ≈ $49),
desplaza la probabilidad en `0.399 × 3/49 ≈ 2.4 puntos`. Contra un spread de ~1 centavo, quedan
~1.4 centavos brutos sobre un contrato de ~50 ¢. Existe, pero es delgado y aún no descuenta fees.

**3. Y sobre todo: falta la medición que importa.** Que el basis prediga a chainlink no sirve de
nada si el mercado ya lo está descontando. La sección 4 de `lag.js` prueba lo correcto —dentro de
un mismo nivel de precio del mercado, ¿el signo del basis separa los resultados?— y da un patrón
sugerente en 3 de 9 franjas, pero **el n efectivo es el número de velas (27), no de ticks (1935)**,
porque todos los ticks de una vela comparten resultado. Con eso no se concluye nada todavía.

### Sesgo conocido a tener presente

Chainlink es un feed agregado y suavizado. Parte de la reversión del basis es **mecánica** —una
media móvil del mismo subyacente revierte por construcción— y no información nueva. Sigue siendo
predecible, pero explica por qué aparece un "adelanto" que nadie arbitra.

## Qué falta antes de pensar en operar

1. **Acumular velas.** La sección 4 de `lag.js` es la prueba decisiva y necesita cientos de
   velas resueltas, no 27. Todo lo demás depende de esto.
2. **Resolver la unidad de las fees.** Sigue siendo lo que decide si el proyecto es viable: con
   1.4 centavos de margen bruto estimado, cualquier fee real se lo come entero.
3. **Medir la latencia de ejecución real** contra el CLOB. Si colocar una orden tarda más que la
   vida de la señal (~10 s), no hay nada que hacer con ella.
4. Medir cuánto se puede ejecutar de verdad con `sweepCost`, no con el mejor precio.
