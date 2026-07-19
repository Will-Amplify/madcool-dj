import { LocalConnector } from "./local.js";
import { SpotifyConnector } from "./spotify.js";
import { TidalConnector } from "./tidal.js";
import { NotConfiguredError, type SearchHit, type SourceConnector } from "./types.js";

export { LocalConnector } from "./local.js";
export { SpotifyConnector } from "./spotify.js";
export { TidalConnector } from "./tidal.js";
export {
  NotConfiguredError,
  type ResolvedTrack,
  type SearchHit,
  type SourceConnector,
} from "./types.js";

const local = new LocalConnector();
const spotify = new SpotifyConnector();
const tidal = new TidalConnector();

const SEARCH_CONNECTORS: SourceConnector[] = [local, spotify, tidal];

export interface SourceSearchResult {
  hits: SearchHit[];
  skipped: Array<{ source: SourceConnector["id"]; reason: string }>;
}

/** Fan out search across local + streaming stubs; unconfigured sources are skipped. */
export async function searchSources(q: string): Promise<SourceSearchResult> {
  const hits: SearchHit[] = [];
  const skipped: SourceSearchResult["skipped"] = [];

  await Promise.all(
    SEARCH_CONNECTORS.map(async (connector) => {
      try {
        hits.push(...(await connector.search(q)));
      } catch (err) {
        if (err instanceof NotConfiguredError) {
          skipped.push({ source: connector.id, reason: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  return { hits, skipped };
}

export function getConnector(id: SourceConnector["id"]): SourceConnector {
  switch (id) {
    case "local":
      return local;
    case "spotify":
      return spotify;
    case "tidal":
      return tidal;
    case "roon":
      throw new Error("roon_connector_not_implemented");
    default: {
      const _exhaustive: never = id;
      throw new Error(`unknown_source: ${String(_exhaustive)}`);
    }
  }
}
