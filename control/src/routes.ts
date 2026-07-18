/**
 * HTTP routes for the control plane. Auth: when `DJ_TOKEN` is set (non-empty),
 * every `/v1/*` request must carry a matching `Authorization: Bearer <token>`
 * header. `/health` always stays open so process supervisors / load balancers
 * can probe it without a token.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";

import { execute } from "./bus.js";

const cmdSchema = z.object({
  cmd: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

// control/src/routes.ts (or control/dist/routes.js, same depth) -> repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIST = join(__dirname, "..", "..", "dashboard", "dist");

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

  // Dashboard: serve the built Vite app if it exists (`cd dashboard && npm
  // run build`). Registered last so it never shadows /health or /v1/*, and
  // skipped entirely when the dashboard hasn't been built (fresh clone,
  // engine/control-only dev, CI) so it stays a silent no-op.
  if (existsSync(DASHBOARD_DIST)) {
    app.use("/*", serveStatic({ root: DASHBOARD_DIST }));
  }

  return app;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
