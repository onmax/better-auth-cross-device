import type { CrossDeviceOrderEvent } from "./types"

const DEFAULT_ENDPOINT_PREFIX = "/cross-device"
const TRAILING_SLASHES_RE = /\/+$/g

export const CROSS_DEVICE_ENDPOINTS = {
  start: {
    id: "crossDeviceStart",
    path: "/start",
    method: "POST",
    operationId: "crossDeviceStart",
  },
  claim: {
    id: "crossDeviceClaim",
    path: "/claim",
    method: "POST",
    operationId: "crossDeviceClaim",
  },
  challenge: {
    id: "crossDeviceChallenge",
    path: "/challenge",
    method: "POST",
    operationId: "crossDeviceChallenge",
  },
  approve: {
    id: "crossDeviceApprove",
    path: "/approve",
    method: "POST",
    operationId: "crossDeviceApprove",
  },
  reject: {
    id: "crossDeviceReject",
    path: "/reject",
    method: "POST",
    operationId: "crossDeviceReject",
  },
  cancel: {
    id: "crossDeviceCancel",
    path: "/cancel",
    method: "POST",
    operationId: "crossDeviceCancel",
  },
  finalize: {
    id: "crossDeviceFinalize",
    path: "/finalize",
    method: "POST",
    operationId: "crossDeviceFinalize",
  },
  events: {
    id: "crossDeviceEvents",
    path: "/events",
    method: "GET",
    operationId: "crossDeviceEvents",
  },
} as const

export const CROSS_DEVICE_ORDER_EVENTS: readonly CrossDeviceOrderEvent[] = [
  "claimed",
  "waiting_user",
  "approved",
  "rejected",
  "expired",
  "cancelled",
  "finalized",
]

export const TERMINAL_ORDER_EVENTS: readonly CrossDeviceOrderEvent[] = [
  "rejected",
  "expired",
  "cancelled",
  "finalized",
]

export type CrossDeviceEndpointKey = keyof typeof CROSS_DEVICE_ENDPOINTS
export type CrossDeviceEndpointMethod =
  (typeof CROSS_DEVICE_ENDPOINTS)[CrossDeviceEndpointKey]["method"]

export function normalizeEndpointPrefix(prefix: string = DEFAULT_ENDPOINT_PREFIX): `/${string}` {
  const trimmed = prefix.trim().replace(TRAILING_SLASHES_RE, "")
  if (!trimmed || !trimmed.startsWith("/")) throw new Error('endpointPrefix must start with "/"')

  return trimmed as `/${string}`
}

export function createPathMethods(
  endpointPrefix: `/${string}`,
): Record<string, CrossDeviceEndpointMethod> {
  return Object.fromEntries(
    Object.values(CROSS_DEVICE_ENDPOINTS).map((endpoint) => [
      `${endpointPrefix}${endpoint.path}`,
      endpoint.method,
    ]),
  )
}
