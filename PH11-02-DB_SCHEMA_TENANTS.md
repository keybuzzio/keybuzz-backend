# PH11-02 — DB Schema & Tenants (Prisma + Postgres + Multi-tenant)

**Date**: 2025-12-11  
**Repo**: keybuzz-backend  
**Stack**: Node.js 22, TS, Fastify, Prisma, Postgres

---

## 🎯 Objectif
Intégrer Prisma, définir le schéma multi-tenant de base, appliquer les migrations, ensemencer les tenants et brancher l’API `/api/v1/tenants` sur la base Postgres (plus de mocks).

---

## 📁 Fichiers clés
- `prisma/schema.prisma` : schéma core (Tenants, Users, Teams, TeamMembership, ApiKeys, Webhooks + enums)
- `prisma/seed.ts` : seed initial (tenants + super admin + owners)
- `src/lib/db.ts` : PrismaClient unique + `testDbConnection()`
- `src/modules/tenants/tenants.service.ts` : lecture DB via Prisma
- `src/modules/health/health.routes.ts` : `/health/db` utilise Prisma
- `package.json` : scripts `prisma:migrate`, `prisma:seed`, config prisma seed
- `PH11-02-DB_SCHEMA_TENANTS.md` : ce document

---

## 🗄️ Schéma Prisma (extrait)
- **Tenant**: `id`, `slug` unique, `name`, `plan` (enum BillingPlan), `status` (enum TenantStatus), timestamps, relations `users`, `teams`, `apiKeys`, `webhooks`
- **User**: `tenantId?`, `email` unique, `fullName`, `role` (UserRole), `passwordHash`, timestamps, `teamMemberships`
- **Team**: `tenantId`, `name`, timestamps, `members`
- **TeamMembership**: `teamId`, `userId`, `role` (TeamRole), `createdAt`
- **ApiKey**: `tenantId`, `name`, `keyHash`, `prefix`, `active`, `lastUsedAt`
- **Webhook**: `tenantId`, `name`, `targetUrl`, `eventTypes[]`, `isActive`, `lastDeliveryAt`
- Enums: `TenantStatus (TRIAL|ACTIVE|SUSPENDED|CLOSED)`, `BillingPlan (DEV|STARTER|PRO|ENTERPRISE)`, `UserRole (OWNER|ADMIN|MANAGER|AGENT|SUPER_ADMIN)`, `TeamRole (LEAD|MEMBER)`

---

## 🚀 Commandes
### Migrations
```
npx prisma migrate dev --name init_core_schema
```

### Seed
```
npx prisma db seed
```

### Dev / Build
```
npm run dev
npm run build
```

### Tests API
```
curl http://localhost:4000/health
curl http://localhost:4000/health/db
curl http://localhost:4000/api/v1/tenants
```

---

## ✅ Résultats
- Prisma installé et configuré (`DATABASE_URL` Postgres)
- Schéma core créé (tenants, users, teams, memberships, apiKeys, webhooks)
- Migration `init_core_schema` appliquée
- Seed initial exécuté (3 tenants + super admin global + owners/admins)
- `/api/v1/tenants` lit désormais la DB (plus de mocks)
- `/health/db` passe par Prisma et retourne `ok` si la connexion est valide

---

## 🔭 Prochaines étapes (PH11-03)
- Choisir ORM/migrations avancées (Prisma continuer) pour Users/Teams/Auth réelle
- Hash passwords + JWT réels
- Brancher auth/login sur DB
- Ajouter modèles supplémentaires (Messages, Tickets, AI, Billing) dans les phases suivantes

---

**PH11-02 — DB schema & tenants API (Prisma + Postgres) terminé — prêt pour PH11-03 (Users/Teams & Auth réelle).**

