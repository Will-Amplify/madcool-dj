import { NotConfiguredError, type SourceConnector } from "./types.js";

const HINT =
  "set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the environment (future: PCM stream path via librespot or Spotify Connect bridge)";

export class SpotifyConnector implements SourceConnector {
  readonly id = "spotify" as const;

  async search(_q: string): Promise<never> {
    throw new NotConfiguredError("Spotify", HINT);
  }

  async resolve(_id: string): Promise<never> {
    throw new NotConfiguredError("Spotify", HINT);
  }

  async getPlayable(_id: string): Promise<never> {
    throw new NotConfiguredError("Spotify", HINT);
  }
}
