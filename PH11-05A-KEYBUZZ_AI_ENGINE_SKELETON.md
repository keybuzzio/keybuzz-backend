# PH11-05A — KeyBuzz AI Engine Skeleton

**Date** : 12 décembre 2025  
**Statut** : ✅ Terminé  
**Version** : 1.0

---

## 📋 Vue d'ensemble

Ce document décrit l'implémentation du squelette du moteur IA KeyBuzz (PH11-05A). Cette phase pose les fondations pour l'intégration des providers IA (OpenAI, Anthropic, LiteLLM) qui sera réalisée en PH11-05B.

---

## 🏗️ Architecture

### Structure des fichiers

```
src/modules/ai/
├── aiProviders.service.ts    # Abstraction des providers IA
├── aiEngine.service.ts        # Moteur IA principal
└── ai.routes.ts              # Route de test (développement)
```

### Composants

#### 1. `aiProviders.service.ts`

**Rôle** : Abstraction des providers IA avec support multi-provider.

**Interfaces** :
- `AiProviderRequest` : Paramètres de requête IA (model, prompt, maxTokens, temperature, lang)
- `AiProviderResponse` : Réponse du provider (content, tokensUsed, raw)
- `AiProviderName` : Types de providers supportés ("openai" | "anthropic" | "litellm" | "mock")

**Fonction principale** :
- `generateReply(req: AiProviderRequest): Promise<AiProviderResponse>`
  - Sélectionne le provider via `KEYBUZZ_AI_PROVIDER` (env)
  - Fallback sur "mock" si non configuré ou invalide
  - Pour l'instant, tous les providers retournent un mock

**Provider Mock** :
- Retourne une réponse simulée avec tokens fictifs (50 tokens)
- Permet de tester l'architecture sans appels IA réels

#### 2. `aiEngine.service.ts`

**Rôle** : Moteur IA principal pour l'exécution sur les tickets.

**Interfaces** :
- `AiExecutionOutcome` : Résultat d'une exécution IA (draftReply, tokensUsed, providerResponse)

**Fonction principale** :
- `runAiForTicket(ticketId: string, userContext?: AuthUser): Promise<AiExecutionOutcome>`
  - Vérifie l'existence du ticket
  - Construit un prompt basique (mock)
  - Appelle le provider IA via `generateReply`
  - Retourne un brouillon de réponse et les tokens utilisés

**TODO PH11-05B/C** :
- Charger le ticket, les messages, le tenant, les règles
- Construire un prompt contextuel réel
- Utiliser la langue du ticket
- Intégrer les règles IA

#### 3. `ai.routes.ts`

**Rôle** : Route de test pour valider le moteur IA.

**Endpoint** :
- `POST /api/v1/ai/test/ticket/:ticketId`
  - Requiert authentification JWT
  - Appelle `runAiForTicket` pour le ticket spécifié
  - Retourne le résultat de l'exécution IA

**Usage** :
```bash
# Login pour obtenir un token
TOKEN=$(curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@keybuzz.io","password":"change-me"}' \
  | jq -r '.token')

# Tester l'IA sur un ticket
curl -X POST http://localhost:4000/api/v1/ai/test/ticket/<TICKET_ID> \
  -H "Authorization: Bearer $TOKEN"
```

**Réponse attendue** :
```json
{
  "data": {
    "draftReply": "[KeyBuzz AI MOCK]\nModèle: keybuzz-ai-mock\n...",
    "tokensUsed": 50,
    "providerResponse": {
      "content": "...",
      "tokensUsed": 50,
      "raw": { "provider": "mock" }
    }
  }
}
```

---

## 🔧 Configuration

### Variables d'environnement

**Ajoutées** :
- `KEYBUZZ_AI_PROVIDER` (optionnel, défaut: "mock")
  - Valeurs possibles : "openai", "anthropic", "litellm", "mock"
  - Utilisé pour sélectionner le provider IA

**Prévues pour PH11-05B** :
- `KEYBUZZ_AI_BASE_URL` : URL de base pour LiteLLM (optionnel)
- `OPENAI_API_KEY` : Clé API OpenAI
- `ANTHROPIC_API_KEY` : Clé API Anthropic
- `LITELLM_API_KEY` : Clé API LiteLLM (si nécessaire)

### Fichier `src/config/env.ts`

Mise à jour du schéma Zod pour inclure `KEYBUZZ_AI_PROVIDER` :
```typescript
KEYBUZZ_AI_PROVIDER: z.string().optional().default("mock"),
```

---

## 🔌 Intégration

### `src/main.ts`

Ajout de l'import et de l'enregistrement de la route AI :
```typescript
import { registerAiTestRoutes } from "./modules/ai/ai.routes";

// ...
registerAiTestRoutes(app);
```

---

## ✅ Validation

### Build & Lint

```bash
npm run lint    # ✅ Pass (1 warning dans auth.routes.ts non lié)
npm run build   # ✅ Pass
```

### Tests manuels

1. **Vérifier que le backend démarre** :
   ```bash
   npm run start
   # ✅ Server listening on port 4000
   ```

2. **Tester la route AI** :
   - Se connecter pour obtenir un token JWT
   - Appeler `/api/v1/ai/test/ticket/:ticketId` avec un ticket existant
   - Vérifier que la réponse contient un `draftReply` mock

---

## 📝 Limitations actuelles

### PH11-05A (skeleton)

- ✅ Architecture en place
- ✅ Provider mock fonctionnel
- ✅ Route de test opérationnelle
- ❌ Pas d'appels IA réels (OpenAI/Anthropic/LiteLLM)
- ❌ Prompts basiques (pas de contexte réel)
- ❌ Pas d'intégration avec les règles IA
- ❌ Pas de gestion des quotas/billing

### À venir (PH11-05B/C)

- Implémentation des vrais providers (OpenAI, Anthropic, LiteLLM)
- Prompts contextuels avec contenu réel des tickets
- Intégration avec `aiRules.service.ts`
- Gestion des quotas et billing
- Support multi-langue
- Cache des réponses IA

---

## 🚀 Prochaines étapes

### PH11-05B — Implémentation des providers réels

1. Implémenter `openaiGenerateReply()` dans `aiProviders.service.ts`
2. Implémenter `anthropicGenerateReply()` dans `aiProviders.service.ts`
3. Implémenter `litellmGenerateReply()` dans `aiProviders.service.ts`
4. Ajouter la gestion des erreurs et retry logic
5. Ajouter la validation des clés API

### PH11-05C — Intégration avec les règles IA

1. Intégrer `runAiForTicket` dans `evaluateAiRulesForTicket`
2. Construire des prompts contextuels avec le contenu réel
3. Gérer les conditions et actions des règles IA
4. Implémenter le cache des réponses IA
5. Ajouter la gestion des quotas et billing

---

## 📚 Références

- **Prisma Schema** : `schema.prisma` (Tickets, AI Rules, Billing & Quotas)
- **API Tickets** : `src/modules/tickets/` (PH11-04B)
- **Rules Engine** : `src/modules/ai/aiRules.service.ts` (PH11-04C)
- **Billing** : `src/modules/billing/` (PH11-04C)

---

**PH11-05A — KeyBuzz AI Engine skeleton (providers + engine) terminé — prêt pour PH11-05B (brancher les règles IA réelles, prompts et futur provider OpenAI/Anthropic).**

