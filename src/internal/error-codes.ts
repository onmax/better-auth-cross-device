import { APIError } from "better-auth"

function defineErrorCodes<const T extends Record<string, string>>(codes: T) {
  return Object.fromEntries(
    Object.entries(codes).map(([code, message]) => [code, { code, message }]),
  ) as { readonly [K in keyof T]: { readonly code: K; readonly message: T[K] } }
}

export const CROSS_DEVICE_ERROR_CODES = defineErrorCodes({
  ADAPTER_REQUIRED: "crossDevice requires at least one adapter",
  EVENT_STREAM_FAILED: "Event stream failed",
  FAILED_TO_CREATE_SESSION: "Failed to create session",
  FINALIZE_ALREADY_USED: "Cross-device login finalization was already used",
  INVALID_CHALLENGE_TOKEN: "Invalid challenge token",
  INVALID_CLAIM_TOKEN: "Invalid claim token",
  INVALID_DESKTOP_TOKEN: "Invalid desktop token",
  INVALID_EVENT_TOKEN: "Invalid event token",
  INVALID_PROOF: "Invalid proof",
  MISSING_LOGIN_RESOLUTION_HANDLER: "Missing login resolution handler",
  NO_ADAPTER_CONFIGURED: "No cross-device adapter configured",
  NOT_READY_TO_APPROVE: "Order is not ready to approve",
  NOT_READY_TO_CANCEL: "Order is not ready to cancel",
  NOT_READY_TO_FINALIZE: "Order is not ready to finalize",
  NOT_READY_TO_REJECT: "Order is not ready to reject",
  ORDER_EXPIRED: "Order expired",
  ORDER_NOT_FOUND: "Order not found",
  ORIGIN_MISMATCH: "Origin mismatch",
  PROOF_FAILED: "Unable to verify cross-device proof",
  RETURN_TO_NOT_ALLOWED: "returnTo must be a relative path",
  TRANSITION_CONFLICT: "Order status changed before this operation completed",
  UNABLE_TO_RESOLVE_APPROVED_LOGIN: "Unable to resolve approved login",
  UNABLE_TO_RESOLVE_ORIGIN: "Unable to resolve request origin",
  UNSUPPORTED_ADAPTER: "Unsupported cross-device adapter",
  UNTRUSTED_ORIGIN: "Origin is not trusted for cross-device approval",
})

export function crossDeviceApiError(
  status: Parameters<typeof APIError.from>[0],
  error: (typeof CROSS_DEVICE_ERROR_CODES)[keyof typeof CROSS_DEVICE_ERROR_CODES],
): APIError {
  return APIError.from(status, error)
}
