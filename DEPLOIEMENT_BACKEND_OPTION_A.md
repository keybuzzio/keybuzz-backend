# 🚀 Déploiement Backend - Option A (eComLG + Mock)

**Date:** 2025-12-14  
**Status:** Prêt pour déploiement  
**Credentials:** eComLG (temporaire)

---

## 🎯 Objectif

Déployer le backend KeyBuzz en production avec :
- ✅ OAuth Amazon fonctionnel (credentials eComLG)
- ✅ Polling worker avec mock (messages de test)
- ✅ Architecture complète prête

---

## ⚠️ Prérequis

Avant de commencer, tu dois avoir :

1. ✅ **Vault token** avec accès à `secret/keybuzz/ai/*`
2. ✅ **DATABASE_URL** (password PostgreSQL `kb_backend`)
3. ✅ **JWT_SECRET** (secret actuel de prod)
4. ✅ **KEYBUZZ_SUPERADMIN_PASSWORD**

---

## 📋 **Étapes de Déploiement**

### Étape 1 : Compléter `.env.production`

Sur `install-v3`, édite le fichier `.env.production` :

```bash
cd /opt/keybuzz/keybuzz-backend
nano .env.production
```

**Remplace les `***` par les vraies valeurs :**

```env
# Database
DATABASE_URL=postgresql://kb_backend:VRAI_PASSWORD@10.0.0.10:5432/keybuzz_backend

# JWT
JWT_SECRET=VRAI_JWT_SECRET

# Superadmin
KEYBUZZ_SUPERADMIN_PASSWORD=VRAI_PASSWORD

# Vault
VAULT_ADDR=https://vault.keybuzz.io:8200
VAULT_TOKEN=VRAI_VAULT_TOKEN

# LiteLLM
KEYBUZZ_AI_API_KEY=VRAI_RUNTIME_KEY
```

**Note :** Les credentials Amazon sont déjà dans le fichier (eComLG).

---

### Étape 2 : Tester localement

```bash
cd /opt/keybuzz/keybuzz-backend

# Charger l'env
export $(cat .env.production | grep -v '^#' | xargs)

# Build
npm run build

# Démarrer
npm run start

# Vérifier
curl http://localhost:4000/health
```

**Résultat attendu :** HTTP 200 ou 404 (backend OK)

---

### Étape 3 : Tester OAuth start

```bash
# Récupérer un JWT admin valide (à adapter)
JWT="YOUR_ADMIN_JWT"

curl -X POST http://localhost:4000/api/v1/marketplaces/amazon/oauth/start \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json"
```

**Résultat attendu :**
```json
{
  "authUrl": "https://sellercentral.amazon.com/apps/authorize/consent?...",
  "expiresAt": "2025-12-14T...",
  "message": "Redirect user to authUrl..."
}
```

✅ **Si ça marche, l'OAuth est opérationnel !**

---

### Étape 4 : Tester le polling worker (mock)

```bash
cd /opt/keybuzz/keybuzz-backend
export $(cat .env.production | grep -v '^#' | xargs)
export AMAZON_USE_MOCK=true

npm run worker:amazon:once
```

**Résultat attendu :**
```
[Amazon Poller] Starting poll for tenant: <tenantId>
[Amazon Poller] Fetched 3 messages for tenant <tenantId>
[Amazon Poller] Poll completed for tenant: <tenantId>
```

**En DB :**
- 3 `ExternalMessage` créés
- 3 `Ticket` créés
- 3 `TicketMessage` créés

---

### Étape 5 : Déployer avec PM2 (ou systemd)

#### Option A : PM2

```bash
cd /opt/keybuzz/keybuzz-backend

# Installer PM2 si pas déjà fait
npm install -g pm2

# Démarrer le backend
pm2 start dist/main.js --name keybuzz-backend --env production

# Vérifier
pm2 status
pm2 logs keybuzz-backend --lines 50

# Sauvegarder la config
pm2 save
pm2 startup
```

#### Option B : systemd

```bash
# Créer le service
sudo nano /etc/systemd/system/keybuzz-backend.service
```

**Contenu :**
```ini
[Unit]
Description=KeyBuzz Backend
After=network.target vault.service postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/keybuzz/keybuzz-backend
EnvironmentFile=/opt/keybuzz/keybuzz-backend/.env.production
ExecStart=/usr/bin/node /opt/keybuzz/keybuzz-backend/dist/main.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Activer et démarrer
sudo systemctl daemon-reload
sudo systemctl enable keybuzz-backend
sudo systemctl start keybuzz-backend

# Vérifier
sudo systemctl status keybuzz-backend
sudo journalctl -u keybuzz-backend -f
```

---

### Étape 6 : Déployer le polling worker (CronJob)

#### Option A : Cron Linux

```bash
crontab -e
```

**Ajouter :**
```cron
# Amazon polling worker - every 5 minutes
*/5 * * * * cd /opt/keybuzz/keybuzz-backend && export $(cat .env.production | grep -v '^#' | xargs) && /usr/bin/node dist/workers/amazonPollingWorker.js --once >> /var/log/amazon-polling.log 2>&1
```

#### Option B : PM2 Cron

```bash
pm2 start dist/workers/amazonPollingWorker.js \
  --name amazon-polling-worker \
  --cron "*/5 * * * *" \
  --no-autorestart
```

---

### Étape 7 : Vérifier le déploiement

#### Backend

```bash
# Health check
curl https://platform-api.keybuzz.io/health

# OAuth endpoint
curl https://platform-api.keybuzz.io/api/v1/marketplaces/amazon/status \
  -H "Authorization: Bearer $JWT"
```

#### Logs

```bash
# PM2
pm2 logs keybuzz-backend

# systemd
sudo journalctl -u keybuzz-backend -f

# Worker
tail -f /var/log/amazon-polling.log
```

---

## 🧪 **Tests End-to-End**

### Test 1 : OAuth Flow Complet

1. **Frontend** : User clique "Connect Amazon"
2. **Backend** : Appel `/oauth/start`
3. **Amazon** : User autorise sur Seller Central
4. **Callback** : Amazon redirige vers `/oauth/callback`
5. **Backend** : Stocke `refresh_token` dans Vault
6. **DB** : `MarketplaceConnection.status = CONNECTED`

**Vérification :**
```sql
SELECT * FROM "MarketplaceConnection" WHERE type = 'AMAZON';
```

---

### Test 2 : Polling Automatique

**Attendre 5 minutes (ou déclencher manuellement) :**

```bash
node dist/workers/amazonPollingWorker.js --once
```

**Vérification :**
```sql
SELECT COUNT(*) FROM "ExternalMessage" WHERE type = 'AMAZON';
SELECT COUNT(*) FROM "Ticket" WHERE channel = 'AMAZON';
```

---

## 🔄 **Basculer vers Credentials KeyBuzz (Futur)**

Quand tu auras les credentials KeyBuzz :

### 1. Stocker dans Vault

```bash
export VAULT_ADDR=https://vault.keybuzz.io:8200

vault kv put secret/keybuzz/ai/amazon_spapi_app \
  client_id="amzn1.application-oa2-client.KEYBUZZ_XXX" \
  client_secret="xxx" \
  redirect_uri="https://platform-api.keybuzz.io/api/v1/marketplaces/amazon/oauth/callback" \
  role_arn="arn:aws:iam::KEYBUZZ_ACCOUNT:role/SellingPartnerAPIRole" \
  region="eu-west-1" \
  app_source="keybuzz"
```

### 2. Changer 1 variable

```bash
nano /opt/keybuzz/keybuzz-backend/.env.production
```

**Modifier :**
```env
AMAZON_SPAPI_APP_SOURCE=keybuzz  # ← Changer de external_test à keybuzz
```

### 3. Restart

```bash
# PM2
pm2 restart keybuzz-backend

# systemd
sudo systemctl restart keybuzz-backend
```

### 4. Re-OAuth tous les tenants

Les anciens tokens eComLG ne fonctionneront plus. Chaque tenant doit :
1. Déconnecter Amazon (UI)
2. Reconnecter Amazon (nouveau OAuth avec app KeyBuzz)

---

## 📊 **Monitoring**

### Métriques Clés

```sql
-- Nombre de connexions Amazon actives
SELECT COUNT(*) FROM "MarketplaceConnection" 
WHERE type = 'AMAZON' AND status = 'CONNECTED';

-- Messages poll aujourd'hui
SELECT COUNT(*) FROM "ExternalMessage" 
WHERE type = 'AMAZON' AND "createdAt" >= CURRENT_DATE;

-- Tickets Amazon aujourd'hui
SELECT COUNT(*) FROM "Ticket" 
WHERE channel = 'AMAZON' AND "createdAt" >= CURRENT_DATE;
```

### Logs à surveiller

```bash
# Erreurs OAuth
grep -i "amazon oauth.*error" /var/log/keybuzz-backend.log

# Erreurs polling
grep -i "amazon poller.*error" /var/log/amazon-polling.log

# Token refresh failures
grep -i "token refresh failed" /var/log/keybuzz-backend.log
```

---

## 🚨 **Troubleshooting**

### Problème : "Invalid state"

**Cause :** State OAuth expiré (15 min) ou CSRF  
**Solution :** Redemander une nouvelle URL OAuth

---

### Problème : "Token exchange failed"

**Cause :** Credentials Vault incorrects ou expirés  
**Solution :** Vérifier `vault kv get secret/keybuzz/ai/amazon_spapi_app_temp`

---

### Problème : "Connection not CONNECTED"

**Cause :** OAuth pas complété  
**Solution :** Vérifier `MarketplaceConnection.status` et `lastError`

---

### Problème : "No credentials found"

**Cause :** Vault path invalide ou token insuffisant  
**Solution :** Vérifier `VAULT_ADDR`, `VAULT_TOKEN`, et path Vault

---

## ✅ **Checklist Déploiement**

- [ ] `.env.production` complété (DATABASE_URL, JWT_SECRET, etc.)
- [ ] Build OK (`npm run build`)
- [ ] Test local OK (OAuth `/start` + worker mock)
- [ ] Backend déployé (PM2 ou systemd)
- [ ] Polling worker déployé (cron ou PM2)
- [ ] Health check OK (`/health`)
- [ ] OAuth flow testé end-to-end (1 tenant)
- [ ] Polling automatique fonctionne (messages mock créés)
- [ ] Logs monitoring configurés
- [ ] Documentation accessible (`PH11-06B-*.md`)

---

## 🎉 **Résultat Final Attendu**

Après ce déploiement :

✅ Backend KeyBuzz tourne en production  
✅ OAuth Amazon self-serve fonctionnel (eComLG)  
✅ Tenants peuvent connecter leur compte Amazon  
✅ Polling automatique crée des tickets (mock)  
✅ Architecture prête pour SP-API réel (PH11-06B.2)  
✅ Switch vers KeyBuzz en 1 variable (futur)  

**Le produit est LIVE !** 🚀

---

**Prochaine étape :** Tester avec un vrai compte Amazon Seller et valider le flow complet ! 😊

