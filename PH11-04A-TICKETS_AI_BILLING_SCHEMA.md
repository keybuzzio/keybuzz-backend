# PH11-04A â€” Tickets, Messages, Events, AI Rules & Billing Schema (Prisma)

## Contenu ajoutÃ©
- Tickets & Messaging : `Ticket`, `TicketMessage`, `TicketEvent`, `TicketAssignment` + enums `TicketStatus`, `TicketPriority`, `TicketChannel`, `MessageSenderType`, `MessageSource`, `TicketEventType`, `EventActorType`.
- AI Rules & executions : `AiRule`, `AiRuleCondition`, `AiRuleAction`, `AiRuleExecution`, `AiResponseDraft` + enums `AiTriggerType`, `AiExecutionMode`, `ConditionOperator`, `AiActionType`, `AiExecutionResult`.
- Billing & quotas : `TenantBillingPlan`, `TenantQuotaUsage`, `TicketBillingUsage` (usage par ticket, quotas mensuels, auto-recharge, prix unitaire).

## Commandes Prisma
```
cd /opt/keybuzz/keybuzz-backend
npx prisma format
npx prisma migrate dev --name ph11_04_tickets_ai_billing   # âš ï¸ P1000 si DB creds invalides
npx prisma generate
```

## Ã‰tat DB
- Migration tentÃ©e : `P1000` (auth DB invalide sur 10.0.0.10:5432). Le schÃ©ma est prÃªt ; appliquer dÃ¨s que les identifiants Postgres valides seront fournis.

## IntÃ©grations prÃ©vues (PH11-04B/C)
- Services Tickets/Messages/Events (Fastify routes) + filtrage tenant/roles.
- RÃ¨gles IA : dÃ©clencheurs, conditions, actions, journalisation `AiRuleExecution`, drafts `AiResponseDraft`.
- Billing : consommation par ticket (`TicketBillingUsage`), agrÃ©gation mensuelle (`TenantQuotaUsage`), plan et auto-recharge (`TenantBillingPlan`).