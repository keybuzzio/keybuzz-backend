# PH11-01 — Backend Foundation (Node.js + TS + Fastify + Postgres + Multi-tenant)

**Date**: 2025-12-11  
**Repo**: keybuzz-backend  
**Stack**: Node.js 22, TypeScript, Fastify, pg, Zod

---

## 🎯 Objectif

Créer la fondation du backend KeyBuzz v3 : serveur Fastify, configuration TypeScript stricte, connexion Postgres prête (SELECT 1), routes de base multi-tenant, auth squelette, Dockerfile, scripts npm et documentation.

---

## 📁 Arborescence

```
src/
├─ main.ts
├─ config/
│  ├─ env.ts
│  └─ logger.ts
├─ lib/
│  └─ db.ts
└─ modules/
   ├─ health/
   │  └─ health.routes.ts
   ├─ tenants/
   │  ├─ tenants.types.ts
   │  ├─ tenants.service.ts
   │  └─ tenants.routes.ts
   └─ auth/
      ├─ auth.types.ts
      ├─ auth.service.ts
      └─ auth.routes.ts
```

Autres fichiers : `package.json`, `tsconfig.json`, `.env.example`, `Dockerfile`, `scripts/` (réservé pour usage futur).

---

## ⚙️ Configuration

- **env.ts** : charge `.env`, valide avec Zod  
  - `NODE_ENV`, `PORT`, `DATABASE_URL`, `JWT_SECRET`, `KEYBUZZ_SUPERADMIN_EMAIL`, `KEYBUZZ_SUPERADMIN_PASSWORD`
- **logger.ts** : wrapper console (info/error/warn/debug)
- **db.ts** : pool PG + `testDbConnection()` (SELECT 1)

`.env.example` fourni :
```
NODE_ENV=development
PORT=4000
DATABASE_URL=postgres://postgres:CHANGE_ME@10.0.0.10:5432/keybuzz_backend
JWT_SECRET=CHANGE_ME_SECRET
KEYBUZZ_SUPERADMIN_EMAIL=admin@keybuzz.io
KEYBUZZ_SUPERADMIN_PASSWORD=change-me
```

---

## 🚀 Serveur Fastify

Fichier `src/main.ts` :
- Plugins: CORS, Helmet, Swagger + Swagger UI (`/docs`)
- Routes enregistrées : health, tenants, auth
- Listen: `0.0.0.0:${PORT}`

Routes health (`/health`, `/health/db`) : uptime, version, env, test DB.

---

## 🧩 Multi-tenant (squelette)

### Tenants
- Types (`tenants.types.ts`) : status, plan, dates
- Service (`tenants.service.ts`) : `getTenants()` avec mocks alignés front
- Route (`/api/v1/tenants`) : retourne `{ data: tenants }`

### Auth
- Types (`auth.types.ts`) : `AuthUser`, `UserRole`
- Service (`auth.service.ts`) : `mockLogin(email, password)` avec superadmin mock
- Route (`/api/v1/auth/login`) : retourne `{ user, token }` ou 401

---

## 🐳 Docker

`Dockerfile` multi-stage :
- **builder** : install + build TS
- **runner** : npm install --omit=dev + `node dist/main.js`

---

## 🔧 Scripts npm

```
"dev": "ts-node-dev --respawn --transpileOnly src/main.ts",
"build": "tsc -p tsconfig.json",
"start": "node dist/main.js",
"lint": "eslint src --ext .ts",
"test": "echo \"No tests defined yet\""
```

---

## ▶️ Lancement

### Dev
```
cp .env.example .env
npm install
npm run dev
```

### Build + Start
```
npm run build
npm start
```

### Tests d'API
```
curl http://localhost:4000/health
curl http://localhost:4000/health/db
curl http://localhost:4000/api/v1/tenants
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@keybuzz.io","password":"change-me"}'
```

---

## ✅ Résultats
- Lint: `npm run lint` (doit passer)
- Build: `npm run build` (doit passer)
- Dockerfile prêt pour build d'image

---

## 🔭 Prochaines étapes (PH11-02)
- Choisir ORM/migrations (Prisma / Drizzle / Knex)
- Modéliser schéma DB (Tenants, Users, Teams, Messages, Billing, etc.)
- Brancher routes sur PostgreSQL + auth réelle (JWT, hash)
- Ajout tests (Jest / Vitest) et CI
- Sécurisation (Helmet options, rate limiting)

---

**PH11-01 backend foundation terminée — KeyBuzz backend v3 prêt pour PH11-02 (DB schema & real data).**

