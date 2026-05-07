import type { BetterAuthPlugin } from "better-auth"
import type { CrossDevicePluginOptions, CrossDeviceProofErrorCode } from "./internal/types"
import { APIError } from "better-auth"
import { normalizeEndpointPrefix } from "./internal/endpoint-catalog"
import { CROSS_DEVICE_ERROR_CODES, crossDeviceApiError } from "./internal/error-codes"
import { createCrossDeviceEndpoints } from "./internal/http/routes"
import { createCrossDeviceOrderLifecycle } from "./internal/order/lifecycle"
import { createCrossDeviceSchema } from "./internal/schema"

const DEFAULT_APP_NAME = "Cross Device Approval"
const DEFAULT_ORDER_TTL_SECONDS = 120
const DEFAULT_TOKEN_HEADER_NAME = "set-auth-token"
const DEFAULT_ORDER_MODEL_NAME = "crossDeviceOrder"
const DEFAULT_CLAIM_PATH_TEMPLATE = "/cross-device/claim/{orderId}?token={claimToken}"

export class CrossDeviceProofError extends Error {
  code: CrossDeviceProofErrorCode
  metadata?: Record<string, unknown>

  constructor(
    message: string,
    options: { code?: CrossDeviceProofErrorCode; metadata?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = "CrossDeviceProofError"
    this.code = options.code ?? "BAD_REQUEST"
    this.metadata = options.metadata
  }
}

function normalizeTrustedOrigins(origins: readonly string[] | undefined): Set<string> {
  return new Set((origins ?? []).map((origin) => origin.replace(/\/+$/g, "")))
}

function normalizeProofError(
  error: unknown,
  input: { orderId: string; adapterId: string },
): APIError {
  if (error instanceof CrossDeviceProofError) {
    console.warn("[cross-device] proof verification failed", {
      orderId: input.orderId,
      adapterId: input.adapterId,
      code: error.code,
      message: error.message,
      ...error.metadata,
    })

    return APIError.from(error.code, {
      code: CROSS_DEVICE_ERROR_CODES.PROOF_FAILED.code,
      message: error.message,
    })
  }

  if (error instanceof APIError) return error

  console.error("[cross-device] unexpected proof verification failure", {
    orderId: input.orderId,
    adapterId: input.adapterId,
    message: error instanceof Error ? error.message : CROSS_DEVICE_ERROR_CODES.PROOF_FAILED.message,
  })

  return crossDeviceApiError("INTERNAL_SERVER_ERROR", CROSS_DEVICE_ERROR_CODES.PROOF_FAILED)
}

export function crossDevice(options: CrossDevicePluginOptions) {
  const appName = options.appName || DEFAULT_APP_NAME
  const endpointPrefix = normalizeEndpointPrefix(options.endpointPrefix)
  const trustedOrigins = normalizeTrustedOrigins(options.trustedOrigins)
  const orderTtlSeconds = options.orderTtlSeconds ?? DEFAULT_ORDER_TTL_SECONDS
  const tokenHeaderName = options.tokenHeaderName || DEFAULT_TOKEN_HEADER_NAME
  const orderModelName = options.orderModelName || DEFAULT_ORDER_MODEL_NAME
  const enforceOrigin = options.enforceOrigin ?? true
  const claimPathTemplate = options.claimPathTemplate || DEFAULT_CLAIM_PATH_TEMPLATE
  const adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]))
  if (adapters.size === 0) throw new Error(CROSS_DEVICE_ERROR_CODES.ADAPTER_REQUIRED.message)

  const firstAdapterId = options.adapters[0]?.id
  const lifecycle = createCrossDeviceOrderLifecycle({
    appName,
    adapters,
    firstAdapterId,
    orderModelName,
    orderTtlSeconds,
    claimPathTemplate,
    normalizeProofError,
    resolveLogin: options.resolveLogin,
  })

  return {
    id: "cross-device",
    schema: createCrossDeviceSchema(orderModelName),
    endpoints: createCrossDeviceEndpoints({
      endpointPrefix,
      enforceOrigin,
      lifecycle,
      tokenHeaderName,
      trustedOrigins,
    }),
    $ERROR_CODES: CROSS_DEVICE_ERROR_CODES,
    options,
  } satisfies BetterAuthPlugin
}

export { CROSS_DEVICE_ERROR_CODES }
export type {
  CrossDeviceAdapter,
  CrossDeviceApproveResponse,
  CrossDeviceCancelResponse,
  CrossDeviceChallengeDisplay,
  CrossDeviceChallengeEnvelope,
  CrossDeviceChallengeResponse,
  CrossDeviceClaimResponse,
  CrossDeviceFinalizeResponse,
  CrossDeviceOrderEvent,
  CrossDeviceOrderKind,
  CrossDeviceOrderStatus,
  CrossDevicePluginOptions,
  CrossDeviceProofErrorCode,
  CrossDeviceRejectResponse,
  CrossDeviceStartResponse,
  CrossDeviceVerifiedProof,
  ResolveCrossDeviceLoginInput,
} from "./internal/types"
