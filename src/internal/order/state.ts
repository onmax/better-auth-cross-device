import type { StoredCrossDeviceOrderStatus, StoredOrderRecord } from "../types"
import { CROSS_DEVICE_ERROR_CODES, crossDeviceApiError } from "../error-codes"

export const TERMINAL_ORDER_STATUSES = new Set<StoredCrossDeviceOrderStatus>([
  "expired",
  "rejected",
  "cancelled",
  "finalized",
])

export const ACTIVE_APPROVAL_STATUSES = ["claimed", "waiting_user"] as const
export const IDEMPOTENT_CLAIM_STATUSES = ["claimed", "waiting_user", "approved"] as const
export const CANCELLABLE_STATUSES = ["created", "claimed", "waiting_user"] as const

export function parseOrderExpiresAt(value: unknown): Date {
  if (value instanceof Date) return value

  if (typeof value === "number" || typeof value === "string") return new Date(value)

  return new Date(0)
}

export function publicOrderId(order: Pick<StoredOrderRecord, "id" | "publicId">): string {
  return order.publicId || order.id
}

export function isTerminalOrderStatus(status: StoredCrossDeviceOrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status)
}

export function isOrderExpired(
  order: Pick<StoredOrderRecord, "expiresAt">,
  now = Date.now(),
): boolean {
  return parseOrderExpiresAt(order.expiresAt).getTime() <= now
}

export function assertNotTerminal(order: Pick<StoredOrderRecord, "status">): void {
  if (isTerminalOrderStatus(order.status))
    throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.TRANSITION_CONFLICT)
}

export function assertCanApprove(order: Pick<StoredOrderRecord, "status">): void {
  if (order.status === "approved") return

  if (order.status !== "claimed" && order.status !== "waiting_user")
    throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.NOT_READY_TO_APPROVE)
}

export function assertCanReject(order: Pick<StoredOrderRecord, "status">): void {
  if (order.status !== "claimed" && order.status !== "waiting_user")
    throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.NOT_READY_TO_REJECT)
}

export function assertCanCancel(order: Pick<StoredOrderRecord, "status">): void {
  if (order.status !== "created" && order.status !== "claimed" && order.status !== "waiting_user")
    throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.NOT_READY_TO_CANCEL)
}

export function assertCanFinalize(order: Pick<StoredOrderRecord, "status">): void {
  if (order.status !== "approved" && order.status !== "finalized")
    throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.NOT_READY_TO_FINALIZE)
}
