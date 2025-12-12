import { FastifyInstance } from "fastify";
import { loginWithEmailPassword } from "./auth.service";

interface LoginBody {
  email: string;
  password: string;
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post("/api/v1/auth/login", async (request, reply) => {
    // Try to parse body manually if needed
    let body: LoginBody;
    try {
      body = request.body as LoginBody;
    } catch {
      return reply.code(400).send({ error: "Invalid request body" });
    }

    const { email, password } = body || {};
    
    if (!email || !password) {
      return reply.code(400).send({ error: "email and password required" });
    }

    const user = await loginWithEmailPassword(email, password);

    if (!user) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (app as any).jwt.sign({
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
    });

    return { user, token };
  });
}

