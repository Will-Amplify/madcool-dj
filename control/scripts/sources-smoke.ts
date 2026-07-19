/**
 * Source connector smoke test: asserts Spotify/Tidal stubs throw
 * NotConfiguredError and LocalConnector compiles + behaves against a fake
 * library list (no engine socket required).
 *
 * Run: npx tsx scripts/sources-smoke.ts
 */

import * as assert from "node:assert/strict";

import { LocalConnector } from "../src/sources/local.js";
import { SpotifyConnector } from "../src/sources/spotify.js";
import { TidalConnector } from "../src/sources/tidal.js";
import { NotConfiguredError } from "../src/sources/types.js";

async function expectNotConfigured(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${label} to throw NotConfiguredError`);
  } catch (err) {
    assert.ok(err instanceof NotConfiguredError, `${label} should throw NotConfiguredError, got ${err}`);
    console.log(`  ok: ${label} -> ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log("1. Spotify stub throws NotConfiguredError");
  const spotify = new SpotifyConnector();
  await expectNotConfigured(spotify.search("test"), "SpotifyConnector.search()");
  await expectNotConfigured(spotify.resolve("track-id"), "SpotifyConnector.resolve()");
  await expectNotConfigured(spotify.getPlayable("track-id"), "SpotifyConnector.getPlayable()");

  console.log("\n2. Tidal stub throws NotConfiguredError");
  const tidal = new TidalConnector();
  await expectNotConfigured(tidal.search("test"), "TidalConnector.search()");
  await expectNotConfigured(tidal.resolve("track-id"), "TidalConnector.resolve()");
  await expectNotConfigured(tidal.getPlayable("track-id"), "TidalConnector.getPlayable()");

  console.log("\n3. LocalConnector search/resolve/getPlayable");
  const local = new LocalConnector(async () => ({
    tracks: [
      { path: "/music/Artist - Title.flac", analysis: { duration_sec: 240 } },
      { path: "/music/other.wav" },
    ],
  }));

  const hits = await local.search("title");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "local");
  assert.equal(hits[0].id, "/music/Artist - Title.flac");
  console.log(`  ok: search("title") -> ${JSON.stringify(hits[0])}`);

  const resolved = await local.resolve("/music/Artist - Title.flac");
  assert.equal(resolved.durationSec, 240);
  assert.equal(resolved.title, "Artist - Title");
  console.log(`  ok: resolve() -> ${JSON.stringify(resolved)}`);

  const playable = await local.getPlayable("/music/Artist - Title.flac");
  assert.deepEqual(playable, { kind: "file", path: "/music/Artist - Title.flac" });
  console.log("  ok: getPlayable() -> file path");

  console.log("\nall source connector scenarios passed");
}

main().catch((err) => {
  console.error("sources-smoke failed:", err);
  process.exitCode = 1;
});
