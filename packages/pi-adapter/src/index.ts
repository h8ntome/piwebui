export { resolvePiPackage, bridgeExtensionPath } from "./pi-resolve.ts";
// NOTE: importPi() is intentionally NOT re-exported from this barrel; only adapter
// entry processes (read worker, managed host, probes) import it via subpath so the
// HTTP server never transitively loads Pi. See scripts/lint-boundaries.ts.
