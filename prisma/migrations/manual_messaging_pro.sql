-- PH19-MESSAGING-PRO-01: Add SLA and assignee fields to Ticket

-- Add direct assignee relationship
ALTER TABLE " Ticket\ ADD COLUMN IF NOT EXISTS \assigneeUserId\ TEXT;
ALTER TABLE \Ticket\ ADD CONSTRAINT \Ticket_assigneeUserId_fkey\ 
 FOREIGN KEY (\assigneeUserId\) REFERENCES \User\(\id\) ON DELETE SET NULL ON UPDATE CASCADE;

-- Add SLA timestamp fields
ALTER TABLE \Ticket\ ADD COLUMN IF NOT EXISTS \lastCustomerMessageAt\ TIMESTAMP(3);
ALTER TABLE \Ticket\ ADD COLUMN IF NOT EXISTS \lastAgentMessageAt\ TIMESTAMP(3);

-- Add index for faster filtering
CREATE INDEX IF NOT EXISTS \Ticket_tenantId_status_idx\ ON \Ticket\(\tenantId\, \status\);
CREATE INDEX IF NOT EXISTS \Ticket_tenantId_assigneeUserId_idx\ ON \Ticket\(\tenantId\, \assigneeUserId\);

-- ConversationEvent table for audit trail
CREATE TABLE IF NOT EXISTS \ConversationEvent\ (
 \id\ TEXT NOT NULL,
 \ticketId\ TEXT NOT NULL,
 \tenantId\ TEXT NOT NULL,
 \eventType\ TEXT NOT NULL,
 \fromValue\ TEXT,
 \toValue\ TEXT,
 \actorUserId\ TEXT,
 \metadata\ JSONB,
 \createdAt\ TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT \ConversationEvent_pkey\ PRIMARY KEY (\id\),
 CONSTRAINT \ConversationEvent_ticketId_fkey\ FOREIGN KEY (\ticketId\) REFERENCES \Ticket\(\id\) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS \ConversationEvent_ticketId_idx\ ON \ConversationEvent\(\ticketId\);
CREATE INDEX IF NOT EXISTS \ConversationEvent_tenantId_createdAt_idx\ ON \ConversationEvent\(\tenantId\, \createdAt\);
