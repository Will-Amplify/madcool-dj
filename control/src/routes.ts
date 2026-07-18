/**
 * HTTP routes for the control plane. Auth: when `DJ_TOKEN` is set (non-empty),
 * every `/v1/*` request must carry a matching `Authorization: Bearer <token>`
 * header. `/health` always stays open so process supervisors / load balancers
 * can probe it without a token.
 */

import { Hono } from "hono";
import { z } from "zod";

import { execute } from "./bus.js";

const cmdSchema = z.object({
  cmd: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "madcool-dj-control" }));

  app.use("/v1/*", async (c, next) => {
    const token = process.env.DJ_TOKEN;
    if (!token) {
      await next();
      return;
    }
    const header = c.req.header("Authorization") ?? "";
    const [scheme, value] = header.split(" ");
    if (scheme !== "Bearer" || value !== token) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/v1/status", async (c) => {
    try {
      const result = await execute("status");
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 502);
    }
  });

  app.post("/v1/cmd", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_json_body" }, 400);
    }

    const parsed = cmdSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_body", details: parsed.error.flatten() }, 400);
    }

    try {
      const result = await execute(parsed.data.cmd, parsed.data.params ?? {});
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 502);
    }
  });

  return app;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
