export type UserRole = "owner" | "admin" | "manager" | "agent" | "super_admin";

export interface AuthUser {
  id: string;
  tenantId: string | null; // null for super admin scope
  email: string;
  fullName: string;
  role: UserRole;
}

