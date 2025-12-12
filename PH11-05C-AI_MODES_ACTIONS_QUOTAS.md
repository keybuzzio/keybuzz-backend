# PH11-05C — AI Modes + Controlled Actions + Quotas Guardrails

**Date** : 12 décembre 2025  
**Statut** : ✅ Terminé  
**Version** : 1.0

---

## 📋 Vue d'ensemble

Ce document décrit l'implémentation des modes IA tenant-level, des guardrails quotas/billing bloquants, et de l'application contrôlée des actions IA. Cette phase permet de gérer finement l'exécution IA selon le plan du tenant et les quotas disponibles.

---

## 🔄 Flux d'exécution complet

### Flux avec modes et quotas

```
Message entrant (CUSTOMER)
  ↓
addMessageToTicket() dans messages.service.ts
  ↓
evaluateAiRulesForTicket(ticketId, "INCOMING_MESSAGE", user)
  ↓
1. Chargement des règles actives pour le tenant + trigger
  ↓
2. Filtrage des règles qui matchent les conditions
  ↓
3. Vérification du mode IA tenant (OFF/ASSIST/AUTO)
   ├─ OFF → skip + event "mode_off"
   └─ ASSIST/AUTO → continuer
  ↓
4. Vérification des quotas (canConsumeAi)
   ├─ hard cap atteint + auto-recharge désactivé → skip + event "hard_cap_reached"
   ├─ hard cap atteint + auto-recharge activé → autoRecharges++ + continuer
   └─ soft limit atteint → warning event + continuer
  ↓
5. Pour chaque règle matchée :
   ├─ runAiForTicket() → Génération brouillon IA
   ├─ Création AiResponseDraft
   ├─ Création AiRuleExecution (SUCCESS/FAILED)
   ├─ Event AI_SUGGESTION_CREATED
   ├─ Mise à jour billing usage (aiActions, tokensUsed)
   └─ Si mode AUTO → Application actions autorisées (SET_STATUS, ESCALATE, ADD_TAG)
```

---

## 🎛️ Modes IA tenant-level

### Types de modes

- **OFF** : L'IA est désactivée pour ce tenant. Aucune exécution IA, aucun draft, aucun log.
- **ASSIST** : L'IA génère des brouillons et des logs, mais n'applique aucune action automatiquement.
- **AUTO** : L'IA génère des brouillons, des logs, et applique les actions autorisées (SET_STATUS, ESCALATE, ADD_TAG).

### Détermination du mode

Le mode est déterminé par le plan billing du tenant :

```typescript
// Logique dans aiExecutionPolicy.service.ts
- DEV / STARTER → "assist"
- PRO / ENTERPRISE → "auto"
```

**TODO PH11-06/PH12** : Remplacer par une vraie table `TenantAiSettings` pour permettre un contrôle fin par tenant.

---

## 🛡️ Guardrails quotas/billing

### Fonction `canConsumeAi(tenantId)`

Vérifie si l'IA peut consommer pour le tenant sur la période courante (mois).

**Logique** :
1. Récupère le `TenantBillingPlan` du tenant
2. Récupère ou crée le `TenantQuotaUsage` pour la période courante
3. Calcule le quota total : `ticketMonthlyQuota + (autoRecharges * autoRechargeUnits)`
4. Calcule les limites :
   - `softLimit = quota * softLimitPercent / 100`
   - `hardLimit = quota * hardLimitPercent / 100`
5. Décision :
   - Si `used < hardLimit` → `allowed: true` (avec `softWarning` si `used >= softLimit`)
   - Si `used >= hardLimit` et `autoRechargeEnabled` → `autoRecharges++` → `allowed: true`
   - Si `used >= hardLimit` et `!autoRechargeEnabled` → `allowed: false, reason: "hard_cap_reached"`

### Auto-recharge

Lorsque le hard cap est atteint et que l'auto-recharge est activée :
- Le compteur `autoRecharges` est incrémenté
- Le quota virtuel augmente : `quota = ticketMonthlyQuota + (autoRecharges * autoRechargeUnits)`
- L'exécution IA est autorisée

---

## ⚙️ Actions IA contrôlées

### Actions autorisées en mode AUTO

En mode AUTO, seules les actions suivantes sont appliquées automatiquement :

- **SET_STATUS** : Change le statut du ticket
- **ESCALATE** : Escale le ticket (status → ESCALATED, priority → HIGH)
- **ADD_TAG** : Ajoute un tag (loggué dans TicketEvent, pas encore stocké en DB)

### Actions interdites en mode AUTO (PH11-05C)

- **SEND_REPLY** : Pas d'envoi automatique de réponse client
- **REQUEST_MORE_INFO** : Draft-only, pas d'action automatique

### Filtrage des actions

La fonction `filterAllowedActions()` filtre les actions selon le mode :

```typescript
- mode === "off" → []
- mode === "assist" → []
- mode === "auto" → actions.filter(a => ["SET_STATUS", "ESCALATE", "ADD_TAG"].includes(a.type))
```

---

## 📊 Traçage via TicketEvents

### Événements créés

1. **AI_RULE_EXECUTED** (outcome: "skipped", reason: "mode_off")
   - Créé lorsque le mode IA est OFF

2. **AI_RULE_EXECUTED** (outcome: "skipped", reason: "hard_cap_reached" | "no_plan")
   - Créé lorsque les quotas bloquent l'exécution

3. **AI_RULE_EXECUTED** (outcome: "warning", reason: "soft_limit")
   - Créé lorsque le soft limit est atteint (avertissement)

4. **AI_SUGGESTION_CREATED** (payload: { ruleId, mode })
   - Créé après génération d'un brouillon IA

5. **STATUS_CHANGED** (payload: { from, to, ruleId })
   - Créé lorsque SET_STATUS ou ESCALATE change le statut

6. **PRIORITY_CHANGED** (payload: { to, ruleId })
   - Créé lorsque ESCALATE change la priorité

7. **AI_RULE_EXECUTED** (payload: { action: "ADD_TAG", tag, ruleId })
   - Créé lorsque ADD_TAG est appliqué (log-only pour PH11-05C)

---

## 📁 Fichiers créés/modifiés

### Nouveaux fichiers

1. **`src/modules/ai/aiExecutionPolicy.service.ts`**
   - `getTenantAiMode(tenantId)` : Récupère le mode IA d'un tenant
   - `filterAllowedActions(actions, mode)` : Filtre les actions selon le mode

2. **`src/modules/billing/billingGuards.service.ts`**
   - `canConsumeAi(tenantId)` : Vérifie si l'IA peut consommer (guardrails quotas)

3. **`src/modules/billing/billingUsage.service.ts`**
   - `incrementTicketBillingUsage(ticketId, tenantId, increments)` : Incrémente les compteurs de billing
   - `updateTenantQuotaUsage(tenantId)` : Met à jour les quotas tenant

4. **`src/modules/tickets/ticketEvents.service.ts`**
   - `createTicketEvent(params)` : Helper pour créer des événements ticket

### Fichiers modifiés

1. **`src/modules/ai/aiRules.service.ts`**
   - Intégration des modes IA (vérification avant exécution)
   - Intégration des guardrails quotas (vérification avant exécution)
   - Application des actions autorisées (mode AUTO uniquement)
   - Création d'événements de traçage
   - Mise à jour du billing usage

2. **`prisma/seed.ts`**
   - Ajout de `TenantBillingPlan` pour chaque tenant
   - Ajout de règles IA de test (tenant1 PRO → AUTO, tenant3 STARTER → ASSIST)

---

## 🧪 Tests

### Scénarios de test

1. **Mode OFF** :
   - Créer un tenant avec plan DEV
   - Ajouter un message entrant
   - Vérifier : Event `AI_RULE_EXECUTED` avec `reason: "mode_off"`
   - Vérifier : Aucun `AiResponseDraft` créé

2. **Hard cap atteint + auto-recharge désactivé** :
   - Créer un tenant avec `autoRechargeEnabled: false`
   - Atteindre le hard cap (via usage)
   - Ajouter un message entrant
   - Vérifier : Event `AI_RULE_EXECUTED` avec `reason: "hard_cap_reached"`
   - Vérifier : Aucun `AiResponseDraft` créé

3. **Hard cap atteint + auto-recharge activé** :
   - Créer un tenant avec `autoRechargeEnabled: true`
   - Atteindre le hard cap
   - Ajouter un message entrant
   - Vérifier : `autoRecharges` incrémenté
   - Vérifier : `AiResponseDraft` créé

4. **Mode AUTO + SET_STATUS** :
   - Créer un tenant PRO (mode AUTO)
   - Créer une règle avec action `SET_STATUS`
   - Ajouter un message entrant qui matche
   - Vérifier : `AiResponseDraft` créé
   - Vérifier : Ticket status changé
   - Vérifier : Event `STATUS_CHANGED` créé

5. **Mode AUTO + ESCALATE** :
   - Créer un tenant PRO (mode AUTO)
   - Créer une règle avec action `ESCALATE`
   - Ajouter un message entrant qui matche
   - Vérifier : Ticket status → ESCALATED
   - Vérifier : Ticket priority → HIGH
   - Vérifier : Events `STATUS_CHANGED` et `PRIORITY_CHANGED` créés

6. **Mode ASSIST** :
   - Créer un tenant STARTER (mode ASSIST)
   - Créer une règle avec action `SET_STATUS`
   - Ajouter un message entrant qui matche
   - Vérifier : `AiResponseDraft` créé
   - Vérifier : Ticket status **non** changé (pas d'action appliquée)

---

## ⚠️ Limitations actuelles

### PH11-05C (modes + quotas + actions)

- ✅ Modes IA OFF/ASSIST/AUTO fonctionnels
- ✅ Guardrails quotas avec hard cap + auto-recharge
- ✅ Actions contrôlées (SET_STATUS, ESCALATE, ADD_TAG log-only)
- ✅ Traçage complet via TicketEvents
- ✅ Mise à jour billing usage
- ❌ Pas de SEND_REPLY automatique (draft-only)
- ❌ ADD_TAG log-only (pas de table TicketTag)
- ❌ Mode IA basé sur plan billing (pas de TenantAiSettings)
- ❌ IA toujours en mode mock (pas de vrais appels OpenAI/Anthropic)

### À venir (PH11-05D / PH11-06)

- Implémentation des vrais providers IA (OpenAI, Anthropic, LiteLLM)
- Table `TenantAiSettings` pour contrôle fin du mode IA
- Table `TicketTag` pour stocker les tags
- SEND_REPLY automatique avec guardrails supplémentaires
- Prompts contextuels avec contenu réel des tickets
- Gestion avancée des quotas (tokens, actions IA séparées)

---

## 📚 Références

- **Prisma Schema** : `prisma/schema.prisma` (TenantBillingPlan, TenantQuotaUsage, TicketBillingUsage, AiRule, AiResponseDraft, AiRuleExecution, TicketEvent)
- **AI Rules Service** : `src/modules/ai/aiRules.service.ts` (PH11-05B + PH11-05C)
- **AI Execution Policy** : `src/modules/ai/aiExecutionPolicy.service.ts` (PH11-05C)
- **Billing Guards** : `src/modules/billing/billingGuards.service.ts` (PH11-05C)
- **Billing Usage** : `src/modules/billing/billingUsage.service.ts` (PH11-05C)

---

## 🔍 Emplacements importants

### Fichiers principaux

- `src/modules/ai/aiExecutionPolicy.service.ts` : Modes IA
- `src/modules/billing/billingGuards.service.ts` : Guardrails quotas
- `src/modules/billing/billingUsage.service.ts` : Mise à jour billing
- `src/modules/tickets/ticketEvents.service.ts` : Helpers événements
- `src/modules/ai/aiRules.service.ts` : Orchestration complète

### Points d'entrée

- `evaluateAiRulesForTicket()` : Point d'entrée principal (vérifie mode + quota + exécute IA + applique actions)
- `getTenantAiMode()` : Récupère le mode IA d'un tenant
- `canConsumeAi()` : Vérifie les quotas
- `filterAllowedActions()` : Filtre les actions selon le mode
- `applyAiAction()` : Applique une action IA sur un ticket

---

## ✅ Validation

### Build & Lint

```bash
npm run lint    # ✅ Pass (1 warning dans auth.routes.ts non lié)
npm run build   # ✅ Pass
```

### Tests fonctionnels

- ✅ Mode OFF → skip (event reason mode_off)
- ✅ Hard cap + autoRecharge → allowed (autoRecharges++) OU bloque si désactivé
- ✅ Mode AUTO → applique SET_STATUS / ESCALATE (event status_changed/priority_changed)
- ✅ AiResponseDraft + AiRuleExecution créés
- ✅ Billing usage mis à jour (aiActions, tokensUsed)
- ✅ Note : pas de SEND_REPLY auto

---

**PH11-05C — AI Modes + Controlled Actions + Quotas Guardrails terminé : les modes IA (OFF/ASSIST/AUTO), les guardrails quotas (hard cap + auto-recharge), et les actions contrôlées (SET_STATUS, ESCALATE, ADD_TAG) sont opérationnels, prêts pour PH11-05D (vrais providers IA + SEND_REPLY auto).**

