# PH11-04B â€” Tickets API (multi-tenant, JWT, IA-ready)

## Objectif
Exposer les routes Tickets/Messages sÃ©curisÃ©es JWT, multi-tenant, avec journalisation dâ€™Ã©vÃ©nements et prÃ©pa IA/billing.

## Routes
- `GET /api/v1/tickets` â€” liste (order desc createdAt)
  - super_admin : tous les tickets
  - autre rÃ´le : tickets du tenant courant
- `GET /api/v1/tickets/:ticketId` â€” dÃ©tail
  - 404 si non trouvÃ© ou autre tenant
- `GET /api/v1/tickets/:ticketId/messages` â€” liste des messages
- `POST /api/v1/tickets/:ticketId/messages` â€” ajoute un message (`body`, `isInternal`)

Toutes les routes sont protÃ©gÃ©es par JWT (`preHandler: authenticate`).

## Services (src/modules/tickets)
- `tickets.service.ts`
  - `listTicketsForUser(user)` â€” filtre tenant sauf super_admin
  - `getTicketById(user, ticketId)` â€” vÃ©rifie appartenance tenant
  - mapping DTO UI-friendly (status/priority/channel en lowercase)
- `messages.service.ts`
  - `listMessagesForTicket(user, ticketId)` â€” filtre tenant
  - `addMessageToTicket(user, ticketId, body, isInternal)`
    - crÃ©e `TicketMessage`
    - crÃ©e `TicketEvent` (MESSAGE_SENT/RECEIVED)
    - upsert `TicketBillingUsage.humanMessagesCount`
    - TODO PH11-04C : firstResponseAt, SLA, IA hooks

## Multi-tenant
- super_admin : accÃ¨s global
- autres rÃ´les : accÃ¨s restreint Ã  `user.tenantId`
- 404 si ticket non trouvÃ©, 403 si autre tenant (messages)

## JWT
- Plugin `authenticate` (fastify-jwt) dÃ©jÃ  en place
- `request.user` disponible aprÃ¨s vÃ©rification

## Billing & IA (hooks)
- `TicketBillingUsage` incrÃ©mentÃ© sur ajout de message (humain)
- Hooks prÃ©vus (PH11-04C) : SLA (firstResponseAt, resolvedAt), IA (AiRuleExecution, AiResponseDraft), auto-close, quotas

## Commandes
```
npm run lint
npm run build

# test (nÃ©cessite un JWT valide)
curl http://localhost:4000/api/v1/tickets -H "Authorization: Bearer $TOKEN"
curl http://localhost:4000/api/v1/tickets/<id> -H "Authorization: Bearer $TOKEN"
```

## Fichiers ajoutÃ©s
- `src/modules/tickets/tickets.types.ts`
- `src/modules/tickets/tickets.service.ts`
- `src/modules/tickets/tickets.routes.ts`
- `src/modules/tickets/messages.service.ts`
- `src/modules/tickets/messages.routes.ts`
- `src/main.ts` (enregistrement routes tickets/messages)

## Ã‰tat DB
- SchÃ©ma PH11-04A requis (tickets/messages/events/billing). Migration peut rester en attente si DB credentials manquants (P1000).