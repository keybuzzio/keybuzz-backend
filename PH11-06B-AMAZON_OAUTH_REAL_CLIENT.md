# PH11-06B — Amazon SP-API OAuth + Polling (Option B: eComLG temporaire)

**Status:** ✅ Implémenté (étapes 1-3/4)  
**Date:** 2025-12-14  
**Objectif:** OAuth Amazon SP-API réel + polling read-only avec stockage Vault

---

## 🎯 Objectif

Implémenter le flow OAuth complet Amazon SP-API (LWA) pour permettre aux tenants de connecter leur compte Amazon Seller de manière autonome (self-serve), et activer le polling automatique des messages Amazon → KeyBuzz Tickets.

---

## 🏗️ Architecture

### Composants

1. **OAuth Service** (`amazon.oauth.ts`)
   - Génération URL consent Amazon
   - Validation state anti-CSRF
   - Échange authorization code → refresh token
   - Stockage sécurisé dans Vault

2. **Token Management** (`amazon.tokens.ts`)
   - Refresh access token depuis refresh_token
   - Cache en mémoire (3300s TTL)
   - Support multi-tenant

3. **SP-API Client** (`amazon.spapi.ts`)
   - Authentification AWS SigV4 (préparé)
   - Appels SP-API Buyer Communications
   - Normalisation messages

4. **Client Real** (`amazon.client.ts`)
   - `AmazonClientReal` : utilise credentials Vault
   - `AmazonClientMock` : données de test
   - Factory auto-switch mock/réel

5. **Poller** (`amazon.poller.ts`)
   - Poll tous les tenants avec connection `CONNECTED`
   - Idempotence via `ExternalMessage.externalId`
   - Mapping auto vers `Ticket` + `TicketMessage`

---

## 🔐 Sécurité

### Stockage Vault

**App credentials** (eComLG temporaire) :
```
secret/keybuzz/ai/amazon_spapi_app_temp
{
  "client_id": "amzn1.application-oa2-client.xxx",
  "client_secret": "amzn1.oa2-cs.v1.xxx",
  "redirect_uri": "https://platform-api.keybuzz.io/api/v1/marketplaces/amazon/oauth/callback",
  "role_arn": "arn:aws:iam::977099028401:role/SellingPartnerAPIRole",
  "region": "eu-west-1"
}
```

**Tenant credentials** (par tenant) :
```
secret/keybuzz/tenants/<tenantId>/amazon
{
  "refresh_token": "Atzr|xxx",
  "seller_id": "A12BCIS2R7HD4D",
  "marketplace_id": "A13V1IB3VIYZZH",
  "region": "eu-west-1",
  "created_at": "2025-12-14T..."
}
```

### Règles

- ✅ **Aucun secret en DB** (seulement `vaultPath`)
- ✅ **Aucun secret en log**
- ✅ **Aucun secret dans Git**
- ✅ Anti-CSRF via `state` (15 min TTL)
- ✅ Tokens cachés (3300s)

---

## 📡 API Endpoints

### 1. Start OAuth

**POST** `/api/v1/marketplaces/amazon/oauth/start`

**Headers:**
```
Authorization: Bearer <JWT>
```

**Response:**
```json
{
  "authUrl": "https://sellercentral.amazon.com/apps/authorize/consent?application_id=amzn1...&state=<uuid>&version=beta",
  "expiresAt": "2025-12-14T15:30:00Z",
  "message": "Redirect user to authUrl to authorize Amazon connection"
}
```

**Flow:**
1. User clicks "Connect Amazon" in UI
2. Frontend calls `/oauth/start`
3. Frontend redirects user to `authUrl`
4. User authorizes on Amazon Seller Central
5. Amazon redirects to callback with `code` + `state` + `selling_partner_id`

---

### 2. OAuth Callback

**GET** `/api/v1/marketplaces/amazon/oauth/callback`

**Query params:**
- `spapi_oauth_code` : Authorization code
- `state` : Anti-CSRF state
- `selling_partner_id` : Amazon seller ID

**Response:**
```json
{
  "success": true,
  "message": "Amazon connection successful",
  "sellingPartnerId": "A12BCIS2R7HD4D"
}
```

**Internal flow:**
1. Validate `state` (anti-CSRF)
2. Exchange `code` → `refresh_token` (LWA token endpoint)
3. Store credentials in Vault
4. Update `MarketplaceConnection.status = CONNECTED`
5. Clear OAuth state

---

### 3. Connection Status

**GET** `/api/v1/marketplaces/amazon/status`

**Headers:**
```
Authorization: Bearer <JWT>
```

**Response:**
```json
{
  "connected": true,
  "status": "CONNECTED",
  "displayName": "Amazon Seller A12BCIS2R7HD4D",
  "region": "EU",
  "lastSyncAt": "2025-12-14T12:00:00Z",
  "lastError": null
}
```

---

## 🔄 Polling Worker

### Fonctionnement

**Worker:** `src/workers/amazonPollingWorker.ts`

**Scripts npm:**
```bash
npm run worker:amazon          # Dev mode (auto-restart)
npm run worker:amazon:once     # Run once (CI/tests)
```

**Environnement:**
```env
AMAZON_USE_MOCK=false          # true = mock, false = real
MARKETPLACE_POLL_INTERVAL_SECONDS=60
```

### Logique

```
Pour chaque tenant avec MarketplaceConnection CONNECTED :
  1. Load credentials from Vault
  2. Get access_token (refresh si expired)
  3. Call SP-API /messaging/v1/...
  4. Normalize messages → AmazonInboundMessage
  5. Upsert ExternalMessage (idempotent)
  6. Map to Ticket + TicketMessage (idempotent)
  7. Update syncState.cursor + lastSuccessAt
```

---

## 🧪 Tests

### Test 1 : OAuth Start

```bash
curl -X POST http://localhost:4000/api/v1/marketplaces/amazon/oauth/start \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json"
```

**Résultat attendu:**
- HTTP 200
- `authUrl` valide
- `state` généré

---

### Test 2 : OAuth Callback (simulé)

```bash
# Remplacer <state> par le state du test 1
curl "http://localhost:4000/api/v1/marketplaces/amazon/oauth/callback?spapi_oauth_code=test&state=<state>&selling_partner_id=A12BCIS2R7HD4D"
```

**Note:** Échec attendu au token exchange (code fictif), mais valide la logique de routing.

---

### Test 3 : Polling Mock

```bash
export AMAZON_USE_MOCK=true
export MARKETPLACE_POLL_INTERVAL_SECONDS=10

npm run worker:amazon:once
```

**Résultat attendu:**
- Utilise `AmazonClientMock`
- Crée 3 messages mock
- Crée 3 `ExternalMessage`
- Crée 3 `Ticket` + `TicketMessage`

---

### Test 4 : Polling Real (avec credentials eComLG)

```bash
export AMAZON_USE_MOCK=false
export MARKETPLACE_POLL_INTERVAL_SECONDS=60

# S'assurer qu'un tenant a fait OAuth
npm run worker:amazon:once
```

**Résultat attendu:**
- Charge credentials depuis Vault
- Refresh access_token
- Call SP-API (actuellement retourne `[]` - placeholder)
- Pas d'erreur

---

## 🔧 Configuration Environnement

### Variables Vault (runtime)

```env
VAULT_ADDR=https://vault.keybuzz.io
VAULT_TOKEN=<token>
```

### Variables App

```env
# Switch app Amazon (temporaire vs finale)
AMAZON_SPAPI_APP_SOURCE=external_test  # ou "keybuzz"

# Mode polling
AMAZON_USE_MOCK=false
MARKETPLACE_POLL_INTERVAL_SECONDS=60
```

---

## 🚧 TODO PH11-06B.2 (Futurs)

### SP-API Réel

Actuellement, `fetchBuyerMessages()` retourne `[]` (placeholder).

**Pour activer le vrai SP-API:**

1. **Endpoint SP-API Buyer Communications**
   - `/messaging/v1/orders/{orderId}/messages`
   - Pagination via `nextToken`
   - Filter `createdAfter`

2. **AWS SigV4 Authentication**
   - Utiliser `generateAwsSignature()` (déjà implémenté)
   - Headers : `x-amz-access-token`, `Authorization`, `x-amz-date`
   - Assume IAM role (`role_arn`)

3. **Message Mapping**
   - Utiliser `normalizeSpApiMessage()` (déjà implémenté)
   - Parser `locale`, `text`, `messageId`
   - Extract `orderId` depuis context

4. **Rate Limiting**
   - SP-API rate limit : 1 req/s (burst 5)
   - Ajouter `p-limit` ou équivalent

---

## 📊 Database Schema

### MarketplaceConnection

```prisma
model MarketplaceConnection {
  id           String   @id @default(cuid())
  tenantId     String
  type         MarketplaceType  // AMAZON
  status       MarketplaceConnectionStatus  // CONNECTED
  vaultPath    String?  // "secret/keybuzz/tenants/<tenantId>/amazon"
  displayName  String?
  region       String?
  marketplaceId String?
  lastSyncAt   DateTime?
  lastError    String?
}
```

### MarketplaceSyncState

```prisma
model MarketplaceSyncState {
  id            String   @id
  tenantId      String
  connectionId  String
  type          MarketplaceType
  cursor        String?     // nextToken ou state OAuth temporaire
  lastPolledAt  DateTime?
  lastSuccessAt DateTime?
  lastError     String?
}
```

### ExternalMessage

```prisma
model ExternalMessage {
  id           String   @id
  tenantId     String
  connectionId String
  type         MarketplaceType
  externalId   String   // Amazon messageId (unique)
  threadId     String?
  orderId      String?
  buyerName    String?
  buyerEmail   String?
  language     String?
  receivedAt   DateTime
  raw          Json
  ticketId     String?  // Mapped Ticket

  @@unique([type, connectionId, externalId])
}
```

---

## 🔄 Migration vers App KeyBuzz (futur)

Actuellement, on utilise l'app eComLG (`AMAZON_SPAPI_APP_SOURCE=external_test`).

**Pour basculer vers l'app KeyBuzz:**

1. **Créer l'app dans Amazon Developer Console**
   - OAuth Redirect URI : `https://platform-api.keybuzz.io/api/v1/marketplaces/amazon/oauth/callback`
   - SP-API permissions : Messaging (read)

2. **Stocker les credentials dans Vault**
   ```bash
   vault kv put secret/keybuzz/ai/amazon_spapi_app \
     client_id="amzn1.application-oa2-client.KEYBUZZ" \
     client_secret="xxx" \
     redirect_uri="https://platform-api.keybuzz.io/api/v1/marketplaces/amazon/oauth/callback" \
     role_arn="arn:aws:iam::KEYBUZZ_ACCOUNT:role/SellingPartnerAPIRole" \
     region="eu-west-1"
   ```

3. **Switch env**
   ```env
   AMAZON_SPAPI_APP_SOURCE=keybuzz
   ```

4. **Re-OAuth tous les tenants**
   - Invalider les tokens eComLG
   - Demander aux tenants de re-connecter

---

## ✅ Résultat Final

### Ce qui est prêt (PH11-06B.1-3)

✅ OAuth complet (start + callback)  
✅ Stockage sécurisé Vault  
✅ Token refresh + cache  
✅ `AmazonClientReal` + factory  
✅ Poller idempotent  
✅ Mapping Amazon → Ticket/Message  
✅ Anti-CSRF  
✅ Multi-tenant  
✅ Mock/Real switch  

### Ce qui reste (PH11-06B.2)

⏳ SP-API Buyer Communications endpoint réel  
⏳ AWS SigV4 signing activé  
⏳ Pagination SP-API  
⏳ Rate limiting  

---

## 📞 Support

**Problèmes connus:**

1. **"Invalid state"** → State expiré (15 min TTL) ou CSRF
2. **"Token exchange failed"** → Credentials Vault incorrects
3. **"Connection not CONNECTED"** → OAuth pas complété
4. **"No credentials found"** → Vault path invalide

**Logs:**
```bash
# Worker logs
kubectl -n keybuzz-ai logs cronjob/amazon-polling-worker

# Backend logs
kubectl -n keybuzz-ai logs deploy/keybuzz-backend | grep -i amazon
```

---

**Fin de PH11-06B (étapes 1-3/4)**  
**Prochaine étape:** PH11-06B.4 - Déploiement + Tests End-to-End

