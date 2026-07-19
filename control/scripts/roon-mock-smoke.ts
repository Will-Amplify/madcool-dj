/**
 * Roon mock smoke test: exercises `RoonClient`'s state machine against a
 * fake `RoonApi`/`RoonApiStatus`/`RoonApiTransport` — no network, no real
 * Roon Core needed. Covers the three shapes bus.ts actually has to handle:
 *
 *   1. Pending authorization (extension registered, human hasn't clicked
 *      "Enable" yet) -> listZones()/control() reject with RoonUnavailableError.
 *   2. Connected with zones -> listZones() resolves, control() resolves by
 *      id or by case-insensitive display name.
 *   3. Connection error (Core unreachable) -> same RoonUnavailableError shape,
 *      never an uncaught throw/crash.
 *
 * Run: npx tsx scripts/roon-mock-smoke.ts
 */

import * as assert from "node:assert/strict";

import { RoonClient, RoonUnavailableError, type RoonDeps } from "../src/roon.js";

type Handlers = Record<string, (...args: unknown[]) => void>;

/** Minimal fake mirroring the bits of `node-roon-api`'s surface RoonClient touches. */
function makeFakeRoonApi(behavior: {
  pairs: boolean;
  zones: Array<Record<string, unknown>>;
  controlOk: boolean;
}) {
  let registeredCore: unknown = null;

  const FakeRoonApiTransport = { fake: "RoonApiTransport" };
  const FakeRoonApiStatus = function (this: Record<string, unknown>) {
    this.set_status = (_msg: string, _isError: boolean) => {};
  } as unknown as new () => { set_status: (msg: string, isError: boolean) => void };

  const FakeRoonApi = function (this: Handlers & Record<string, unknown>, opts: Handlers) {
    this._opts = opts;
    this.init_services = (_svc: unknown) => {};
    this.ws_connect = ({ onclose, onerror }: { onclose: () => void; onerror: () => void }) => {
      queueMicrotask(() => {
        if (!behavior.pairs) {
          // Simulate "registered, but nobody has clicked Enable yet": the
          // socket just... sits there. No close, no error, no core_paired.
          return;
        }
        const transport = {
          get_zones: (cb: (err: string | false, body: { zones: unknown[] } | undefined) => void) => {
            cb(false, { zones: behavior.zones });
          },
          control: (_zone: unknown, _action: string, cb: (err: string | false) => void) => {
            cb(behavior.controlOk ? false : "Failed");
          },
        };
        registeredCore = {
          core_id: "core-1",
          display_name: "Fake Core",
          services: { RoonApiTransport: transport },
        };
        (opts.core_paired as (core: unknown) => void)(registeredCore);
      });
      return { transport: { close: () => onclose && undefined } };
    };
  } as unknown as new (opts: Handlers) => Handlers;

  return { RoonApi: FakeRoonApi, RoonApiStatus: FakeRoonApiStatus, RoonApiTransport: FakeRoonApiTransport } as RoonDeps;
}

function makeErrorRoonApi(): RoonDeps {
  const FakeRoonApiStatus = function (this: Record<string, unknown>) {
    this.set_status = () => {};
  } as unknown as new () => { set_status: (msg: string, isError: boolean) => void };

  const FakeRoonApi = function (this: Handlers & Record<string, unknown>, opts: Handlers) {
    this.init_services = () => {};
    this.ws_connect = ({ onerror }: { onerror: () => void }) => {
      queueMicrotask(() => onerror());
      return { transport: { close: () => {} } };
    };
  } as unknown as new (opts: Handlers) => Handlers;

  return { RoonApi: FakeRoonApi, RoonApiStatus: FakeRoonApiStatus, RoonApiTransport: {} } as RoonDeps;
}

async function expectRejects(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${label} to reject`);
  } catch (err) {
    assert.ok(err instanceof RoonUnavailableError, `${label} should reject with RoonUnavailableError, got ${err}`);
    console.log(`  ok: ${label} -> ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log("1. pending authorization (extension registered, not yet enabled)");
  const pendingClient = new RoonClient(makeFakeRoonApi({ pairs: false, zones: [], controlOk: true }), {
    pairTimeoutMs: 50,
  });
  await expectRejects(pendingClient.listZones(), "listZones() while pending");
  await expectRejects(pendingClient.control("Living Room", "play"), "control() while pending");

  console.log("\n2. connected with zones");
  const connectedClient = new RoonClient(
    makeFakeRoonApi({
      pairs: true,
      zones: [
        {
          zone_id: "zone-1",
          display_name: "Living Room",
          state: "playing",
          is_play_allowed: false,
          is_pause_allowed: true,
          is_previous_allowed: true,
          is_next_allowed: true,
          now_playing: { seek_position: 42, three_line: { line1: "Track", line2: "Artist", line3: "Album" } },
        },
      ],
      controlOk: true,
    }),
    { pairTimeoutMs: 2000 },
  );
  const zones = await connectedClient.listZones();
  assert.equal(zones.length, 1);
  assert.equal(zones[0].displayName, "Living Room");
  assert.equal(zones[0].seekPosition, 42);
  console.log(`  ok: listZones() -> ${JSON.stringify(zones[0])}`);

  await connectedClient.control("living room", "pause"); // case-insensitive name match
  console.log("  ok: control() by display name resolved");
  await connectedClient.control("zone-1", "play"); // exact id match
  console.log("  ok: control() by zone id resolved");
  await expectRejects(connectedClient.control("nonexistent", "play"), "control() on unknown zone");

  console.log("\n3. connection error (Core unreachable)");
  const errorClient = new RoonClient(makeErrorRoonApi(), { pairTimeoutMs: 2000 });
  await expectRejects(errorClient.listZones(), "listZones() with unreachable Core");

  console.log("\nall roon mock scenarios passed");
}

main().catch((err) => {
  console.error("roon-mock-smoke failed:", err);
  process.exitCode = 1;
});
