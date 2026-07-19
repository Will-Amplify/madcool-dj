/**
 * HTTP routes for the control plane. Auth: when `DJ_TOKEN` is set (non-empty),
 * every `/v1/*` request must carry a matching `Authorization: Bearer <token>`
 * header. `/health` always stays open so process supervisors / load balancers
 * can probe it without a token.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";

import { execute } from "./bus.js";

const cmdSchema = z.object({
  cmd: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

const AUDIO_EXTS = new Set([".wav", ".flac", ".mp3", ".aiff", ".aif", ".ogg", ".m4a", ".aac"]);

// control/src/routes.ts (or control/dist/routes.js, same depth) -> repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIST = join(__dirname, "..", "..", "dashboard", "dist");
const UPLOAD_DIR = join(homedir(), ".cache", "madcool-dj", "uploads");

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

  /** Drop-target upload: save audio under ~/.cache/madcool-dj/uploads and optionally load a deck. */
  app.post("/v1/upload", async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ ok: false, error: "missing_file" }, 400);
      }
      const ext = extname(file.name || "").toLowerCase();
      if (!AUDIO_EXTS.has(ext)) {
        return c.json({ ok: false, error: `unsupported_audio_ext: ${ext || "(none)"}` }, 400);
      }
      mkdirSync(UPLOAD_DIR, { recursive: true });
      const safe = (file.name || `drop${ext}`).replace(/[^\w.\-]+/g, "_").slice(0, 120);
      const dest = join(UPLOAD_DIR, `${Date.now()}_${safe}`);
      const body = file.stream();
      await pipeline(
        Readable.fromWeb(body as import("node:stream/web").ReadableStream),
        createWriteStream(dest),
      );

      const deckRaw = form.get("deck");
      const deck = deckRaw === "a" || deckRaw === "b" ? deckRaw : null;
      let load: unknown = null;
      if (deck) {
        load = await execute("deck.load", {
          deck,
          path: dest,
          source: "local",
          title: file.name.replace(/\.[^.]+$/, "") || safe,
        });
      }
      return c.json({ ok: true, result: { path: dest, name: file.name, load } });
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
