import type { Tenant } from "./tenants.types";

const TENANTS_MOCK: Tenant[] = [
  {
    id: "kbz-001",
    slug: "acme-electronics",
    name: "Acme Electronics",
    plan: "pro",
    status: "active",
    createdAt: "2024-01-10T09:00:00Z",
    updatedAt: "2025-12-10T09:00:00Z",
  },
  {
    id: "kbz-002",
    slug: "globex",
    name: "Globex Retail",
    plan: "enterprise",
    status: "active",
    createdAt: "2024-02-15T10:30:00Z",
    updatedAt: "2025-12-09T14:00:00Z",
  },
  {
    id: "kbz-003",
    slug: "soylent-market",
    name: "Soylent Market",
    plan: "starter",
    status: "trial",
    createdAt: "2024-05-05T12:00:00Z",
    updatedAt: "2025-12-08T16:00:00Z",
  },
  {
    id: "kbz-004",
    slug: "initech-gadgets",
    name: "Initech Gadgets",
    plan: "pro",
    status: "active",
    createdAt: "2024-07-20T08:45:00Z",
    updatedAt: "2025-12-07T11:30:00Z",
  },
  {
    id: "kbz-005",
    slug: "umbrella-outlet",
    name: "Umbrella Outlet",
    plan: "enterprise",
    status: "suspended",
    createdAt: "2024-09-01T07:20:00Z",
    updatedAt: "2025-12-05T10:10:00Z",
  },
];

export async function getTenants(): Promise<Tenant[]> {
  // TODO: Replace with SELECT from PostgreSQL
  return TENANTS_MOCK;
}

