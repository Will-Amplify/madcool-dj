/**
 * Roon extension cradle: registers "MadCool DJ" as a real Roon extension
 * against a Core (Simon, over Tailscale), persists the pairing token, and
 * exposes a small zones/control surface for `bus.ts`.
 *
 * Roon's authorization model: `core_paired` only fires once a human clicks
 * "Enable" for this extension in Roon -> Settings -> Extensions (unless the
 * extension needs zero services, which ours doesn't since it requires
 * transport). Until then the websocket stays open with no error — there's
 * just nothing to report yet. So "pending approval" is a normal, expected
 * state here, not a failure: every public method below resolves that into
 * a `RoonUnavailableError` instead of throwing something scarier or
 * crashing the control server.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import RoonApi from "node-roon-api";
import RoonApiStatus from "node-roon-api-status";
import RoonApiTransport from "node-roon-api-transport";

export class RoonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoonUnavailableError";
  }
}

export type ControlAction = "play" | "pause" | "playpause" | "stop" | "next" | "previous";

export interface ZoneSummary {
  zoneId: string;
  displayName: string;
  state: string;
  nowPlaying: { line1: string; line2: string; line3: string } | null;
  seekPosition: number | null;
  isPlayAllowed: boolean;
  isPauseAllowed: boolean;
  isPreviousAllowed: boolean;
  isNextAllowed: boolean;
}

/** Shape of the raw zone object Roon's transport service hands back. */
interface RoonZone {
  zone_id: string;
  display_name: string;
  state: string;
  is_play_allowed?: boolean;
  is_pause_allowed?: boolean;
  is_previous_allowed?: boolean;
  is_next_allowed?: boolean;
  now_playing?: {
    seek_position?: number;
    three_line?: { line1?: string; line2?: string; line3?: string };
  };
}

interface RoonTransportService {
  get_zones(cb: (err: string | false, body: { zones: RoonZone[] } | undefined) => void): void;
  control(zoneOrOutput: RoonZone, control: ControlAction, cb: (err: string | false) => void): void;
}

interface RoonCore {
  core_id: string;
  display_name: string;
  services: { RoonApiTransport?: RoonTransportService };
}

type ConnectionPhase = "idle" | "connecting" | "waiting_for_authorization" | "connected" | "disconnected";

interface RoonState {
  phase: ConnectionPhase;
  core: RoonCore | null;
  lastError: string | null;
}

type PersistedState = Record<string, unknown>;

interface PairingWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface RoonClientOptions {
  extensionId?: string;
  displayName?: string;
  displayVersion?: string;
  publisher?: string;
  email?: string;
  website?: string;
  host?: string;
  port?: number;
  pairTimeoutMs?: number;
  tokenPath?: string;
}

/** Injected for tests (`scripts/roon-mock-smoke.ts`); real code uses the default import. */
export interface RoonDeps {
  RoonApi: any;
  RoonApiStatus: any;
  RoonApiTransport: any;
}

const defaultDeps: RoonDeps = { RoonApi, RoonApiStatus, RoonApiTransport };

function defaultTokenPath(): string {
  return process.env.ROON_TOKEN_PATH || join(homedir(), ".config", "madcool-dj", "roon_token");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One Roon extension connection. `bus.ts` uses the module-level singleton
 * below; the class itself takes injected deps + options so it can be
 * exercised against a fake Roon without any network I/O (see
 * `scripts/roon-mock-smoke.ts`).
 */
export class RoonClient {
  private readonly deps: RoonDeps;
  private readonly extensionId: string;
  private readonly displayName: string;
  private readonly displayVersion: string;
  private readonly publisher: string;
  private readonly email: string;
  private readonly website: string;
  private readonly host: string;
  private readonly port: number;
  private readonly pairTimeoutMs: number;
  private readonly tokenPath: string;

  private state: RoonState = { phase: "idle", core: null, lastError: null };
  private pairingWaiters: PairingWaiter[] = [];
  private connectStarted = false;
  private roonApi: any = null;
  private moo: any = null;

  constructor(deps: RoonDeps = defaultDeps, opts: RoonClientOptions = {}) {
    this.deps = deps;
    this.extensionId = opts.extensionId ?? "com.madcool.dj";
    this.displayName = opts.displayName ?? "MadCool DJ";
    this.displayVersion = opts.displayVersion ?? "0.1.0";
    this.publisher = opts.publisher ?? "MadCool LLC";
    this.email = opts.email ?? "will@willkline.com";
    this.website = opts.website ?? "https://willkline.com";
    this.host = opts.host ?? process.env.ROON_HOST ?? "100.109.124.125";
    this.port = opts.port ?? Number(process.env.ROON_PORT ?? 9330);
    this.pairTimeoutMs = opts.pairTimeoutMs ?? Number(process.env.ROON_PAIR_TIMEOUT_MS ?? 10_000);
    this.tokenPath = opts.tokenPath ?? defaultTokenPath();
  }

  get status(): RoonState {
    return { ...this.state };
  }

  private isConnected(): boolean {
    return this.state.phase === "connected";
  }

  /**
   * Idempotently kicks off the extension connection to `host:port`. Safe to
   * call repeatedly — never throws. Resolves once Roon has actually paired
   * with us (i.e. the extension has been enabled in Roon's Settings), or
   * rejects with a `RoonUnavailableError` after `pairTimeoutMs` if pairing
   * is still pending, the socket errored, or it closed before pairing.
   *
   * If a previous attempt already got a real Core connection, this
   * resolves immediately.
   */
  connectRoon(): Promise<void> {
    if (this.isConnected()) return Promise.resolve();

    if (!this.connectStarted) {
      this.connectStarted = true;
      this.startConnection();
    }

    if (this.isConnected()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pairingWaiters = this.pairingWaiters.filter((w) => w.resolve !== settle);
        if (this.state.phase !== "connected") {
          this.state.phase = "waiting_for_authorization";
        }
        reject(
          new RoonUnavailableError(
            this.state.lastError ??
              `roon_pending_authorization: approve '${this.displayName}' in Roon (Settings -> Extensions) on ${this.host}`,
          ),
        );
      }, this.pairTimeoutMs);

      const settle = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      this.pairingWaiters.push({
        resolve: settle,
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
  }

  /** Lists Roon zones. Throws `RoonUnavailableError` if Roon isn't reachable/paired yet. */
  async listZones(): Promise<ZoneSummary[]> {
    await this.connectRoon();
    const transport = this.getTransport();
    const zones = await this.getZones(transport);
    return zones.map(toZoneSummary);
  }

  /** Controls a zone by id or (case-insensitive) display name. */
  async control(zoneIdOrName: string, action: ControlAction): Promise<void> {
    await this.connectRoon();
    const transport = this.getTransport();
    const zones = await this.getZones(transport);
    const zone =
      zones.find((z) => z.zone_id === zoneIdOrName) ??
      zones.find((z) => z.display_name.toLowerCase() === zoneIdOrName.toLowerCase());
    if (!zone) {
      throw new RoonUnavailableError(`roon_zone_not_found: ${zoneIdOrName}`);
    }

    return new Promise((resolve, reject) => {
      transport.control(zone, action, (err) => {
        if (err) reject(new RoonUnavailableError(`roon_control_failed: ${err}`));
        else resolve();
      });
    });
  }

  private getZones(transport: RoonTransportService): Promise<RoonZone[]> {
    return new Promise((resolve, reject) => {
      transport.get_zones((err, body) => {
        if (err || !body) {
          reject(new RoonUnavailableError(`roon_get_zones_failed: ${err || "no_response"}`));
          return;
        }
        resolve(body.zones);
      });
    });
  }

  private getTransport(): RoonTransportService {
    const svc = this.state.core?.services.RoonApiTransport;
    if (!svc) {
      throw new RoonUnavailableError(
        `roon_pending_authorization: '${this.displayName}' is registered but not yet approved. Approve it in Roon (Settings -> Extensions) on ${this.host}.`,
      );
    }
    return svc;
  }

  private loadPersistedState(): PersistedState {
    try {
      return JSON.parse(readFileSync(this.tokenPath, "utf8")) as PersistedState;
    } catch {
      return {};
    }
  }

  private savePersistedState(state: PersistedState): void {
    try {
      mkdirSync(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.tokenPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (err) {
      console.warn(`[roon] failed to persist token at ${this.tokenPath}: ${errorMessage(err)}`);
    }
  }

  private settlePairingWaiters(err: Error | null): void {
    const waiters = this.pairingWaiters;
    this.pairingWaiters = [];
    for (const waiter of waiters) {
      if (err) waiter.reject(err);
      else waiter.resolve();
    }
  }

  private startConnection(): void {
    const { RoonApi: RoonApiCtor, RoonApiStatus: RoonApiStatusCtor, RoonApiTransport: RoonApiTransportCtor } = this.deps;

    this.roonApi = new RoonApiCtor({
      extension_id: this.extensionId,
      display_name: this.displayName,
      display_version: this.displayVersion,
      publisher: this.publisher,
      email: this.email,
      website: this.website,
      get_persisted_state: () => this.loadPersistedState(),
      set_persisted_state: (state: PersistedState) => this.savePersistedState(state),
      core_paired: (core: RoonCore) => {
        this.state = { phase: "connected", core, lastError: null };
        console.log(`[roon] paired with core "${core.display_name}" (${core.core_id})`);
        this.settlePairingWaiters(null);
      },
      core_unpaired: (core: RoonCore) => {
        console.warn(`[roon] unpaired from core "${core.display_name}"`);
        this.state = { phase: "disconnected", core: null, lastError: "roon_unpaired" };
        this.connectStarted = false;
      },
    });

    const statusSvc = new RoonApiStatusCtor(this.roonApi);

    this.roonApi.init_services({
      required_services: [RoonApiTransportCtor],
      provided_services: [statusSvc],
    });

    statusSvc.set_status(`Waiting for Roon Core on ${this.host}...`, false);

    this.state = { phase: "connecting", core: null, lastError: null };

    this.moo = this.roonApi.ws_connect({
      host: this.host,
      port: this.port,
      onclose: () => {
        if (this.state.phase === "connected") {
          this.state = { phase: "disconnected", core: null, lastError: "roon_connection_closed" };
        } else {
          this.state = {
            phase: "disconnected",
            core: null,
            lastError: `roon_connection_closed: ${this.host}:${this.port}`,
          };
        }
        this.connectStarted = false;
        this.settlePairingWaiters(new RoonUnavailableError(this.state.lastError!));
      },
      onerror: () => {
        this.state = {
          phase: "disconnected",
          core: null,
          lastError: `roon_connection_error: cannot reach ${this.host}:${this.port}`,
        };
        this.connectStarted = false;
        this.settlePairingWaiters(new RoonUnavailableError(this.state.lastError!));
      },
    });
  }

  /** Closes the websocket to Roon, if one is open. Safe to call anytime. */
  close(): void {
    this.moo?.transport?.close?.();
    this.moo = null;
    this.connectStarted = false;
    this.state = { phase: "idle", core: null, lastError: null };
    this.settlePairingWaiters(new RoonUnavailableError("roon_client_closed"));
  }
}

function toZoneSummary(zone: RoonZone): ZoneSummary {
  return {
    zoneId: zone.zone_id,
    displayName: zone.display_name,
    state: zone.state,
    nowPlaying: zone.now_playing?.three_line
      ? {
          line1: zone.now_playing.three_line.line1 ?? "",
          line2: zone.now_playing.three_line.line2 ?? "",
          line3: zone.now_playing.three_line.line3 ?? "",
        }
      : null,
    seekPosition: zone.now_playing?.seek_position ?? null,
    isPlayAllowed: Boolean(zone.is_play_allowed),
    isPauseAllowed: Boolean(zone.is_pause_allowed),
    isPreviousAllowed: Boolean(zone.is_previous_allowed),
    isNextAllowed: Boolean(zone.is_next_allowed),
  };
}

/** Shared singleton — same pattern as `engineClient`: one connection per process. */
let sharedClient: RoonClient | null = null;
function getSharedClient(): RoonClient {
  if (!sharedClient) sharedClient = new RoonClient();
  return sharedClient;
}

export function connectRoon(): Promise<void> {
  return getSharedClient().connectRoon();
}

export function listZones(): Promise<ZoneSummary[]> {
  return getSharedClient().listZones();
}

export function control(zoneIdOrName: string, action: ControlAction): Promise<void> {
  return getSharedClient().control(zoneIdOrName, action);
}

export function roonStatus(): RoonState {
  return getSharedClient().status;
}

export function closeRoon(): void {
  sharedClient?.close();
}
