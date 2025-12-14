# PH11-DB-MIGRATIONS-LEADER — Fix "read-only transaction" pour Prisma

**Date** : 14/12/2025  
**Status** : ✅ Résolu

---

## 🎯 Problème

Prisma Migrate échoue avec :
```
ERROR: cannot execute CREATE TYPE in a read-only transaction
ERROR: cannot execute CREATE DATABASE in a read-only transaction (shadow DB)
```

**Cause** : HAProxy (`10.0.0.10:5432`) route vers un replica PostgreSQL (read-only) au lieu du leader (writable).

---

## ✅ Solution

Appliquer les migrations SQL **directement sur le leader PostgreSQL** (bypass HAProxy).

---

## 🏗️ Architecture DB

### Serveurs PostgreSQL
- **HAProxy** : `10.0.0.10:5432` (load balancer, route read + write)
- **Leader** : `10.0.0.122:5432` (writable, Patroni primary)
- **Replicas** : `10.0.0.123`, `10.0.0.124`, `10.0.0.125` (read-only)

### Credentials
- **User** : `kb_backend`
- **Password** : (voir `.env` → `DATABASE_URL`)
- **Database** : `keybuzz_backend`

---

## 📁 Scripts Disponibles

### 1. `scripts/db_migrate_leader.sh`
Script principal pour appliquer les migrations Prisma sur le leader.

**Fonctionnalités** :
- Auto-détecte le leader PostgreSQL (teste `pg_is_in_recovery()`)
- Construit `DATABASE_URL` vers le leader
- Exécute `prisma migrate deploy`
- Génère le client Prisma
- Logs dans `logs/db-migrations.log`

**Usage** :
```bash
cd /opt/keybuzz/keybuzz-backend
bash scripts/db_migrate_leader.sh
```

**Variables d'environnement** (optionnel) :
```bash
export DB_LEADER_IP=10.0.0.122  # Force une IP leader
bash scripts/db_migrate_leader.sh
```

### 2. `scripts/create_marketplace_tables.sql`
Migration SQL manuelle pour PH11-06A (tables marketplace).

**Contenu** :
- Enums : `MarketplaceType`, `MarketplaceConnectionStatus`
- Tables : `MarketplaceConnection`, `MarketplaceSyncState`, `ExternalMessage`
- Indexes + contraintes

**Usage** :
```bash
export PGPASSWORD=<password>
psql -h 10.0.0.122 -U kb_backend -d keybuzz_backend \
  -f scripts/create_marketplace_tables.sql
```

### 3. `scripts/verify_marketplace_tables.sh`
Vérifie que les tables marketplace ont été créées.

**Usage** :
```bash
bash scripts/verify_marketplace_tables.sh
```

---

## 🔄 Workflow Migration

### Méthode 1 : Script automatique (recommandé)
```bash
cd /opt/keybuzz/keybuzz-backend
bash scripts/db_migrate_leader.sh
```

### Méthode 2 : SQL manuel (fallback)
```bash
cd /opt/keybuzz/keybuzz-backend
export PGPASSWORD=$(grep DATABASE_URL .env | sed -n 's/.*:\([^@]*\)@.*/\1/p')
psql -h 10.0.0.122 -U kb_backend -d keybuzz_backend \
  -f scripts/create_marketplace_tables.sql
```

### Méthode 3 : Prisma direct sur leader
```bash
cd /opt/keybuzz/keybuzz-backend
export DATABASE_URL="postgresql://kb_backend:<password>@10.0.0.122:5432/keybuzz_backend"
npx prisma migrate deploy
npx prisma generate
```

---

## 🧪 Vérification

### Vérifier les tables marketplace
```bash
cd /opt/keybuzz/keybuzz-backend
source .env
export PGPASSWORD=$(echo $DATABASE_URL | sed -n 's/.*:\([^@]*\)@.*/\1/p')

psql -h 10.0.0.122 -U kb_backend -d keybuzz_backend << 'EOF'
SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename LIKE '%arketplace%'
ORDER BY tablename;
EOF
```

**Résultat attendu** :
```
 ExternalMessage
 MarketplaceConnection
 MarketplaceSyncState
```

### Vérifier les enums
```bash
psql -h 10.0.0.122 -U kb_backend -d keybuzz_backend << 'EOF'
SELECT typname FROM pg_type 
WHERE typtype = 'e' 
AND typname LIKE '%arketplace%';
EOF
```

**Résultat attendu** :
```
 MarketplaceType
 MarketplaceConnectionStatus
```

---

## 🔐 Sécurité

### Pourquoi `10.0.0.122` et pas HAProxy ?

**HAProxy (`10.0.0.10`)** :
- ✅ Bon pour les lectures (SELECT)
- ✅ Bon pour l'app runtime (load balancing)
- ❌ Mauvais pour les migrations (peut router vers replica read-only)

**Leader direct (`10.0.0.122`)** :
- ✅ Toujours writable
- ✅ Garantit que les migrations passent
- ✅ Pas de shadow DB errors

### Accès réseau
- ✅ Toutes les IPs DB sont sur réseau privé (`10.0.0.0/24`)
- ✅ Aucun accès public (SSH via `install-v3` uniquement)
- ✅ Patroni gère la HA (failover automatique)

---

## 📝 Historique

### PH11-06A (14/12/2025)
- **Problème** : `prisma migrate dev` échoue avec "read-only transaction"
- **Solution** : Migration SQL manuelle sur leader `10.0.0.122`
- **Tables créées** :
  - `MarketplaceConnection`
  - `MarketplaceSyncState`
  - `ExternalMessage`
- **Enums créés** :
  - `MarketplaceType`
  - `MarketplaceConnectionStatus`

---

## 🚀 Prochaines Migrations

Pour toutes les migrations futures :

1. **Créer la migration Prisma** (local ou dev) :
   ```bash
   npx prisma migrate dev --name <migration_name> --create-only
   ```

2. **Appliquer sur le leader** (prod) :
   ```bash
   bash scripts/db_migrate_leader.sh
   ```

3. **Vérifier** :
   ```bash
   bash scripts/verify_marketplace_tables.sh
   ```

---

## ⚠️ Notes Importantes

### Shadow Database
Prisma Migrate utilise une "shadow database" pour valider les migrations. Cela nécessite :
- Permission `CREATE DATABASE` (que `kb_backend` n'a pas)
- Connexion writable (que HAProxy ne garantit pas)

**Solution durable** : Utiliser `scripts/db_migrate_leader.sh` qui :
- Utilise `prisma migrate deploy` (pas de shadow DB)
- Se connecte directement au leader

### Patroni Failover
Si le leader change (failover Patroni) :
- Le script `db_migrate_leader.sh` auto-détecte le nouveau leader
- Ou forcer manuellement : `export DB_LEADER_IP=<new_leader_ip>`

---

## 📦 Fichiers Ajoutés

```
scripts/
  db_migrate_leader.sh              # Script principal migration
  create_marketplace_tables.sql      # Migration SQL PH11-06A
  verify_marketplace_tables.sh       # Vérification

logs/
  db-migrations.log                  # Logs migrations

PH11-DB-MIGRATIONS-LEADER.md         # Cette doc
```

---

_Documentation créée le 14/12/2025 — PH11-06A.1_

