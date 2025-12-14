# PH11-06A — Amazon SP-API Polling (Read-Only) + Self-Serve Foundations

**Date** : 14/12/2025  
**Status** : ✅ Implémenté

---

## 🎯 Objectif

Implémenter le polling read-only des messages Amazon vers KeyBuzz (tickets/messages) avec architecture self-serve pour PH11-06B.

**PH11-06A** : Cadre + polling + mock client  
**PH11-06B** : OAuth SP-API réel + write-back  
**PH11-06C** : CronJob K8s + queue + rate limiting

---

## 📊 Tables Prisma Ajoutées

### 1. `MarketplaceConnection`
Connexion marketplace par tenant (multi-marketplace).

```prisma
model MarketplaceConnection {
  id            String
  tenantId      String
  type          MarketplaceType (AMAZON, FNAC, CDISCOUNT, OTHER)
  status        MarketplaceConnectionStatus (PENDING, CONNECTED, ERROR, DISABLED)
  displayName   String?
  region        String? // "EU", "NA"
  marketplaceId String? // Amazon marketplace id
  vaultPath     String? // Path du secret dans Vault
  lastSyncAt    DateTime?
  lastError     String?
  timestamps
}
```

### 2. `MarketplaceSyncState`
État de synchronisation (cursor, timestamps).

```prisma
model MarketplaceSyncState {
  id            String
  connectionId  String
  tenantId      String
  type          MarketplaceType
  cursor        String? // Token/cursor Amazon
  lastPolledAt  DateTime?
  lastSuccessAt DateTime?
  lastError     String?
  timestamps
}
```

### 3. `ExternalMessage`
Messages externes (idempotent, anti-dup).

```prisma
model ExternalMessage {
  id           String
  tenantId     String
  connectionId String
  type         MarketplaceType
  externalId   String // Unique id message Amazon
  threadId     String?
  orderId      String?
  buyerName    String?
  buyerEmail   String?
  language     String?
  receivedAt   DateTime
  raw          Json
  ticketId     String? // Mapping KeyBuzz
  createdAt    DateTime

  @@unique([type, connectionId, externalId])
}
```

---

## 🏗️ Architecture Modules

### `src/modules/marketplaces/amazon/`

1. **`amazon.types.ts`** : Types TypeScript
   - `AmazonInboundMessage`
   - `AmazonFetchResult`
   - `AmazonFetchParams`

2. **`amazon.client.ts`** : Client Amazon (interface + mock)
   - `AmazonClient` interface
   - `AmazonClientMock` (PH11-06A)
   - `createAmazonClient()` factory
   - TODO PH11-06B : `AmazonClientReal` (SP-API)

3. **`amazon.service.ts`** : Services DB + mapping
   - `ensureAmazonConnection()` : Crée/récupère connection
   - `upsertExternalMessage()` : Idempotent
   - `mapExternalMessageToTicket()` : Crée Ticket + TicketMessage + TicketEvent

4. **`amazon.poller.ts`** : Polling logic
   - `pollAmazonForTenant()` : Poll 1 tenant
   - `pollAmazonForAllTenants()` : Poll tous les tenants

5. **`amazon.routes.ts`** : API routes
   - `GET /api/v1/marketplaces/amazon/status` : Status connection
   - `POST /api/v1/marketplaces/amazon/connect` : Placeholder OAuth
   - `POST /api/v1/marketplaces/amazon/mock/connect` : Dev only

---

## 🔄 Worker Polling

### `src/workers/amazonPollingWorker.ts`

**Modes** :
- `--once` : Run une seule fois (test/debug)
- Loop : Poll continu toutes les `KEYBUZZ_AMAZON_POLL_INTERVAL_SECONDS` (default 60s)

**Lancement** :
```bash
npm run build
npm run worker:amazon:once           # Test
npm run worker:amazon                # Loop (dev)
node dist/workers/amazonPollingWorker.js --once  # Prod
```

**Logs** :
- Nombre de tenants pollés
- Nombre de messages fetchés
- Erreurs par tenant/message
- Timestamps de début/fin

---

## 🔐 Secrets & Vault

**PH11-06A** : Pas encore de vrais tokens Amazon.

**Contract de stockage** (PH11-06B) :
- Path Vault : `secret/keybuzz/tenants/<tenantId>/amazon/*`
- `MarketplaceConnection.vaultPath` pointe vers ce chemin
- PH11-06A : `vaultPath = null` sauf en dev mock

---

## 🧪 Idempotence

### Anti-duplicata

1. **`ExternalMessage`** : `@@unique([type, connectionId, externalId])`
   - Si message déjà existant, `upsert` ne crée pas de doublon

2. **`Ticket`** : Recherche par `externalId` (threadId ou orderId)
   - Si ticket existe, ajoute message (sans dup)

3. **`TicketMessage`** : Simple check body (peut être amélioré)

### Résultat

**Même message polled 10x → 1 seul Ticket + 1 seul TicketMessage créé** ✅

---

## 📡 API Endpoints

### `GET /api/v1/marketplaces/amazon/status`
Retourne status connection Amazon pour le tenant.

**Response** :
```json
{
  "connected": true,
  "status": "CONNECTED",
  "displayName": "Amazon (Dev Mock)",
  "region": "EU",
  "lastSyncAt": "2025-12-14T12:00:00Z",
  "lastError": null
}
```

### `POST /api/v1/marketplaces/amazon/connect`
Placeholder pour self-serve OAuth (PH11-06B).

**PH11-06A** : Crée connection `PENDING` + retourne instructions.

**Response** :
```json
{
  "message": "Amazon connection initiated",
  "status": "pending",
  "instructions": "OAuth flow will be implemented in PH11-06B...",
  "connectionId": "clxxxxx"
}
```

### `POST /api/v1/marketplaces/amazon/mock/connect`
**Dev only** (require `KEYBUZZ_DEV_MODE=true`).

Crée connection `CONNECTED` + trigger immediate poll.

**Response** :
```json
{
  "message": "Mock Amazon connection created and polled",
  "connectionId": "clxxxxx",
  "status": "CONNECTED"
}
```

---

## 🧪 Tests & Validation

### 1. Migration Prisma
```bash
cd /opt/keybuzz/keybuzz-backend
npx prisma migrate dev --name ph11_06a_amazon_connections_external_messages
npx prisma generate
```

### 2. Seed Dev Connection (optionnel)
Ajouter dans `prisma/seed.ts` une `MarketplaceConnection` `CONNECTED` pour un tenant.

### 3. Build
```bash
npm run build
```

### 4. Test Worker Once
```bash
npm run worker:amazon:once
```

**Vérifier DB** :
- `ExternalMessage` : 3 messages mock
- `Ticket` : 3 tickets créés (AMAZON channel)
- `TicketMessage` : 3 messages CUSTOMER
- `TicketEvent` : 3 events MESSAGE_RECEIVED

### 5. Test API
```bash
# Get status
curl http://localhost:4000/api/v1/marketplaces/amazon/status \
  -H "Authorization: Bearer <JWT>"

# Mock connect (dev)
curl -X POST http://localhost:4000/api/v1/marketplaces/amazon/mock/connect \
  -H "Authorization: Bearer <JWT>"
```

---

## 📋 Mock Messages

### Message 1 (FR)
- **buyerName** : Jean Dupont
- **subject** : Où est ma commande ?
- **body** : Bonjour, je n'ai toujours pas reçu ma commande...
- **language** : fr

### Message 2 (ES) ⚠️
- **buyerName** : Maria García
- **subject** : Producto defectuoso
- **body** : ...voy a abrir un caso **A-to-Z** ← Keyword sensible
- **language** : es

### Message 3 (EN)
- **buyerName** : John Smith
- **subject** : Wrong item received
- **body** : I ordered a blue shirt size M but received...
- **language** : en

**Résultat attendu** :
- Message 2 → Ticket créé mais **auto-send bloqué** par safety gate (`sensitive_keyword_detected: a-to-z`)

---

## ⚠️ Limitations PH11-06A

1. **Pas de vraie SP-API** : Client mock uniquement
2. **Pas d'OAuth** : Connection manuelle/dev
3. **Pas de write-back** : Read-only (polling uniquement)
4. **Pas de CronJob K8s** : Worker manuel
5. **Pas de queue** : Synchrone, pas de retry intelligent

---

## 🚀 Prochaines Étapes

### PH11-06B : OAuth + SP-API Réel
- Implémenter OAuth Amazon Seller Central
- `AmazonClientReal` avec vraie SP-API
- Self-serve complet (UI + callback)
- Stockage tokens dans Vault

### PH11-06C : Production Ready
- CronJob Kubernetes
- Queue (Bull/Redis) pour resilience
- Rate limiting SP-API
- Retry exponential backoff
- Monitoring/alerting

### PH11-06D : Write-Back
- Send reply to Amazon (SP-API CreateMessage)
- Sync status ticket → Amazon case
- Bidirectionnel complet

---

## 📦 Fichiers Créés

```
prisma/schema.prisma (modifiée)
src/modules/marketplaces/
  marketplaces.types.ts
  marketplaces.routes.ts
  amazon/
    amazon.types.ts
    amazon.client.ts
    amazon.service.ts
    amazon.poller.ts
    amazon.routes.ts
src/workers/
  amazonPollingWorker.ts
src/main.ts (modifiée)
package.json (modifiée - scripts worker)
```

---

_Implémenté le 14/12/2025 — PH11-06A_

