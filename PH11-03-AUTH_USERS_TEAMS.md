# PH11-03 — Users, Teams & Auth réelle (bcrypt + JWT + multi-tenant)

**Date**: 2025-12-11  
**Repo**: keybuzz-backend  
**Stack**: Fastify, TypeScript, Prisma, Postgres, bcrypt, fastify-jwt

---

## Objectif
Mettre en place l’auth réelle basée sur la table `User` : hash des mots de passe, login avec JWT signé, protection des routes, et préparation multi-tenant (super_admin vs tenant user).

---

## Réalisations
- Auth réelle : `/api/v1/auth/login` utilise Prisma + bcrypt (passwordHash en DB) et signe un JWT (fastify-jwt).
- Plugin JWT : `src/config/jwt.ts` avec décorateur `authenticate` (401 si non autorisé).
- Tenants API sécurisée : `/api/v1/tenants` nécessite un JWT.  
  - super_admin voit tous les tenants  
  - user non super_admin voit uniquement son tenant
- Seed avec mots de passe hashés (bcrypt):  
  - `admin@keybuzz.io` (SUPER_ADMIN) — password: `change-me`  
  - `owner@acme-electronics.com` — `owner-acme-123`  
  - `admin@techcorp-solutions.com` — `admin-techcorp-123`  
  - `owner@globex-retail.com` — `owner-globex-123`

---

## Fichiers clés
- `src/config/jwt.ts` — plugin fastify-jwt + décorateur `authenticate`
- `src/modules/auth/auth.service.ts` — `loginWithEmailPassword`, `hashPassword`
- `src/modules/auth/auth.routes.ts` — POST `/api/v1/auth/login`
- `src/modules/tenants/tenants.routes.ts` — route protégée
- `src/modules/tenants/tenants.service.ts` — filtrage par rôle/tenant, via Prisma
- `prisma/seed.ts` — seeds avec passwords hashés
- `package.json` — dépendances bcrypt, @types/bcrypt

---

## Flux Auth
1. POST `/api/v1/auth/login` avec email/password  
2. Vérification hash bcrypt (`passwordHash` en DB)  
3. Si OK : retour `{ user, token }` (payload JWT: sub, tenantId, role, email)  
4. Routes protégées : `preHandler: (app as any).authenticate` + accès `request.user`

---

## Commands
```
# Lint & build
npm run lint
npm run build

# Auth / Tenants tests
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@keybuzz.io","password":"change-me"}'

TOKEN="...jwt..."
curl http://localhost:4000/api/v1/tenants -H "Authorization: Bearer $TOKEN"
```

### Prisma / DB (⚠️ nécessite des credentials DB valides)
```
npx prisma migrate dev --name init_core_schema
npx prisma db seed
```
Note : migration/seed bloqués actuellement par P1000 (auth DB invalide sur 10.0.0.10:5432). Fournir des identifiants valides puis relancer.

---

## Prochaines étapes (PH11-04)
- Fournir les creds Postgres valides puis appliquer `prisma migrate dev` + `prisma db seed`
- Étendre la protection JWT aux autres routes
- Ajouter gestion des rôles/permissions fines
- Hash + JWT pour autres flows (refresh tokens, rotation)
- Étendre schéma (Messages/Tickets/AI/Billing) et brancher les nouvelles routes

---

**PH11-03 — Users + Auth (bcrypt + JWT) + tenants multi-tenant terminé — ready pour PH11-04 (Messages/Tickets et AI côté backend).**

