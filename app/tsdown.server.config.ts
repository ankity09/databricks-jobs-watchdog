import { appkitServerConfig } from '@databricks/appkit/tsdown';

// The server build settings that AppKit provides. Code agents kept in
// `server/agents/` are included as build entries, so they are found in a bundled build.
// To change them, pass options, for example `appkitServerConfig({ external, define })`,
// or pass a function that takes the base settings and returns your own.
export default appkitServerConfig();
