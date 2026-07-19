/**
 * Roon live smoke test: connects to the real Roon Core on Simon
 * (`ROON_HOST`, default 100.109.124.125) and tries to list zones.
 *
 * First run against a fresh Core will very likely print
 * "roon_pending_authorization" — that's expected, not a failure. Approve
 * "MadCool DJ" once in Roon (Settings -> Extensions) on Simon, then re-run.
 * After approval, the persisted token under `~/.config/madcool-dj/roon_token`
 * means subsequent runs (and the real control server) reconnect silently.
 *
 * Run: npx tsx scripts/roon-smoke.ts
 */

import { closeRoon, listZones, RoonUnavailableError } from "../src/roon.js";

async function main(): Promise<void> {
  const host = process.env.ROON_HOST || "100.109.124.125";
  console.log(`[roon-smoke] connecting to Roon Core at ${host}...`);

  try {
    const zones = await listZones();
    console.log(`[roon-smoke] got ${zones.length} zone(s):`);
    for (const zone of zones) {
      console.log(`  - ${zone.displayName} (${zone.zoneId}): ${zone.state}`);
    }
  } catch (err) {
    if (err instanceof RoonUnavailableError) {
      console.log(`[roon-smoke] Roon unavailable (not a crash): ${err.message}`);
      console.log("[roon-smoke] if this says 'pending_authorization', approve 'MadCool DJ' in Roon Settings -> Extensions on Simon, then re-run.");
      return;
    }
    throw err;
  } finally {
    // The websocket to Roon stays open by design (so a real server keeps its
    // pairing alive) — for this one-shot script, close it so the process exits.
    closeRoon();
  }
}

main()
  .catch((err) => {
    console.error("roon-smoke failed unexpectedly:", err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
