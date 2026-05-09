import type {
  CrossDeviceAdapter,
  CrossDeviceOrderKind,
  CrossDevicePluginOptions,
  CrossDeviceApproveResponse,
  CrossDeviceCancelResponse,
  CrossDeviceChallengeResponse,
  CrossDeviceClaimResponse,
  CrossDeviceFinalizeResponse,
  CrossDeviceOrderEvent,
  CrossDeviceRejectResponse,
  CrossDeviceRuntimeContext,
  CrossDeviceSession,
  CrossDeviceUser,
  CrossDeviceStartResponse,
  CrossDeviceVerifiedProof,
  StoredCrossDeviceOrderStatus,
  StoredOrderRecord,
} from "../types"
import { APIError } from "better-auth"
import { CROSS_DEVICE_ERROR_CODES, crossDeviceApiError } from "../error-codes"
import {
  ACTIVE_APPROVAL_STATUSES,
  CANCELLABLE_STATUSES,
  IDEMPOTENT_CLAIM_STATUSES,
  assertCanApprove,
  assertCanCancel,
  assertCanFinalize,
  assertCanReject,
  assertNotTerminal,
  isTerminalOrderStatus,
  publicOrderId,
} from "./state"
import { createCrossDeviceOrderStorage } from "./storage"
import {
  assertOrderToken,
  buildOrderChallengeEnvelope,
  buildProofVerificationInput,
  hashToken,
  issueChallengeToken,
  issueOrderSecurity,
} from "../security"
import { parseJson } from "../utils/json"

const CLAIM_TOKEN_PLACEHOLDER_RE = /\{claimToken\}/g
const ORDER_ID_PLACEHOLDER_RE = /\{orderId\}/g

export interface StartOrderInput {
  adapterId?: string
  kind: CrossDeviceOrderKind
  origin: string
  returnTo?: string
  displayTitle?: string
  displaySummary?: string
  payloadHash?: string
}

export interface CrossDeviceOrderLifecycleOptions {
  appName: string
  adapters: Map<string, CrossDeviceAdapter>
  firstAdapterId?: string
  orderModelName: string
  orderTtlSeconds: number
  claimPathTemplate: string
  normalizeProofError: (error: unknown, input: { orderId: string; adapterId: string }) => APIError
  resolveLogin?: CrossDevicePluginOptions["resolveLogin"]
}

export interface CrossDeviceFinalizedSession {
  session: CrossDeviceSession
  user: CrossDeviceUser
}

export interface CrossDeviceFinalizeResult {
  response: CrossDeviceFinalizeResponse
  session?: CrossDeviceFinalizedSession
}

export interface CrossDeviceOrderEventResult {
  event: CrossDeviceOrderEvent
  payload: Record<string, unknown>
  terminal: boolean
}

export interface CrossDeviceOrderLifecycle {
  start: (
    ctx: CrossDeviceRuntimeContext,
    input: StartOrderInput,
  ) => Promise<CrossDeviceStartResponse>
  claim: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    claimToken: string,
  ) => Promise<CrossDeviceClaimResponse>
  getChallenge: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    challengeToken: string,
  ) => Promise<CrossDeviceChallengeResponse>
  approve: (
    ctx: CrossDeviceRuntimeContext,
    input: {
      orderId: string
      challengeToken: string
      proof: unknown
      origin: string
      enforceOrigin: boolean
    },
  ) => Promise<CrossDeviceApproveResponse>
  reject: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    challengeToken: string,
  ) => Promise<CrossDeviceRejectResponse>
  cancel: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    desktopToken: string,
  ) => Promise<CrossDeviceCancelResponse>
  finalize: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    desktopToken: string,
  ) => Promise<CrossDeviceFinalizeResult>
  getNextEvent: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    eventToken: string,
    lastStatus?: string,
  ) => Promise<CrossDeviceOrderEventResult | null>
}

function interpolateClaimPath(template: string, orderId: string, claimToken: string): string {
  return template
    .replace(ORDER_ID_PLACEHOLDER_RE, encodeURIComponent(orderId))
    .replace(CLAIM_TOKEN_PLACEHOLDER_RE, encodeURIComponent(claimToken))
}

function getAdapter(
  adapters: Map<string, CrossDeviceAdapter>,
  adapterId: string,
): CrossDeviceAdapter {
  const adapter = adapters.get(adapterId)
  if (!adapter)
    throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.UNSUPPORTED_ADAPTER)

  return adapter
}

function getInternalAdapter(ctx: CrossDeviceRuntimeContext) {
  const internalAdapter = ctx.context?.internalAdapter
  if (
    !internalAdapter ||
    typeof internalAdapter !== "object" ||
    !("createSession" in internalAdapter) ||
    typeof internalAdapter.createSession !== "function"
  )
    throw crossDeviceApiError(
      "INTERNAL_SERVER_ERROR",
      CROSS_DEVICE_ERROR_CODES.FAILED_TO_CREATE_SESSION,
    )

  return internalAdapter as {
    createSession: (userId: string, dontRememberMe?: boolean) => Promise<CrossDeviceSession | null>
  }
}

export function createCrossDeviceOrderLifecycle(
  options: CrossDeviceOrderLifecycleOptions,
): CrossDeviceOrderLifecycle {
  const storage = createCrossDeviceOrderStorage(options.orderModelName)

  async function loadActiveOrder(
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
  ): Promise<StoredOrderRecord> {
    const order = await storage.findByPublicId(ctx, orderId)
    if (!order) throw crossDeviceApiError("NOT_FOUND", CROSS_DEVICE_ERROR_CODES.ORDER_NOT_FOUND)

    const activeOrder = await storage.ensureActive(ctx, order)
    if (activeOrder.status === "expired")
      throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.ORDER_EXPIRED)

    return activeOrder
  }

  function buildEventPayload(order: StoredOrderRecord): CrossDeviceOrderEventResult | null {
    if (order.status === "created" || order.status === "finalizing") return null

    return {
      event: order.status as CrossDeviceOrderEvent,
      payload: {
        orderId: publicOrderId(order),
        status: order.status,
        kind: order.kind,
        redirectTo: order.returnTo,
      },
      terminal: isTerminalOrderStatus(order.status),
    }
  }

  async function transitionOrConflict(
    ctx: CrossDeviceRuntimeContext,
    order: StoredOrderRecord,
    currentStatus: StoredCrossDeviceOrderStatus | readonly StoredCrossDeviceOrderStatus[],
    update: Partial<StoredOrderRecord> & Record<string, unknown>,
  ): Promise<StoredOrderRecord> {
    const updated = await storage.transition(ctx, order.id, currentStatus, update)
    if (!updated)
      throw crossDeviceApiError("CONFLICT", CROSS_DEVICE_ERROR_CODES.TRANSITION_CONFLICT)

    return updated
  }

  async function markFinalized(ctx: CrossDeviceRuntimeContext, order: StoredOrderRecord) {
    return transitionOrConflict(ctx, order, order.status, {
      status: "finalized",
      finalizedAt: new Date(),
    })
  }

  async function rollbackFinalizing(
    ctx: CrossDeviceRuntimeContext,
    order: StoredOrderRecord,
    errorCode: keyof typeof CROSS_DEVICE_ERROR_CODES,
    status: Parameters<typeof crossDeviceApiError>[0],
  ): Promise<APIError> {
    await storage.transition(ctx, order.id, "finalizing", { status: "approved" })
    return crossDeviceApiError(status, CROSS_DEVICE_ERROR_CODES[errorCode])
  }

  function buildNonLoginFinalizeResponse(order: StoredOrderRecord): CrossDeviceFinalizeResult {
    return {
      response: {
        ok: true,
        orderId: publicOrderId(order),
        status: "finalized",
        kind: order.kind,
        redirectTo: order.returnTo,
        proofArtifact: parseJson(order.proofArtifactJson),
      },
    }
  }

  async function finalizeLogin(
    ctx: CrossDeviceRuntimeContext,
    order: StoredOrderRecord,
  ): Promise<CrossDeviceFinalizeResult> {
    const approvedSubject = order.approvedSubject
    if (!options.resolveLogin || !approvedSubject)
      throw crossDeviceApiError(
        "INTERNAL_SERVER_ERROR",
        CROSS_DEVICE_ERROR_CODES.MISSING_LOGIN_RESOLUTION_HANDLER,
      )

    const finalizingOrder = await transitionOrConflict(ctx, order, "approved", {
      status: "finalizing",
    })

    const user = await options.resolveLogin({
      order: finalizingOrder,
      approvedSubject,
      approvedUserId: finalizingOrder.approvedUserId ?? null,
      approvedIdentity: parseJson<Record<string, unknown>>(finalizingOrder.identityJson),
      proofArtifact: parseJson(finalizingOrder.proofArtifactJson),
      ctx,
    })
    if (!user)
      throw await rollbackFinalizing(
        ctx,
        finalizingOrder,
        "UNABLE_TO_RESOLVE_APPROVED_LOGIN",
        "UNAUTHORIZED",
      )

    let session: CrossDeviceSession | null
    try {
      session = await getInternalAdapter(ctx).createSession(user.id, false)
    } catch {
      throw await rollbackFinalizing(
        ctx,
        finalizingOrder,
        "FAILED_TO_CREATE_SESSION",
        "INTERNAL_SERVER_ERROR",
      )
    }
    if (!session)
      throw await rollbackFinalizing(
        ctx,
        finalizingOrder,
        "FAILED_TO_CREATE_SESSION",
        "INTERNAL_SERVER_ERROR",
      )

    await markFinalized(ctx, finalizingOrder)

    return {
      response: {
        ok: true,
        orderId: publicOrderId(order),
        status: "finalized",
        kind: order.kind,
        redirectTo: order.returnTo,
        token: session.token,
      },
      session: { session, user },
    }
  }

  function assertApprovalGuards(
    activeOrder: StoredOrderRecord,
    input: { challengeToken: string; origin: string; enforceOrigin: boolean },
  ): void {
    if (input.enforceOrigin && activeOrder.origin !== input.origin)
      throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.ORIGIN_MISMATCH)

    assertOrderToken(
      activeOrder,
      input.challengeToken,
      "challengeTokenHash",
      "INVALID_CHALLENGE_TOKEN",
    )
  }

  async function verifyApprovalProof(
    activeOrder: StoredOrderRecord,
    proof: unknown,
  ): Promise<CrossDeviceVerifiedProof> {
    const adapter = getAdapter(options.adapters, activeOrder.adapterId)
    let verified: CrossDeviceVerifiedProof
    try {
      verified = await adapter.verifyProof(buildProofVerificationInput(activeOrder, proof))
    } catch (error) {
      throw options.normalizeProofError(error, {
        orderId: publicOrderId(activeOrder),
        adapterId: activeOrder.adapterId,
      })
    }

    if (!verified.ok || !verified.subject.trim())
      throw crossDeviceApiError("UNAUTHORIZED", CROSS_DEVICE_ERROR_CODES.INVALID_PROOF)

    return verified
  }

  return {
    async start(ctx, input) {
      const adapterId = input.adapterId || options.firstAdapterId
      if (!adapterId)
        throw crossDeviceApiError(
          "INTERNAL_SERVER_ERROR",
          CROSS_DEVICE_ERROR_CODES.NO_ADAPTER_CONFIGURED,
        )

      const adapter = getAdapter(options.adapters, adapterId)
      const issued = issueOrderSecurity({
        adapter,
        appName: options.appName,
        kind: input.kind,
        origin: input.origin,
        payloadHash: input.payloadHash,
        returnTo: input.returnTo,
        displayTitle: input.displayTitle,
        displaySummary: input.displaySummary,
        orderTtlSeconds: options.orderTtlSeconds,
      })
      const now = new Date()

      await storage.create(ctx, {
        publicId: issued.orderId,
        action: issued.action,
        challengeId: issued.challengeId,
        kind: input.kind,
        adapterId,
        origin: input.origin,
        nonce: issued.nonce,
        issuedAt: issued.issuedAt,
        message: issued.message,
        returnTo: issued.returnTo,
        status: "created",
        displayTitle: issued.displayTitle,
        displaySummary: issued.displaySummary,
        detailsJson: issued.detailsJson,
        payloadHash: input.payloadHash ?? null,
        claimTokenHash: hashToken(issued.claimToken),
        desktopTokenHash: hashToken(issued.desktopToken),
        eventTokenHash: hashToken(issued.eventToken),
        challengeToken: null,
        challengeTokenHash: null,
        approvedUserId: null,
        approvedSubject: null,
        identityJson: null,
        proofArtifactJson: null,
        claimedAt: null,
        approvedAt: null,
        rejectedAt: null,
        cancelledAt: null,
        finalizedAt: null,
        expiresAt: issued.expiresAt,
        createdAt: now,
        updatedAt: now,
      })

      return {
        orderId: issued.orderId,
        adapterId,
        kind: input.kind,
        status: "created",
        claimToken: issued.claimToken,
        claimUrl: `${input.origin}${interpolateClaimPath(options.claimPathTemplate, issued.orderId, issued.claimToken)}`,
        eventToken: issued.eventToken,
        desktopToken: issued.desktopToken,
        expiresAt: issued.expiresAtMs,
      }
    },

    async claim(ctx, orderId, claimToken) {
      const activeOrder = await loadActiveOrder(ctx, orderId)
      assertNotTerminal(activeOrder)
      assertOrderToken(activeOrder, claimToken, "claimTokenHash", "INVALID_CLAIM_TOKEN")

      if (
        activeOrder.challengeToken &&
        activeOrder.challengeTokenHash &&
        (IDEMPOTENT_CLAIM_STATUSES as readonly string[]).includes(activeOrder.status)
      ) {
        return {
          ok: true,
          orderId: publicOrderId(activeOrder),
          status: "claimed",
          challengeToken: activeOrder.challengeToken,
        }
      }

      const challengeToken = issueChallengeToken()
      await transitionOrConflict(ctx, activeOrder, "created", {
        status: "claimed",
        challengeToken,
        challengeTokenHash: hashToken(challengeToken),
        claimedAt: activeOrder.claimedAt ?? new Date(),
      })

      return {
        ok: true,
        orderId: publicOrderId(activeOrder),
        status: "claimed",
        challengeToken,
      }
    },

    async getChallenge(ctx, orderId, challengeToken) {
      let activeOrder = await loadActiveOrder(ctx, orderId)
      assertNotTerminal(activeOrder)
      assertOrderToken(activeOrder, challengeToken, "challengeTokenHash", "INVALID_CHALLENGE_TOKEN")

      if (activeOrder.status === "claimed")
        activeOrder = await transitionOrConflict(ctx, activeOrder, "claimed", {
          status: "waiting_user",
        })

      const responseStatus =
        activeOrder.status === "approved" || activeOrder.status === "waiting_user"
          ? activeOrder.status
          : "claimed"

      return {
        ...buildOrderChallengeEnvelope(activeOrder),
        adapterId: activeOrder.adapterId,
        status: responseStatus,
      }
    },

    async approve(ctx, input) {
      const activeOrder = await loadActiveOrder(ctx, input.orderId)
      assertCanApprove(activeOrder)
      assertApprovalGuards(activeOrder, input)

      if (activeOrder.status === "approved")
        return { ok: true, orderId: publicOrderId(activeOrder), status: "approved" }

      const verified = await verifyApprovalProof(activeOrder, input.proof)

      await transitionOrConflict(ctx, activeOrder, ACTIVE_APPROVAL_STATUSES, {
        status: "approved",
        approvedAt: new Date(),
        approvedSubject: verified.subject,
        approvedUserId: verified.userId ?? null,
        identityJson: verified.identity ? JSON.stringify(verified.identity) : null,
        proofArtifactJson:
          verified.proofArtifact !== undefined ? JSON.stringify(verified.proofArtifact) : null,
      })

      return { ok: true, orderId: publicOrderId(activeOrder), status: "approved" }
    },

    async reject(ctx, orderId, challengeToken) {
      const activeOrder = await loadActiveOrder(ctx, orderId)
      assertCanReject(activeOrder)
      assertOrderToken(activeOrder, challengeToken, "challengeTokenHash", "INVALID_CHALLENGE_TOKEN")

      await transitionOrConflict(ctx, activeOrder, ACTIVE_APPROVAL_STATUSES, {
        status: "rejected",
        rejectedAt: new Date(),
      })

      return {
        ok: true,
        orderId: publicOrderId(activeOrder),
        status: "rejected",
      }
    },

    async cancel(ctx, orderId, desktopToken) {
      const activeOrder = await loadActiveOrder(ctx, orderId)
      assertCanCancel(activeOrder)
      assertOrderToken(activeOrder, desktopToken, "desktopTokenHash", "INVALID_DESKTOP_TOKEN")

      await transitionOrConflict(ctx, activeOrder, CANCELLABLE_STATUSES, {
        status: "cancelled",
        cancelledAt: new Date(),
      })

      return {
        ok: true,
        orderId: publicOrderId(activeOrder),
        status: "cancelled",
      }
    },

    async finalize(ctx, orderId, desktopToken) {
      const activeOrder = await loadActiveOrder(ctx, orderId)
      assertOrderToken(activeOrder, desktopToken, "desktopTokenHash", "INVALID_DESKTOP_TOKEN")
      if (activeOrder.status === "finalizing")
        throw crossDeviceApiError("CONFLICT", CROSS_DEVICE_ERROR_CODES.FINALIZE_ALREADY_USED)

      assertCanFinalize(activeOrder)

      if (activeOrder.status === "finalized") {
        if (activeOrder.kind === "login")
          throw crossDeviceApiError("CONFLICT", CROSS_DEVICE_ERROR_CODES.FINALIZE_ALREADY_USED)

        return buildNonLoginFinalizeResponse(activeOrder)
      }

      if (activeOrder.kind === "login") return finalizeLogin(ctx, activeOrder)

      await markFinalized(ctx, activeOrder)
      return buildNonLoginFinalizeResponse(activeOrder)
    },

    async getNextEvent(ctx, orderId, eventToken, lastStatus) {
      const order = await storage.findByPublicId(ctx, orderId)
      if (!order) throw crossDeviceApiError("NOT_FOUND", CROSS_DEVICE_ERROR_CODES.ORDER_NOT_FOUND)

      assertOrderToken(order, eventToken, "eventTokenHash", "INVALID_EVENT_TOKEN")
      const activeOrder = await storage.ensureActive(ctx, order)
      if (activeOrder.status === lastStatus) return null

      return buildEventPayload(activeOrder)
    },
  }
}
