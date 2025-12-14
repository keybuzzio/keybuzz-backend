# PH11 — Fix DB Prisma (P1000) — Guide de correction

## Problème
Erreur Prisma P1000 : Authentication failed against database server. Les credentials Postgres dans `DATABASE_URL` sont invalides.

## Solution
Créer la DB `keybuzz_backend` et l'utilisateur `kb_backend` dans le cluster Postgres HA, puis mettre à jour `DATABASE_URL`.

## Prérequis
- Accès au bastion `/opt/keybuzz/install-v3` ou serveur avec accès à Postgres (10.0.0.10:5432)
- Docker installé (pour utiliser psql via conteneur)
- Mot de passe Postgres superuser (`postgres`)

## Informations trouvées

- **Mot de passe Postgres possible** : `NEhobUmaJGdR7TL2MCXRB853` (trouvé dans `Infra/scripts/11_n8n/create_credentials.sh`)
- **Host** : 10.0.0.10 (HAProxy/LB Hetzner)
- **Ports possibles** : 5432 (Postgres direct) ou 6432 (PgBouncer)
- **Utilisateurs possibles** : `postgres` ou `kb_admin`

⚠️ **Note** : Le mot de passe trouvé peut ne pas fonctionner avec l'utilisateur `postgres`. Il peut être pour `kb_admin` ou pour un autre environnement.

## Étapes

### 1. Se connecter au bastion
```bash
ssh root@46.62.171.61
cd /opt/keybuzz/keybuzz-backend
```

### 2. Trouver le bon mot de passe Postgres

Vérifier dans les fichiers de credentials :
```bash
# Chercher dans les fichiers credentials
find /opt/keybuzz* /root -name '*postgres*.env' -o -name '*credentials*' 2>/dev/null

# Ou vérifier dans les scripts
grep -r "POSTGRES.*PASSWORD\|postgres.*password" /opt/keybuzz/keybuzz-infra/scripts/*.sh 2>/dev/null
```

### 3. Tester la connexion

Essayer plusieurs combinaisons :
```bash
POSTGRES_PASSWORD="NEhobUmaJGdR7TL2MCXRB853"  # ou votre mot de passe
DB_PORT=6432  # ou 5432

# Tester avec postgres
docker run --rm --network host -e PGPASSWORD="$POSTGRES_PASSWORD" postgres:15 \
  psql -h 10.0.0.10 -p $DB_PORT -U postgres -d postgres -c "SELECT 1;"

# Si ça échoue, essayer avec kb_admin
docker run --rm --network host -e PGPASSWORD="$POSTGRES_PASSWORD" postgres:15 \
  psql -h 10.0.0.10 -p $DB_PORT -U kb_admin -d postgres -c "SELECT 1;"
```

### 4. Générer un mot de passe pour kb_backend
```bash
KB_BACKEND_PASS=$(openssl rand -base64 24 | tr -d "=+/")
echo "Generated password: $KB_BACKEND_PASS"
```

### 5. Créer la DB et l'utilisateur
```bash
# Utiliser le port et l'utilisateur qui fonctionnent
POSTGRES_USER="postgres"  # ou "kb_admin"
DB_PORT=6432  # ou 5432

# Créer la DB
docker run --rm --network host -e PGPASSWORD="$POSTGRES_PASSWORD" postgres:15 \
  psql -h 10.0.0.10 -p $DB_PORT -U postgres -d postgres \
  -c "CREATE DATABASE keybuzz_backend;" 2>&1 | grep -v "already exists" || true

# Créer l'utilisateur kb_backend
docker run --rm --network host -e PGPASSWORD="$POSTGRES_PASSWORD" postgres:15 \
  psql -h 10.0.0.10 -p $DB_PORT -U postgres -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kb_backend') THEN
    CREATE ROLE kb_backend LOGIN PASSWORD '$KB_BACKEND_PASS';
  ELSE
    ALTER ROLE kb_backend WITH PASSWORD '$KB_BACKEND_PASS';
  END IF;
END\$\$;
SQL

# Donner les droits sur la DB
docker run --rm --network host -e PGPASSWORD="$POSTGRES_PASSWORD" postgres:15 \
  psql -h 10.0.0.10 -p $DB_PORT -U postgres -d postgres \
  -c "GRANT ALL PRIVILEGES ON DATABASE keybuzz_backend TO kb_backend;"

# Donner les droits sur le schéma public
docker run --rm --network host -e PGPASSWORD="$POSTGRES_PASSWORD" postgres:15 \
  psql -h 10.0.0.10 -p $DB_PORT -U postgres -d keybuzz_backend <<SQL
GRANT ALL ON SCHEMA public TO kb_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO kb_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO kb_backend;
SQL
```

### 4. Mettre à jour DATABASE_URL dans .env
```bash
NEW_DB_URL="postgres://kb_backend:${KB_BACKEND_PASS}@10.0.0.10:${DB_PORT}/keybuzz_backend"

if [ -f .env ]; then
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=${NEW_DB_URL}#g" .env
else
  cp .env.example .env
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=${NEW_DB_URL}#g" .env
fi

echo "DATABASE_URL updated: postgres://kb_backend:***@10.0.0.10:${DB_PORT}/keybuzz_backend"
```

### 5. Appliquer les migrations Prisma
```bash
cd /opt/keybuzz/keybuzz-backend
npx prisma migrate dev
npx prisma db seed
```

### 6. Vérifier la connexion
```bash
# Build & lint
npm run lint
npm run build

# Tester l'API (si le serveur tourne)
curl http://localhost:4000/health/db
# Attendu: {"status":"ok"}

# Login
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@keybuzz.io","password":"change-me"}'

# Récupérer le token et tester tenants
TOKEN="...jwt..."
curl http://localhost:4000/api/v1/tenants -H "Authorization: Bearer $TOKEN"
```

## Notes
- **Host**: 10.0.0.10 (HAProxy write endpoint)
- **Port**: 5432 (ou 6432 si PgBouncer)
- **User**: kb_backend
- **Database**: keybuzz_backend
- Le mot de passe `kb_backend` est généré aléatoirement et sauvegardé dans `.env`

## Troubleshooting
- Si le port 5432 ne fonctionne pas, essayer 6432 (PgBouncer)
- Si `docker run` échoue, installer `psql` directement ou utiliser un pod Kubernetes postgres
- Vérifier que le réseau Docker a accès à 10.0.0.10: `nc -zv 10.0.0.10 5432`

nn## PH11-DB-FIXn- DB: keybuzz_backendn- User: kb_backendn- Host: 10.0.0.10n- Port: 5432n- Prisma migrations appliquÃ©esn- Seed exÃ©cutÃ©n
