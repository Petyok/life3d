// Browser build stand-in for @dimforge/rapier3d-compat (aliased in vite.config.js).
// The non-compat package ships rapier's .wasm as a separate binary file, about
// 0.6 MB smaller over the wire than compat's inlined base64. Same API, and it
// needs no init step. Node tools keep using the compat package directly.
import * as R from '@dimforge/rapier3d';

export default { ...R, init: async () => {} };
