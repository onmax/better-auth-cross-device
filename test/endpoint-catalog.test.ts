import { describe, expect, it, vi } from "vitest"
import type { AuthClientFetcher } from "../src/client"
import {
  approveCrossDeviceOrder,
  claimCrossDeviceOrder,
  cancelCrossDeviceOrder,
  crossDeviceClient,
  finalizeCrossDeviceOrder,
  getCrossDeviceChallenge,
  rejectCrossDeviceOrder,
  startCrossDeviceOrder,
  subscribeToCrossDeviceOrder,
} from "../src/client"
import {
  createPathMethods,
  CROSS_DEVICE_ENDPOINTS,
  CROSS_DEVICE_ORDER_EVENTS,
} from "../src/internal/endpoint-catalog"
import { crossDevice } from "../src/index"

interface CapturedEndpointOptions {
  metadata: {
    openapi: {
      operationId: string
    }
  }
}

const capturedEndpoints = vi.hoisted(
  () => [] as Array<{ path: string; options: CapturedEndpointOptions }>,
)

vi.mock("better-auth/api", () => ({
  createAuthEndpoint: (path: string, options: CapturedEndpointOptions, handler: unknown) => {
    capturedEndpoints.push({ path, options })
    return handler
  },
}))

describe("cross-device endpoint catalog", () => {
  it("keeps client pathMethods derived from the endpoint catalog", () => {
    const client = crossDeviceClient()

    expect(client.pathMethods).toEqual(createPathMethods("/cross-device"))
    expect(client.pathMethods).toEqual(
      Object.fromEntries(
        Object.values(CROSS_DEVICE_ENDPOINTS).map((endpoint) => [
          `/cross-device${endpoint.path}`,
          endpoint.method,
        ]),
      ),
    )
  })

  it("keeps server route paths and operation ids derived from the endpoint catalog", () => {
    capturedEndpoints.length = 0

    const plugin = crossDevice({
      appName: "Dino",
      adapters: [
        {
          id: "test",
          createChallenge: (input) => input.orderId,
          verifyProof: () => ({ ok: true, subject: "subject" }),
        },
      ],
    })

    expect(Object.keys(plugin.endpoints)).toEqual(
      Object.values(CROSS_DEVICE_ENDPOINTS).map((endpoint) => endpoint.id),
    )
    expect(capturedEndpoints.map((endpoint) => endpoint.path)).toEqual(
      Object.values(CROSS_DEVICE_ENDPOINTS).map((endpoint) => `/cross-device${endpoint.path}`),
    )
    expect(
      capturedEndpoints.map((endpoint) => endpoint.options.metadata.openapi.operationId),
    ).toEqual(Object.values(CROSS_DEVICE_ENDPOINTS).map((endpoint) => endpoint.operationId))
  })

  it("keeps direct client helpers on catalog paths", async () => {
    const fetcherCalls: Array<{ path: string; options?: Record<string, unknown> }> = []
    const fetcher: AuthClientFetcher = async <T = unknown>(
      path: string,
      options?: Record<string, unknown>,
    ): Promise<T> => {
      fetcherCalls.push({ path, options })
      return { data: { ok: true } } as T
    }

    const started = await startCrossDeviceOrder(fetcher, { kind: "login" })
    await claimCrossDeviceOrder(fetcher, { orderId: "order", claimToken: "claim" })
    await getCrossDeviceChallenge(fetcher, { orderId: "order", challengeToken: "challenge" })
    await approveCrossDeviceOrder(fetcher, {
      orderId: "order",
      challengeToken: "challenge",
      proof: {},
    })
    await rejectCrossDeviceOrder(fetcher, { orderId: "order", challengeToken: "challenge" })
    await cancelCrossDeviceOrder(fetcher, { orderId: "order", desktopToken: "desktop" })
    await finalizeCrossDeviceOrder(fetcher, { orderId: "order", desktopToken: "desktop" })

    expect(fetcherCalls.map((call) => call.path)).toEqual([
      "/cross-device/start",
      "/cross-device/claim",
      "/cross-device/challenge",
      "/cross-device/approve",
      "/cross-device/reject",
      "/cross-device/cancel",
      "/cross-device/finalize",
    ])
    expect(started).toEqual({ data: { ok: true }, error: null })
    expect(fetcherCalls[2]?.options).toMatchObject({
      method: "POST",
      body: { orderId: "order", challengeToken: "challenge" },
    })
  })

  it("closes browser EventSource subscriptions on terminal events", () => {
    const originalWindow = globalThis.window
    const originalEventSource = globalThis.EventSource
    const listeners = new Map<string, (event: MessageEvent<string>) => void>()
    const close = vi.fn()

    globalThis.window = { location: { origin: "https://app.example" } } as Window &
      typeof globalThis
    class MockEventSource extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 2
      CONNECTING = 0
      OPEN = 1
      CLOSED = 2
      url = "https://app.example/cross-device/events"
      withCredentials = true
      readyState = 1
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onopen: ((event: Event) => void) | null = null

      override addEventListener(event: string, listener: EventListenerOrEventListenerObject): void {
        listeners.set(event, listener as (event: MessageEvent<string>) => void)
      }

      close(): void {
        close()
      }
    }
    globalThis.EventSource = MockEventSource as typeof EventSource

    try {
      subscribeToCrossDeviceOrder({
        orderId: "order",
        eventToken: "event",
        onEvent: vi.fn(),
      })
      listeners.get("approved")?.(new MessageEvent("approved", { data: "{}" }))
      expect(close).not.toHaveBeenCalled()

      listeners.get("finalized")?.(new MessageEvent("finalized", { data: "{}" }))
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.window = originalWindow
      globalThis.EventSource = originalEventSource
    }
  })

  it("defines the cross-device order event names used by SSE clients", () => {
    expect(CROSS_DEVICE_ORDER_EVENTS).toEqual([
      "claimed",
      "waiting_user",
      "approved",
      "rejected",
      "expired",
      "cancelled",
      "finalized",
    ])
  })
})
