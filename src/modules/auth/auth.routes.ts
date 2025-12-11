import { FastifyInstance } from "fastify";
import { loginWithEmailPassword } from "./auth.service";

interface LoginBody {
  email: string;
  password: string;
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: LoginBody }>("/api/v1/auth/login", async (request, reply) => {
    const { email, password } = request.body;
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

