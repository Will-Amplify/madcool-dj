/**
 * `node-roon-api` / `node-roon-api-transport` / `node-roon-api-status` are
 * plain CommonJS modules (installed straight from GitHub, see
 * https://github.com/RoonLabs/node-roon-api) with no published types. These
 * ambient declarations just unblock `tsc` — `roon.ts` treats every value
 * from these modules as `any` and narrows what it needs via local
 * interfaces instead.
 */

declare module "node-roon-api" {
  const RoonApi: any;
  export default RoonApi;
}

declare module "node-roon-api-transport" {
  const RoonApiTransport: any;
  export default RoonApiTransport;
}

declare module "node-roon-api-status" {
  const RoonApiStatus: any;
  export default RoonApiStatus;
}
