import { FastifyInstance } from "fastify";
import { mockLogin } from "./auth.service";

interface LoginBody {
  email: string;
  password: string;
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: LoginBody }>("/api/v1/auth/login", async (request, reply) => {
    const { email, password } = request.body;
    const result = await mockLogin(email, password);

    if (!result) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    return { user: result.user, token: result.token };
  });
}

