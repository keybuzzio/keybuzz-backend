export type TicketStatus =
  | "open"
  | "pending"
  | "waiting_customer"
  | "resolved"
  | "escalated"
  | "closed";

export type TicketPriority = "low" | "normal" | "high" | "urgent";

export interface TicketDto {
  id: string;
  subject: string;
  customerName: string;
  customerEmail?: string;
  channel: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
  firstResponseAt?: string;
  resolvedAt?: string;
  category?: string;
  sentiment?: string;
}

