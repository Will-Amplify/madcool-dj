import { NotConfiguredError, type SourceConnector } from "./types.js";

const HINT =
  "set TIDAL credentials or install tidal-dl (future: PCM stream path via tidalapi or local cache)";

export class TidalConnector implements SourceConnector {
  readonly id = "tidal" as const;

  async search(_q: string): Promise<never> {
    throw new NotConfiguredError("Tidal", HINT);
  }

  async resolve(_id: string): Promise<never> {
    throw new NotConfiguredError("Tidal", HINT);
  }

  async getPlayable(_id: string): Promise<never> {
    throw new NotConfiguredError("Tidal", HINT);
  }
}
