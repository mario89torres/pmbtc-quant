# syntax=docker/dockerfile:1

# ---- Etapa 1: instalación de dependencias --------------------------------
# Se usa una imagen Debian (no Alpine) porque better-sqlite3 publica
# binarios precompilados para glibc; con Alpine (musl) suele terminar
# compilando desde código fuente, que es más lento y más frágil.
# Se incluyen herramientas de compilación como respaldo por si no hay
# binario prebuilt para la arquitectura del host (ej. algunos arm64).
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- Etapa 2: imagen final, más liviana ----------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Usuario sin privilegios para no correr el proceso como root
RUN useradd --create-home --shell /bin/bash pmbtc
RUN mkdir -p /data && chown -R pmbtc:pmbtc /data

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# La base SQLite vive en un volumen persistente fuera del código de la app
ENV PMBTC_DB=/data/pmbtc.db
ENV PMBTC_PORT=8787
EXPOSE 8787

VOLUME ["/data"]

USER pmbtc

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PMBTC_PORT||8787) + '/api/summary').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Por defecto levanta el dashboard (solo lectura). Para el colector,
# se sobreescribe el comando (ver docker-compose.yml) con:
#   node collect.js
CMD ["node", "server.js"]
