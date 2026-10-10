import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { SERVER_VERSION } from "./version.js";
it("agrees with package and registry versions", () => {
  const require = createRequire(import.meta.url),
    pkg = require("../package.json"),
    server = require("../server.json");
  expect(SERVER_VERSION).toBe(pkg.version);
  expect(server.version).toBe(pkg.version);
  expect(server.packages[0].version).toBe(pkg.version);
});
