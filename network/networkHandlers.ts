// Canonical complex-plugin network entrypoint used by generated registries.
//
// The underlying implementation lives in `scalexHandlers.ts`. This file
// keeps the external plugin contract generic and vendor-agnostic, matching
// the convention `plugins/athena/network/networkHandlers.ts` uses.
export { handlePluginNetworkOperation, handleScaleXNetworkOperation } from './scalexHandlers';
