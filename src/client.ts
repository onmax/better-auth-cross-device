import type { BetterAuthClientPlugin } from "better-auth/client";

export function crossDeviceClient(): BetterAuthClientPlugin {
  return {
    id: "cross-device",
    $InferServerPlugin: {} as ReturnType<typeof import("./index").crossDevice>,
  } satisfies BetterAuthClientPlugin;
}
