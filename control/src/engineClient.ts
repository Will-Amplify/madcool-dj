/**
 * Unix-socket JSON-lines client for the madcool-dj-engine protocol
 * (see engine/src/madcool_dj_engine/protocol.py).
 *
 * Wire format:
 *   request:  {"id": "...", "cmd": "...", "params": {...}}\n
 *   response: {"id": "...", "ok": true, "result": {...}}\n
 *             {"id": "...", "ok": false, "error": "..."}\n
 *   push event (no matching request): {"event": "...", "data": {...}}\n
 */

import { EventEmitter } from "node:events";
import * as net from "node:net";

export interface EngineEvent {
  event: string;
  data: unknown;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class EngineClient extends EventEmitter {
  private readonly sockPath: string;
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private connected = false;
  private stopped = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(sockPath: string) {
    super();
    this.sockPath = sockPath;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get path(): string {
    return this.sockPath;
  }

  connect(): void {
    this.stopped = false;
    this.attemptConnect();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.rejectAllPending(new Error("engine_client_closed"));
  }

  async request(cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket || !this.connected) {
      throw new Error("engine_disconnected");
    }

    const id = String(this.nextId++);
    const line = JSON.stringify({ id, cmd, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`engine_request_timeout: ${cmd}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });

      this.socket!.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private attemptConnect(): void {
    if (this.stopped) return;

    const socket = net.createConnection(this.sockPath);
    this.socket = socket;

    socket.on("connect", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.emit("connect");
    });

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim()) this.handleLine(line);
      }
    });

    const onDown = (err?: Error) => {
      if (!this.connected && !this.socket) return; // already handled
      this.connected = false;
      this.socket = null;
      this.rejectAllPending(new Error("engine_disconnected"));
      this.emit("disconnect", err);
      this.scheduleReconnect();
    };

    socket.on("error", (err) => {
      this.emit("error", err);
      onDown(err);
    });
    socket.on("close", () => onDown());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const obj = msg as Record<string, unknown>;

    if (typeof obj.event === "string") {
      this.emit("event", { event: obj.event, data: obj.data } as EngineEvent);
      return;
    }

    if ("id" in obj) {
      const id = obj.id === null || obj.id === undefined ? null : String(obj.id);
      if (id === null) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (obj.ok) {
        pending.resolve(obj.result);
      } else {
        pending.reject(new Error(typeof obj.error === "string" ? obj.error : "engine_error"));
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

function defaultSockPath(): string {
  if (process.env.ENGINE_SOCK) return process.env.ENGINE_SOCK;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || "/tmp";
  return `${runtimeDir}/madcool-dj.sock`;
}

/** Shared singleton — the whole control process talks to one engine socket. */
export const engineClient = new EngineClient(defaultSockPath());
