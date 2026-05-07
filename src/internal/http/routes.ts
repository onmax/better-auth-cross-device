import type { CrossDeviceOrderLifecycle } from "../order/lifecycle"
import type { CrossDeviceRuntimeContext } from "../types"
import { createAuthEndpoint } from "better-auth/api"
import { z, type ZodType } from "zod"
import { CROSS_DEVICE_ENDPOINTS, type CrossDeviceEndpointKey } from "../endpoint-catalog"
import { applyFinalizedSession, assertTrustedOrigin, resolveOrigin } from "./context"
import { createOrderEventStream } from "./event-stream"

interface CreateCrossDeviceEndpointsOptions {
  endpointPrefix: `/${string}`
  enforceOrigin: boolean
  lifecycle: CrossDeviceOrderLifecycle
  tokenHeaderName: string
  trustedOrigins: Set<string>
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const

function jsonResponse(description: string) {
  return {
    200: {
      description,
      content: { "application/json": { schema: { type: "object" } } },
    },
  } as const
}

function toRuntimeContext(ctx: object): CrossDeviceRuntimeContext {
  return ctx as CrossDeviceRuntimeContext
}

function defineJsonEndpoint<TBody, TResponse>(
  deps: CreateCrossDeviceEndpointsOptions,
  key: Exclude<CrossDeviceEndpointKey, "events">,
  options: {
    body: ZodType<TBody>
    description: string
    responseDescription: string
    handler: (
      deps: CreateCrossDeviceEndpointsOptions,
      body: TBody,
      ctx: CrossDeviceRuntimeContext,
    ) => Promise<TResponse>
  },
) {
  const meta = CROSS_DEVICE_ENDPOINTS[key]
  return createAuthEndpoint(
    `${deps.endpointPrefix}${meta.path}`,
    {
      method: meta.method,
      body: options.body,
      metadata: {
        openapi: {
          operationId: meta.operationId,
          description: options.description,
          responses: jsonResponse(options.responseDescription),
        },
      },
    },
    async (ctx) => {
      const runtimeCtx = toRuntimeContext(ctx)
      const result = await options.handler(deps, ctx.body as TBody, runtimeCtx)
      return ctx.json(result as TResponse & Record<string, unknown>)
    },
  )
}

function defineEventsEndpoint(deps: CreateCrossDeviceEndpointsOptions) {
  const meta = CROSS_DEVICE_ENDPOINTS.events
  return createAuthEndpoint(
    `${deps.endpointPrefix}${meta.path}`,
    {
      method: meta.method,
      query: z.object({ orderId: z.string(), eventToken: z.string() }),
      metadata: {
        openapi: {
          operationId: meta.operationId,
          description: "Subscribe to cross-device order events.",
          responses: {
            200: {
              description: "Server-sent event stream for order status changes.",
              content: { "text/event-stream": { schema: { type: "string" } } } as never,
            },
          },
        },
      },
    },
    async (ctx) => {
      const runtimeCtx = toRuntimeContext(ctx)
      const { orderId, eventToken } = ctx.query!
      const stream = await createOrderEventStream({
        ctx: runtimeCtx,
        lifecycle: deps.lifecycle,
        orderId,
        eventToken,
      })
      return new Response(stream, { headers: SSE_HEADERS })
    },
  )
}

export function createCrossDeviceEndpoints(deps: CreateCrossDeviceEndpointsOptions) {
  return {
    [CROSS_DEVICE_ENDPOINTS.start.id]: defineJsonEndpoint(deps, "start", {
      body: z.object({
        adapterId: z.string().optional(),
        kind: z.enum(["login", "sign", "transaction"]),
        returnTo: z.string().optional(),
        displayTitle: z.string().optional(),
        displaySummary: z.string().optional(),
        payloadHash: z.string().optional(),
      }),
      description: "Start a cross-device order.",
      responseDescription: "Cross-device order details.",
      handler: async ({ lifecycle, trustedOrigins }, body, ctx) => {
        const origin = resolveOrigin(ctx)
        assertTrustedOrigin(ctx, origin, trustedOrigins)
        return lifecycle.start(ctx, { ...body, origin })
      },
    }),
    [CROSS_DEVICE_ENDPOINTS.claim.id]: defineJsonEndpoint(deps, "claim", {
      body: z.object({ orderId: z.string(), claimToken: z.string() }),
      description: "Claim a cross-device order from the approving device.",
      responseDescription: "Claimed order and challenge token.",
      handler: ({ lifecycle }, { orderId, claimToken }, ctx) =>
        lifecycle.claim(ctx, orderId, claimToken),
    }),
    [CROSS_DEVICE_ENDPOINTS.challenge.id]: defineJsonEndpoint(deps, "challenge", {
      body: z.object({ orderId: z.string(), challengeToken: z.string() }),
      description: "Read the challenge for a claimed cross-device order.",
      responseDescription: "Challenge envelope.",
      handler: ({ lifecycle }, { orderId, challengeToken }, ctx) =>
        lifecycle.getChallenge(ctx, orderId, challengeToken),
    }),
    [CROSS_DEVICE_ENDPOINTS.approve.id]: defineJsonEndpoint(deps, "approve", {
      body: z.object({
        orderId: z.string(),
        challengeToken: z.string(),
        proof: z.unknown(),
      }),
      description: "Approve a cross-device order with a verified proof.",
      responseDescription: "Approved order status.",
      handler: ({ lifecycle, enforceOrigin }, body, ctx) =>
        lifecycle.approve(ctx, { ...body, origin: resolveOrigin(ctx), enforceOrigin }),
    }),
    [CROSS_DEVICE_ENDPOINTS.reject.id]: defineJsonEndpoint(deps, "reject", {
      body: z.object({ orderId: z.string(), challengeToken: z.string() }),
      description: "Reject a cross-device order from the approving device.",
      responseDescription: "Rejected order status.",
      handler: ({ lifecycle }, { orderId, challengeToken }, ctx) =>
        lifecycle.reject(ctx, orderId, challengeToken),
    }),
    [CROSS_DEVICE_ENDPOINTS.cancel.id]: defineJsonEndpoint(deps, "cancel", {
      body: z.object({ orderId: z.string(), desktopToken: z.string() }),
      description: "Cancel a cross-device order from the originating device.",
      responseDescription: "Cancelled order status.",
      handler: ({ lifecycle }, { orderId, desktopToken }, ctx) =>
        lifecycle.cancel(ctx, orderId, desktopToken),
    }),
    [CROSS_DEVICE_ENDPOINTS.finalize.id]: defineJsonEndpoint(deps, "finalize", {
      body: z.object({ orderId: z.string(), desktopToken: z.string() }),
      description: "Finalize an approved cross-device order.",
      responseDescription: "Finalized order result.",
      handler: async ({ lifecycle, tokenHeaderName }, { orderId, desktopToken }, ctx) => {
        const finalized = await lifecycle.finalize(ctx, orderId, desktopToken)
        if (finalized.session) await applyFinalizedSession(ctx, finalized.session, tokenHeaderName)
        return finalized.response
      },
    }),
    [CROSS_DEVICE_ENDPOINTS.events.id]: defineEventsEndpoint(deps),
  }
}
