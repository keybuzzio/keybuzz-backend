# KeyBuzz Backend v3 — Documentation Complète

**Date**: 2025-12-11  
**Repository**: keybuzz-backend  
**Stack**: Node.js 22, TypeScript, Fastify, Prisma, PostgreSQL, bcrypt, fastify-jwt

---

## 📋 Table des matières

1. [PH11-01 — Backend Foundation](#ph11-01--backend-foundation)
2. [PH11-02 — DB Schema & Tenants](#ph11-02--db-schema--tenants)
3. [PH11-03 — Users, Teams & Auth réelle](#ph11-03--users-teams--auth-réelle)
4. [PH11-04A — Tickets, AI & Billing Schema](#ph11-04a--tickets-ai--billing-schema)
5. [PH11-04B — Tickets API (Services & Routes)](#ph11-04b--tickets-api-services--routes)

---

## PH11-01 — Backend Foundation

### Objectif
Créer la fondation du backend KeyBuzz v3 : serveur Fastify, configuration TypeScript stricte, connexion Postgres prête, routes de base multi-tenant, auth squelette, Dockerfile, scripts npm et documentation.

### Arborescence
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

### Configuration
- **env.ts** : charge `.env`, valide avec Zod
  - Variables : `NODE_ENV`, `PORT`, `DATABASE_URL`, `JWT_SECRET`, `KEYBUZZ_SUPERADMIN_EMAIL`, `KEYBUZZ_SUPERADMIN_PASSWORD`
- **logger.ts** : wrapper console (info/error/warn/debug)
- **db.ts** : pool PG + `testDbConnection()` (SELECT 1)

### Serveur Fastify
- Plugins: CORS, Helmet, Swagger + Swagger UI (`/docs`)
- Routes : `/health`, `/health/db`, `/api/v1/tenants`, `/api/v1/auth/login`
- Listen: `0.0.0.0:${PORT}`

### Routes
- `GET /health` : uptime, version, env
- `GET /health/db` : test connexion DB
- `GET /api/v1/tenants` : liste des tenants (mock initial)
- `POST /api/v1/auth/login` : login mock avec superadmin

### Scripts npm
```json
{
  "dev": "ts-node-dev --respawn --transpileOnly src/main.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node dist/main.js",
  "lint": "eslint src --ext .ts"
}
```

### Docker
Dockerfile multi-stage :
- **builder** : install + build TypeScript
- **runner** : npm install --omit=dev + `node dist/main.js`

---

## PH11-02 — DB Schema & Tenants

### Objectif
Intégrer Prisma, définir le schéma multi-tenant de base, appliquer les migrations, ensemencer les tenants et brancher l'API `/api/v1/tenants` sur la base Postgres (plus de mocks).

### Schéma Prisma Core

#### Modèles
- **Tenant** : `id`, `slug` unique, `name`, `plan` (enum BillingPlan), `status` (enum TenantStatus), timestamps, relations `users`, `teams`, `apiKeys`, `webhooks`
- **User** : `tenantId?`, `email` unique, `fullName`, `role` (UserRole), `passwordHash`, timestamps, `teamMemberships`
- **Team** : `tenantId`, `name`, timestamps, `members`
- **TeamMembership** : `teamId`, `userId`, `role` (TeamRole), `createdAt`
- **ApiKey** : `tenantId`, `name`, `keyHash`, `prefix`, `active`, `lastUsedAt`
- **Webhook** : `tenantId`, `name`, `targetUrl`, `eventTypes[]`, `isActive`, `lastDeliveryAt`

#### Enums
- `TenantStatus` : TRIAL, ACTIVE, SUSPENDED, CLOSED
- `BillingPlan` : DEV, STARTER, PRO, ENTERPRISE
- `UserRole` : OWNER, ADMIN, MANAGER, AGENT, SUPER_ADMIN
- `TeamRole` : LEAD, MEMBER

### Fichiers clés
- `prisma/schema.prisma` : schéma core
- `prisma/seed.ts` : seed initial (tenants + super admin + owners)
- `src/lib/db.ts` : PrismaClient unique + `testDbConnection()`
- `src/modules/tenants/tenants.service.ts` : lecture DB via Prisma
- `src/modules/health/health.routes.ts` : `/health/db` utilise Prisma

### Commandes
```bash
# Migration
npx prisma migrate dev --name init_core_schema

# Seed
npx prisma db seed

# Tests API
curl http://localhost:4000/api/v1/tenants
```

### Résultats
- Prisma installé et configuré
- Schéma core créé
- Migration `init_core_schema` appliquée
- Seed initial exécuté (3 tenants + super admin + owners/admins)
- `/api/v1/tenants` lit désormais la DB (plus de mocks)

---

## PH11-03 — Users, Teams & Auth réelle

### Objectif
Mettre en place l'auth réelle basée sur la table `User` : hash des mots de passe, login avec JWT signé, protection des routes, et préparation multi-tenant (super_admin vs tenant user).

### Réalisations

#### Auth réelle
- `/api/v1/auth/login` utilise Prisma + bcrypt (passwordHash en DB) et signe un JWT (fastify-jwt)
- Plugin JWT : `src/config/jwt.ts` avec décorateur `authenticate` (401 si non autorisé)
- Tenants API sécurisée : `/api/v1/tenants` nécessite un JWT
  - `super_admin` voit tous les tenants
  - user non super_admin voit uniquement son tenant

#### Seed avec mots de passe hashés (bcrypt)
- `admin@keybuzz.io` (SUPER_ADMIN) — password: `change-me`
- `owner@acme-electronics.com` — `owner-acme-123`
- `admin@techcorp-solutions.com` — `admin-techcorp-123`
- `owner@globex-retail.com` — `owner-globex-123`

### Fichiers clés
- `src/config/jwt.ts` : plugin fastify-jwt + décorateur `authenticate`
- `src/modules/auth/auth.service.ts` : `loginWithEmailPassword`, `hashPassword`
- `src/modules/auth/auth.routes.ts` : POST `/api/v1/auth/login`
- `src/modules/tenants/tenants.routes.ts` : route protégée
- `src/modules/tenants/tenants.service.ts` : filtrage par rôle/tenant, via Prisma
- `prisma/seed.ts` : seeds avec passwords hashés
- `package.json` : dépendances bcrypt, @types/bcrypt

### Flux Auth
1. POST `/api/v1/auth/login` avec email/password
2. Vérification hash bcrypt (`passwordHash` en DB)
3. Si OK : retour `{ user, token }` (payload JWT: sub, tenantId, role, email)
4. Routes protégées : `preHandler: (app as any).authenticate` + accès `request.user`

### Commandes
```bash
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

### Note DB
Migration/seed bloqués actuellement par P1000 (auth DB invalide sur 10.0.0.10:5432). Fournir des identifiants valides puis relancer.

---

## PH11-04A — Tickets, AI & Billing Schema

### Objectif
Étendre le schéma Prisma pour ajouter les modèles Tickets, Messages, Events, AI Rules, Billing Usage & Quotas.

### Contenu ajouté

#### Tickets & Messaging
- **Ticket** : `id`, `tenantId`, `customerName`, `customerEmail`, `externalId`, `channel`, `status`, `priority`, `subject`, timestamps, `firstResponseAt`, `resolvedAt`, `category`, `sentiment`
- **TicketMessage** : `id`, `ticketId`, `tenantId`, `senderType`, `senderId`, `senderName`, `sentAt`, `body`, `isInternal`, `source`
- **TicketEvent** : `id`, `ticketId`, `tenantId`, `type`, `createdAt`, `actorType`, `actorId`, `payload` (Json)
- **TicketAssignment** : `id`, `ticketId`, `tenantId`, `userId?`, `teamId?`, `createdAt`

**Enums** :
- `TicketStatus` : OPEN, PENDING, WAITING_CUSTOMER, RESOLVED, ESCALATED, CLOSED
- `TicketPriority` : LOW, NORMAL, HIGH, URGENT
- `TicketChannel` : AMAZON, CDISCOUNT, FNAC, MANOMANO, RAKUTEN, VINTED, BACKMARKET, MANUAL, OTHER
- `MessageSenderType` : CUSTOMER, AGENT, AI, SYSTEM
- `MessageSource` : MARKETPLACE, KEYBUZZ_UI, API, AI, OTHER
- `TicketEventType` : MESSAGE_RECEIVED, MESSAGE_SENT, STATUS_CHANGED, PRIORITY_CHANGED, SLA_BREACHED, SLA_RESTORED, ASSIGNMENT_CHANGED, AI_SUGGESTION_CREATED, AI_REPLY_SENT, AI_RULE_EXECUTED, TICKET_AUTO_CLOSED
- `EventActorType` : CUSTOMER, AGENT, AI, SYSTEM

#### AI Rules & Executions
- **AiRule** : `id`, `tenantId`, `name`, `description`, `isActive`, `trigger`, `executionMode`, timestamps
- **AiRuleCondition** : `id`, `ruleId`, `field`, `operator`, `value`
- **AiRuleAction** : `id`, `ruleId`, `type`, `params` (Json)
- **AiRuleExecution** : `id`, `ruleId`, `ticketId`, `tenantId`, `triggeredAt`, `result`, `details` (Json)
- **AiResponseDraft** : `id`, `ticketId`, `tenantId`, `createdAt`, `createdByRule`, `body`, `confidence`, `used`

**Enums** :
- `AiTriggerType` : INCOMING_MESSAGE, NO_ANSWER_TIMEOUT, ORDER_ISSUE, RETURN_REQUEST, NEGATIVE_SENTIMENT
- `AiExecutionMode` : DISABLED, SUGGEST_ONLY, AUTO_EXECUTE
- `ConditionOperator` : EQUALS, NOT_EQUALS, CONTAINS, NOT_CONTAINS, IN, NOT_IN, GREATER_THAN, LESS_THAN
- `AiActionType` : SEND_REPLY, SET_STATUS, ADD_TAG, REQUEST_MORE_INFO, ESCALATE
- `AiExecutionResult` : SKIPPED, SUCCESS, FAILED

#### Billing & Quotas
- **TenantBillingPlan** : `id`, `tenantId`, `plan`, `ticketMonthlyQuota`, `softLimitPercent` (default 80), `hardLimitPercent` (default 100), `autoRechargeEnabled`, `autoRechargeUnits` (default 100), `ticketUnitPrice`, `aiActionUnitPrice`, timestamps
- **TenantQuotaUsage** : `id`, `tenantId`, `periodStart`, `periodEnd`, `ticketsCount`, `aiActionsCount`, `autoRecharges`, `lastUpdatedAt`
- **TicketBillingUsage** : `id`, `tenantId`, `ticketId` (unique), `aiActionsCount`, `humanMessagesCount`, `autoReplyCount`, `tokensUsed`, `billableUnits`, `calculatedAmount`, `finalized`, timestamps

### Commandes Prisma
```bash
cd /opt/keybuzz/keybuzz-backend
npx prisma format
npx prisma migrate dev --name ph11_04_tickets_ai_billing   # ⚠️ P1000 si DB creds invalides
npx prisma generate
```

### État DB
- Migration tentée : `P1000` (auth DB invalide sur 10.0.0.10:5432)
- Le schéma est prêt ; appliquer dès que les identifiants Postgres valides seront fournis

### Intégrations prévues (PH11-04C)
- Règles IA : déclencheurs, conditions, actions, journalisation `AiRuleExecution`, drafts `AiResponseDraft`
- SLA avancé : cron/workers pour firstResponseAt, resolvedAt, auto-close
- Billing avancé : agrégation mensuelle (`TenantQuotaUsage`), plan et auto-recharge (`TenantBillingPlan`)

---

## PH11-04B — Tickets API (Services & Routes)

### Objectif
Exposer les routes Tickets/Messages sécurisées JWT, multi-tenant, avec journalisation d'événements et préparation IA/billing.

### Routes API

#### Tickets
- **GET `/api/v1/tickets`** : Liste des tickets (order desc createdAt)
  - `super_admin` : tous les tickets
  - autres rôles : tickets du tenant courant
  - Retourne : `{ data: TicketDto[] }`
- **GET `/api/v1/tickets/:ticketId`** : Détail d'un ticket
  - 404 si non trouvé ou autre tenant
  - Retourne : `{ data: TicketDto }`

#### Messages
- **GET `/api/v1/tickets/:ticketId/messages`** : Liste des messages d'un ticket
  - Retourne : `{ data: TicketMessage[] }`
- **POST `/api/v1/tickets/:ticketId/messages`** : Ajoute un message
  - Body : `{ body: string, isInternal?: boolean }`
  - Retourne : `{ data: TicketMessage }`

Toutes les routes sont protégées par JWT (`preHandler: authenticate`).

### Services

#### `tickets.service.ts`
- **`listTicketsForUser(user: AuthUser)`** : Liste filtrée par tenant (sauf super_admin)
- **`getTicketById(user: AuthUser, ticketId: string)`** : Détail avec vérification appartenance tenant
- **`mapTicketToDto(t: Ticket)`** : Mapping Prisma → DTO UI-friendly (status/priority/channel en lowercase)

#### `messages.service.ts`
- **`listMessagesForTicket(user: AuthUser, ticketId: string)`** : Liste filtrée par tenant
- **`addMessageToTicket(user, ticketId, body, isInternal)`** :
  - Crée `TicketMessage`
  - Crée `TicketEvent` (MESSAGE_SENT ou MESSAGE_RECEIVED)
  - Upsert `TicketBillingUsage.humanMessagesCount` (incrémente)
  - TODO PH11-04C : firstResponseAt, SLA, IA hooks

### Multi-tenant
- `super_admin` : accès global à tous les tickets
- autres rôles : accès restreint à `user.tenantId`
- 404 si ticket non trouvé, 403 si autre tenant (messages)

### JWT & Sécurité
- Plugin `authenticate` (fastify-jwt) déjà en place
- `request.user` disponible après vérification JWT
- Vérification d'appartenance tenant sur chaque opération

### Billing & Events (base)
- `TicketBillingUsage` incrémenté sur ajout de message (humain)
- `TicketEvent` créé pour chaque message (MESSAGE_SENT/RECEIVED)
- Hooks prévus (PH11-04C) : SLA (firstResponseAt, resolvedAt), IA (AiRuleExecution, AiResponseDraft), auto-close, quotas

### Fichiers ajoutés
- `src/modules/tickets/tickets.types.ts` : Types TypeScript (TicketStatus, TicketPriority, TicketDto)
- `src/modules/tickets/tickets.service.ts` : Services de lecture tickets
- `src/modules/tickets/tickets.routes.ts` : Routes GET tickets
- `src/modules/tickets/messages.service.ts` : Services messages (list/add)
- `src/modules/tickets/messages.routes.ts` : Routes GET/POST messages
- `src/main.ts` : Enregistrement routes tickets/messages

### Commandes
```bash
# Lint & build
npm run lint
npm run build

# Tests API (nécessite un JWT valide)
TOKEN="...jwt..."
curl http://localhost:4000/api/v1/tickets -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/api/v1/tickets/<id> -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/api/v1/tickets/<id>/messages -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4000/api/v1/tickets/<id>/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"Message text","isInternal":false}'
```

### État DB
- Schéma PH11-04A requis (tickets/messages/events/billing)
- Migration peut rester en attente si DB credentials manquants (P1000)

---

## 📊 Résumé de l'état actuel

### ✅ Complété
- PH11-01 : Backend Foundation (Fastify + TS + Postgres)
- PH11-02 : Schéma Prisma core (Tenants, Users, Teams, ApiKeys, Webhooks)
- PH11-03 : Auth réelle (bcrypt + JWT + protection routes)
- PH11-04A : Schéma Tickets/AI/Billing (prêt, migration non appliquée)
- PH11-04B : Tickets API (Services & Routes - list/get, messages, multi-tenant, JWT, billing base)

### ⚠️ En attente
- Credentials Postgres valides pour appliquer les migrations
- PH11-04C : SLA avancé, IA Rules & Executions, Billing avancé (quotas, auto-recharge)

### 🔧 Stack technique
- **Runtime** : Node.js 22
- **Language** : TypeScript (strict mode)
- **Framework** : Fastify 5.6.2
- **ORM** : Prisma 6.3.0
- **DB** : PostgreSQL
- **Auth** : bcrypt 5.1.1, fastify-jwt 4.1.3
- **Validation** : Zod 4.1.13
- **Security** : @fastify/helmet, @fastify/cors
- **Docs** : @fastify/swagger, @fastify/swagger-ui

### 📁 Structure du projet
```
/opt/keybuzz/keybuzz-backend/
├── src/
│   ├── main.ts
│   ├── config/
│   │   ├── env.ts
│   │   ├── logger.ts
│   │   └── jwt.ts
│   ├── lib/
│   │   └── db.ts
│   └── modules/
│       ├── health/
│       ├── tenants/
│       ├── auth/
│       └── tickets/
│           ├── tickets.types.ts
│           ├── tickets.service.ts
│           ├── tickets.routes.ts
│           ├── messages.service.ts
│           └── messages.routes.ts
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── package.json
├── tsconfig.json
├── Dockerfile
└── *.md (documentation)
```

---

**Documentation complète KeyBuzz Backend v3 — Prêt pour PH11-04C (SLA, IA Rules & Billing avancé)**

