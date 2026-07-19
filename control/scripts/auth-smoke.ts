/**
 * Auth cradle: loopback allows empty token; non-loopback refuses without token;
 * timing-safe match works for Bearer values.
 */
import assert from "node:assert/strict";

import { isLoopbackHost, requireTokenForBind, tokenMatches } from "../src/auth.js";

assert.equal(isLoopbackHost("127.0.0.1"), true);
assert.equal(isLoopbackHost("0.0.0.0"), false);
assert.equal(isLoopbackHost("100.85.196.90"), false);

const prev = process.env.DJ_TOKEN;
delete process.env.DJ_TOKEN;
assert.doesNotThrow(() => requireTokenForBind("127.0.0.1"));
assert.throws(() => requireTokenForBind("0.0.0.0"), /DJ_TOKEN is required/);

process.env.DJ_TOKEN = "secret-token-value";
assert.doesNotThrow(() => requireTokenForBind("0.0.0.0"));
assert.equal(tokenMatches("secret-token-value"), true);
assert.equal(tokenMatches("wrong"), false);
assert.equal(tokenMatches(null), false);

if (prev === undefined) delete process.env.DJ_TOKEN;
else process.env.DJ_TOKEN = prev;

console.log("auth-smoke: ok");
