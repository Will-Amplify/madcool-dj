import type { CmdResponse, StatusResult } from "./types";

export type AuthHeaders = () => HeadersInit;

export function createApi(getToken: () => string) {
  function authHeaders(): HeadersInit {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  function apiBase(): string {
    return "";
  }

  async function cmd<T = unknown>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${apiBase()}/v1/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ cmd: command, params }),
    });
    const body = (await res.json()) as CmdResponse<T>;
    if (!body.ok) throw new Error(body.error || `cmd_failed:${command}`);
    return body.result as T;
  }

  async function getStatus(): Promise<StatusResult> {
    const res = await fetch(`${apiBase()}/v1/status`, { headers: { ...authHeaders() } });
    const body = (await res.json()) as CmdResponse<StatusResult>;
    if (!body.ok || !body.result) throw new Error(body.error || "status_failed");
    return body.result;
  }

  return { authHeaders, apiBase, cmd, getStatus };
}

export type Api = ReturnType<typeof createApi>;
