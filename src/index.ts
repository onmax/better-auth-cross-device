import type { BetterAuthPlugin } from "better-auth";

export interface CrossDevicePluginOptions {
  endpointPrefix?: `/${string}`;
}

export function crossDevice(options: CrossDevicePluginOptions = {}): BetterAuthPlugin {
  void options;

  return {
    id: "cross-device",
    endpoints: {},
  } satisfies BetterAuthPlugin;
}
