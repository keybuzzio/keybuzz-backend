import type { AuthUser } from "./auth.types";

export async function mockLogin(
  email: string,
  password: string
): Promise<{ user: AuthUser; token: string } | null> {
  // TODO: Replace with DB lookup + password hash verification
  if (email === "admin@keybuzz.io" && password === "change-me") {
    return {
      user: {
        id: "user-superadmin",
        tenantId: null,
        email,
        fullName: "KeyBuzz Super Admin",
        role: "super_admin",
      },
      token: "mock-jwt-token",
    };
  }

  return null;
}

