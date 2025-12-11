export type TenantStatus = "trial" | "active" | "suspended" | "closed";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: "dev" | "starter" | "pro" | "enterprise";
  status: TenantStatus;
  createdAt: string;
  updatedAt?: string;
}

