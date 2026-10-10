import { createRequire } from "node:module";
/** Same relative path from src/ and dist/: the package is the version authority. */
export const SERVER_VERSION: string = createRequire(import.meta.url)(
  "../package.json",
).version;
