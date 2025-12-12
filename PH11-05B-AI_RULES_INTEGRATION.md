# PH11-05B — Intégration KeyBuzz AI Engine avec les Règles & Tickets

**Date** : 12 décembre 2025  
**Statut** : ✅ Terminé  
**Version** : 1.0

---

## 📋 Vue d'ensemble

Ce document décrit l'intégration du moteur IA KeyBuzz avec le système de règles et les tickets. Cette phase permet d'exécuter automatiquement l'IA lorsqu'une règle matche, créant des brouillons de réponse (AiResponseDraft) et des logs d'exécution (AiRuleExecution).

---

## 🔄 Flux d'exécution

### Flux complet

```
Message entrant (CUSTOMER)
  ↓
addMessageToTicket() dans messages.service.ts
  ↓
evaluateAiRulesForTicket(ticketId, "INCOMING_MESSAGE", user)
  ↓
Chargement des règles actives pour le tenant + trigger
  ↓
Filtrage des règles qui matchent les conditions
  ↓
Pour chaque règle matchée :
  ├─ runAiForTicket(ticketId, userContext)
  ├─ Création AiResponseDraft (si draftReply existe)
  └─ Création AiRuleExecution (SUCCESS ou FAILED)
```

---

## 📁 Fichiers modifiés

### 1. `src/modules/ai/aiRules.service.ts` (NOUVEAU)

**Rôle** : Service d'évaluation et d'exécution des règles IA.

**Fonction principale** :
- `evaluateAiRulesForTicket(ticketId: string, trigger: string, userContext?: AuthUser): Promise<void>`
  - Charge le ticket et son tenant
  - Charge les règles actives pour le tenant et le trigger
  - Filtre les règles qui matchent les conditions
  - Pour chaque règle matchée :
    - Appelle `runAiForTicket()` pour générer un brouillon IA
    - Crée un `AiResponseDraft` si un brouillon est généré
    - Crée un `AiRuleExecution` pour logger l'exécution (SUCCESS ou FAILED)

**Fonctions utilitaires** :
- `getTicketFieldValue(ticket, field)` : Récupère la valeur d'un champ du ticket
- `evaluateCondition(ticketValue, operator, conditionValue)` : Évalue une condition selon l'opérateur

**Opérateurs supportés** :
- `EQUALS`, `NOT_EQUALS`
- `CONTAINS`, `NOT_CONTAINS`
- `IN`, `NOT_IN`
- `GREATER_THAN`, `LESS_THAN`

### 2. `src/modules/tickets/messages.service.ts` (MODIFIÉ)

**Modification** : Ajout de l'appel à `evaluateAiRulesForTicket` après création d'un message entrant.

**Code ajouté** :
```typescript
// Déclencher l'évaluation des règles IA si c'est un message entrant (client)
if (!isInternal) {
  await evaluateAiRulesForTicket(ticketId, "INCOMING_MESSAGE", user);
}
```

**Comportement** :
- Se déclenche uniquement pour les messages entrants (non internes)
- Utilise le trigger `"INCOMING_MESSAGE"`
- Passe le contexte utilisateur pour l'exécution IA

---

## 🗄️ Modèles de données utilisés

### AiResponseDraft

Créé lorsqu'une règle IA génère un brouillon de réponse :
- `ticketId` : Ticket concerné
- `tenantId` : Tenant du ticket
- `createdByRule` : ID de la règle qui a créé le brouillon
- `body` : Contenu du brouillon IA
- `confidence` : Niveau de confiance (null pour l'instant, sera implémenté plus tard)
- `used` : Indique si le brouillon a été utilisé (false par défaut)

### AiRuleExecution

Créé pour chaque exécution d'une règle IA :
- `ruleId` : Règle exécutée
- `ticketId` : Ticket concerné
- `tenantId` : Tenant du ticket
- `result` : Résultat de l'exécution (`SUCCESS` ou `FAILED`)
- `details` : Détails JSON de l'exécution (réponse du provider IA ou erreur)

---

## ⚙️ Configuration

### Triggers supportés

Actuellement, seul le trigger `INCOMING_MESSAGE` est utilisé. Les autres triggers définis dans le schéma Prisma sont :
- `INCOMING_MESSAGE` : Message entrant d'un client
- `NO_ANSWER_TIMEOUT` : Timeout sans réponse
- `ORDER_ISSUE` : Problème de commande
- `RETURN_REQUEST` : Demande de retour
- `NEGATIVE_SENTIMENT` : Sentiment négatif détecté

### Conditions

Les conditions sont évaluées sur les champs suivants du ticket :
- `status` : Statut du ticket
- `priority` : Priorité du ticket
- `channel` : Canal du ticket
- `customerEmail` : Email du client
- `subject` : Sujet du ticket

---

## 🧪 Tests

### Test manuel du flux complet

1. **Créer un ticket** (via API ou UI)
2. **Créer une règle IA active** avec :
   - Trigger : `INCOMING_MESSAGE`
   - Condition optionnelle (ou aucune condition)
   - Mode : `SUGGEST_ONLY` (pas d'action automatique)
3. **Ajouter un message entrant** au ticket :
   ```bash
   POST /api/v1/tickets/:ticketId/messages
   {
     "body": "Message de test",
     "isInternal": false
   }
   ```
4. **Vérifier en DB** :
   - Un `AiResponseDraft` a été créé pour ce ticket
   - Un `AiRuleExecution` avec `result: SUCCESS` a été créé

### Test de la route AI (PH11-05A)

La route de test `/api/v1/ai/test/ticket/:ticketId` reste fonctionnelle :
```bash
curl -X POST http://localhost:4000/api/v1/ai/test/ticket/<TICKET_ID> \
  -H "Authorization: Bearer $TOKEN"
```

---

## ⚠️ Limitations actuelles

### PH11-05B (intégration)

- ✅ Règles IA évaluées automatiquement
- ✅ Brouillons IA créés en DB
- ✅ Logs d'exécution créés
- ❌ IA toujours en mode mock (pas de vrais appels OpenAI/Anthropic)
- ❌ Pas d'actions automatiques (uniquement des brouillons)
- ❌ Pas de gestion de la confiance (confidence = null)
- ❌ Prompts basiques (pas de contexte réel du ticket)

### À venir (PH11-05C)

- Implémentation des vrais providers IA (OpenAI, Anthropic, LiteLLM)
- Prompts contextuels avec contenu réel des tickets et messages
- Actions automatiques (SEND_REPLY, SET_STATUS, etc.)
- Gestion de la confiance des réponses IA
- Cache des réponses IA
- Gestion des quotas et billing pour les actions IA

---

## 📚 Références

- **Prisma Schema** : `prisma/schema.prisma` (AiRule, AiResponseDraft, AiRuleExecution)
- **AI Engine** : `src/modules/ai/aiEngine.service.ts` (PH11-05A)
- **AI Providers** : `src/modules/ai/aiProviders.service.ts` (PH11-05A)
- **Messages Service** : `src/modules/tickets/messages.service.ts` (PH11-04B)

---

## 🔍 Emplacements importants

### Fichiers principaux

- `src/modules/ai/aiRules.service.ts` : Service d'évaluation des règles IA
- `src/modules/ai/aiEngine.service.ts` : Moteur IA principal
- `src/modules/tickets/messages.service.ts` : Service de messages (intégration)

### Points d'entrée

- `addMessageToTicket()` : Déclenche l'évaluation des règles IA
- `evaluateAiRulesForTicket()` : Évalue et exécute les règles IA
- `runAiForTicket()` : Génère un brouillon IA pour un ticket

---

## ✅ Validation

### Build & Lint

```bash
npm run lint    # ✅ Pass (1 warning dans auth.routes.ts non lié)
npm run build   # ✅ Pass
```

### Tests fonctionnels

- ✅ `runAiForTicket` fonctionne via `/api/v1/ai/test/ticket/:ticketId`
- ✅ `AiResponseDraft` créés dans la DB lors d'un trigger IA
- ✅ `AiRuleExecution` créés dans la DB (SUCCESS/FAILED)

---

**PH11-05B — Intégration KeyBuzz AI Engine ↔ Rules ↔ Tickets terminée : les règles IA créent désormais des brouillons IA (AiResponseDraft) et des logs (AiRuleExecution), prêts pour des actions plus avancées en PH11-05C.**

