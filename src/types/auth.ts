export type JwtRole = "super_admin" | "owner" | "admin" | "manager" | "agent" | "viewer" | "SUPER_ADMIN" | "OWNER" | "ADMIN" | "MANAGER" | "AGENT" | "VIEWER";

export interface JwtUser {
  userId: string;
  email: string;
  tenantId?: string;
  role: JwtRole;
}
