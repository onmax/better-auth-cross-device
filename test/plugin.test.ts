import { describe, expect, it, vi } from "vitest"
import { crossDeviceClient } from "../src/client"
import type {
  CrossDeviceApproveResponse,
  CrossDeviceCancelResponse,
  CrossDeviceChallengeResponse,
  CrossDeviceClaimResponse,
  CrossDeviceFinalizeResponse,
  CrossDeviceRejectResponse,
  CrossDeviceStartResponse,
} from "../src/index"
import { CROSS_DEVICE_ERROR_CODES, crossDevice } from "../src/index"
import * as serverExports from "../src/index"
import { createContext, createStore } from "./helpers"

type TestEndpoint<T> = (ctx: ReturnType<typeof createContext>) => T | Promise<T>

interface TestCrossDeviceEndpoints {
  crossDeviceApprove: TestEndpoint<CrossDeviceApproveResponse>
  crossDeviceCancel: TestEndpoint<CrossDeviceCancelResponse>
  crossDeviceChallenge: TestEndpoint<CrossDeviceChallengeResponse>
  crossDeviceClaim: TestEndpoint<CrossDeviceClaimResponse>
  crossDeviceEvents: TestEndpoint<Response>
  crossDeviceFinalize: TestEndpoint<CrossDeviceFinalizeResponse>
  crossDeviceReject: TestEndpoint<CrossDeviceRejectResponse>
  crossDeviceStart: TestEndpoint<CrossDeviceStartResponse & { desktopToken: string }>
}

function testEndpoints(plugin: ReturnType<typeof crossDevice>): TestCrossDeviceEndpoints {
  return {
    crossDeviceApprove: testEndpoint(plugin.endpoints.crossDeviceApprove),
    crossDeviceCancel: testEndpoint(plugin.endpoints.crossDeviceCancel),
    crossDeviceChallenge: testEndpoint(plugin.endpoints.crossDeviceChallenge),
    crossDeviceClaim: testEndpoint(plugin.endpoints.crossDeviceClaim),
    crossDeviceEvents: testEndpoint(plugin.endpoints.crossDeviceEvents),
    crossDeviceFinalize: testEndpoint(plugin.endpoints.crossDeviceFinalize),
    crossDeviceReject: testEndpoint(plugin.endpoints.crossDeviceReject),
    crossDeviceStart: testEndpoint(plugin.endpoints.crossDeviceStart),
  }
}

function testEndpoint<T>(handler: (ctx: never) => T | Promise<T>): TestEndpoint<T> {
  return (ctx) => handler(ctx as never)
}

vi.mock("better-auth/api", () => ({
  createAuthEndpoint: (_path: string, _options: unknown, handler: unknown) => handler,
}))

vi.mock("better-auth/cookies", () => ({
  setSessionCookie: vi.fn(async () => {}),
}))

describe("crossDevice", () => {
  it("exposes the Better Auth-style server plugin shape", () => {
    const plugin = crossDevice({
      appName: "Dino",
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: () => ({
            ok: true as const,
            subject: "pk-shape",
          }),
        },
      ],
    })

    expect(plugin.id).toBe("cross-device")
    expect(plugin.options.appName).toBe("Dino")
    expect(plugin.$ERROR_CODES).toBe(CROSS_DEVICE_ERROR_CODES)
    expect(plugin.schema).toHaveProperty("crossDeviceOrder")
    expect(plugin.schema.crossDeviceOrder.fields.publicId.unique).toBe(true)
    expect(plugin.endpoints).toEqual(
      expect.objectContaining({
        crossDeviceApprove: expect.any(Function),
        crossDeviceCancel: expect.any(Function),
        crossDeviceChallenge: expect.any(Function),
        crossDeviceClaim: expect.any(Function),
        crossDeviceEvents: expect.any(Function),
        crossDeviceFinalize: expect.any(Function),
        crossDeviceReject: expect.any(Function),
        crossDeviceStart: expect.any(Function),
      }),
    )
    expect("normalizeEndpointPrefix" in serverExports).toBe(false)
  })

  it("exposes the Better Auth-style client plugin shape and existing actions", () => {
    const client = crossDeviceClient()
    const actions = client.getActions(vi.fn())

    expect(client.id).toBe("cross-device")
    expect(client.$InferServerPlugin).toEqual({})
    expect(client.pathMethods).toMatchObject({
      "/cross-device/approve": "POST",
      "/cross-device/cancel": "POST",
      "/cross-device/challenge": "POST",
      "/cross-device/claim": "POST",
      "/cross-device/events": "GET",
      "/cross-device/finalize": "POST",
      "/cross-device/reject": "POST",
      "/cross-device/start": "POST",
    })
    expect(actions).toEqual(
      expect.objectContaining({
        approveCrossDeviceOrder: expect.any(Function),
        finalizeCrossDeviceOrder: expect.any(Function),
        startCrossDeviceOrder: expect.any(Function),
      }),
    )
  })

  it("requires Better Auth and plugin trusted origins for order starts", async () => {
    const store = createStore()
    const plugin = crossDevice({
      appName: "Dino",
      trustedOrigins: ["https://app.example"],
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: () => ({
            ok: true as const,
            subject: "pk-shape",
          }),
        },
      ],
    })
    const isTrustedOrigin = vi.fn(() => false)

    await expect(
      testEndpoints(plugin).crossDeviceStart(
        createContext(store, {
          context: {
            adapter: store.adapter,
            internalAdapter: store.internalAdapter,
            baseURL: "https://app.example",
            isTrustedOrigin,
          },
          body: {
            kind: "login",
          },
        }),
      ),
    ).rejects.toMatchObject({ message: CROSS_DEVICE_ERROR_CODES.UNTRUSTED_ORIGIN.message })
    expect(isTrustedOrigin).toHaveBeenCalledWith("https://app.example")

    const globallyTrusted = vi.fn(() => true)
    await expect(
      testEndpoints(plugin).crossDeviceStart(
        createContext(store, {
          context: {
            adapter: store.adapter,
            internalAdapter: store.internalAdapter,
            baseURL: "https://other.example",
            isTrustedOrigin: globallyTrusted,
          },
          request: { url: "https://other.example/api/auth/cross-device/start" },
          body: {
            kind: "login",
          },
        }),
      ),
    ).rejects.toMatchObject({ message: CROSS_DEVICE_ERROR_CODES.UNTRUSTED_ORIGIN.message })
    expect(globallyTrusted).toHaveBeenCalledWith("https://other.example")
  })

  it("starts, approves, and finalizes a login order", async () => {
    const store = createStore()
    const plugin = crossDevice({
      appName: "Dino",
      trustedOrigins: ["https://app.example"],
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: ({ challenge, proof }) => {
            const record = proof as Record<string, string>
            if (record.signature !== `sig:${challenge.message}`) throw new Error("bad proof")

            return {
              ok: true as const,
              subject: record.subject,
              identity: { address: "NQ07TEST" },
              proofArtifact: record,
            }
          },
        },
      ],
      resolveLogin: async ({ approvedSubject, approvedIdentity }) => {
        const user = await store.internalAdapter.createUser({
          email: `${approvedSubject}@example.invalid`,
          name: "",
          image: null,
          address: approvedIdentity?.address,
        })
        return { ...user, role: "admin" }
      },
    })

    const start = await testEndpoints(plugin).crossDeviceStart(
      createContext(store, {
        body: {
          kind: "login",
          returnTo: "/admin",
          displayTitle: "Admin Login",
          displaySummary: "Approve Dino admin login",
        },
      }),
    )

    expect(start.status).toBe("created")
    expect(start.claimUrl).toContain(start.orderId)

    const claimed = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )

    const challenge = await testEndpoints(plugin).crossDeviceChallenge(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/challenge" },
        body: {
          orderId: start.orderId,
          challengeToken: claimed.challengeToken,
        },
      }),
    )

    expect(challenge.status).toBe("waiting_user")

    const approved = await testEndpoints(plugin).crossDeviceApprove(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/approve" },
        body: {
          orderId: start.orderId,
          challengeToken: claimed.challengeToken,
          proof: {
            subject: "pk-1",
            signature: `sig:${challenge.message}`,
          },
        },
      }),
    )

    expect(approved.status).toBe("approved")

    const finalized = await testEndpoints(plugin).crossDeviceFinalize(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/finalize" },
        body: {
          orderId: start.orderId,
          desktopToken: start.desktopToken,
        },
      }),
    )

    expect(finalized).toMatchObject({
      ok: true,
      status: "finalized",
      kind: "login",
      redirectTo: "/admin",
    })
    expect(store.internalAdapter.createSession).toHaveBeenCalledTimes(1)

    await expect(
      testEndpoints(plugin).crossDeviceFinalize(
        createContext(store, {
          request: { url: "https://app.example/api/auth/cross-device/finalize" },
          body: {
            orderId: start.orderId,
            desktopToken: start.desktopToken,
          },
        }),
      ),
    ).rejects.toThrow("Cross-device login finalization was already used")
    expect(store.internalAdapter.createSession).toHaveBeenCalledTimes(1)
  })

  it("reuses the active challenge token across repeated claims", async () => {
    const store = createStore()
    const plugin = crossDevice({
      appName: "Dino",
      trustedOrigins: ["https://app.example"],
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: ({ challenge, proof }) => {
            const record = proof as Record<string, string>
            if (record.signature !== `sig:${challenge.message}`) throw new Error("bad proof")

            return {
              ok: true as const,
              subject: record.subject,
              identity: { address: "NQ07TEST" },
              proofArtifact: record,
            }
          },
        },
      ],
      resolveLogin: async ({ approvedSubject }) => {
        const user = await store.internalAdapter.createUser({
          email: `${approvedSubject}@example.invalid`,
          name: "",
          image: null,
        })
        return { ...user, role: "admin" }
      },
    })

    const start = await testEndpoints(plugin).crossDeviceStart(
      createContext(store, {
        body: {
          kind: "login",
          returnTo: "/admin",
          displayTitle: "Admin Login",
          displaySummary: "Approve Dino admin login",
        },
      }),
    )

    const firstClaim = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )

    const secondClaim = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )

    expect(secondClaim.challengeToken).toBe(firstClaim.challengeToken)

    const challenge = await testEndpoints(plugin).crossDeviceChallenge(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/challenge" },
        body: {
          orderId: start.orderId,
          challengeToken: firstClaim.challengeToken,
        },
      }),
    )

    expect(challenge.status).toBe("waiting_user")

    const thirdClaim = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )

    expect(thirdClaim.challengeToken).toBe(firstClaim.challengeToken)

    await testEndpoints(plugin).crossDeviceApprove(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/approve" },
        body: {
          orderId: start.orderId,
          challengeToken: firstClaim.challengeToken,
          proof: {
            subject: "pk-repeat",
            signature: `sig:${challenge.message}`,
          },
        },
      }),
    )

    const fourthClaim = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )

    expect(fourthClaim.challengeToken).toBe(firstClaim.challengeToken)
  })

  it("finalizes a sign order with the verified proof artifact", async () => {
    const store = createStore()
    const plugin = crossDevice({
      appName: "Dino",
      trustedOrigins: ["https://app.example"],
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: ({ challenge, proof }) => {
            const record = proof as Record<string, string>
            if (record.signature !== `sig:${challenge.message}`) throw new Error("bad proof")

            return {
              ok: true as const,
              subject: record.subject,
              identity: { address: "NQ07TEST" },
              proofArtifact: {
                signature: record.signature,
                subject: record.subject,
              },
            }
          },
        },
      ],
    })

    const start = await testEndpoints(plugin).crossDeviceStart(
      createContext(store, {
        body: {
          kind: "sign",
          returnTo: "/worker/job/1",
          displayTitle: "Approve Apply",
          displaySummary: "Approve this application",
          payloadHash: "payload-1",
        },
      }),
    )

    const claimed = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )

    const challenge = await testEndpoints(plugin).crossDeviceChallenge(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/challenge" },
        body: {
          orderId: start.orderId,
          challengeToken: claimed.challengeToken,
        },
      }),
    )

    expect(challenge.kind).toBe("sign")
    expect(challenge.payloadHash).toBe("payload-1")

    await testEndpoints(plugin).crossDeviceApprove(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/approve" },
        body: {
          orderId: start.orderId,
          challengeToken: claimed.challengeToken,
          proof: {
            subject: "pk-2",
            signature: `sig:${challenge.message}`,
          },
        },
      }),
    )

    const finalized = await testEndpoints(plugin).crossDeviceFinalize(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/finalize" },
        body: {
          orderId: start.orderId,
          desktopToken: start.desktopToken,
        },
      }),
    )

    expect(finalized).toMatchObject({
      ok: true,
      status: "finalized",
      kind: "sign",
      redirectTo: "/worker/job/1",
      proofArtifact: {
        signature: `sig:${challenge.message}`,
        subject: "pk-2",
      },
    })
    expect(store.internalAdapter.createSession).not.toHaveBeenCalled()
  })

  it("finalizes a transaction order with the approved transaction artifact", async () => {
    const store = createStore()
    const plugin = crossDevice({
      appName: "Dino",
      trustedOrigins: ["https://app.example"],
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: ({ challenge, proof }) => {
            const record = proof as Record<string, string>
            if (record.signature !== `sig:${challenge.message}`) throw new Error("bad proof")

            return {
              ok: true as const,
              subject: record.publicKeyHex,
              identity: {
                address: record.address,
                publicKeyHex: record.publicKeyHex,
              },
              proofArtifact: {
                address: record.address,
                publicKeyHex: record.publicKeyHex,
                providerResultRaw: record.providerResultRaw,
                txHash: record.txHash,
              },
            }
          },
        },
      ],
    })

    const start = await testEndpoints(plugin).crossDeviceStart(
      createContext(store, {
        body: {
          kind: "transaction",
          returnTo: "/sponsor",
          displayTitle: "Release payout",
          displaySummary: "Approve this payout transaction",
          payloadHash: "payload-tx-1",
        },
      }),
    )

    const claimed = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )

    const challenge = await testEndpoints(plugin).crossDeviceChallenge(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/challenge" },
        body: {
          orderId: start.orderId,
          challengeToken: claimed.challengeToken,
        },
      }),
    )

    expect(challenge.kind).toBe("transaction")
    expect(challenge.payloadHash).toBe("payload-tx-1")

    await testEndpoints(plugin).crossDeviceApprove(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/approve" },
        body: {
          orderId: start.orderId,
          challengeToken: claimed.challengeToken,
          proof: {
            address: "NQ07TEST",
            publicKeyHex: "pk-3",
            providerResultRaw: "0xabc",
            signature: `sig:${challenge.message}`,
            txHash: "0xabc",
          },
        },
      }),
    )

    const finalized = await testEndpoints(plugin).crossDeviceFinalize(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/finalize" },
        body: {
          orderId: start.orderId,
          desktopToken: start.desktopToken,
        },
      }),
    )

    expect(finalized).toMatchObject({
      ok: true,
      status: "finalized",
      kind: "transaction",
      redirectTo: "/sponsor",
      proofArtifact: {
        address: "NQ07TEST",
        publicKeyHex: "pk-3",
        providerResultRaw: "0xabc",
        txHash: "0xabc",
      },
    })
    expect(store.internalAdapter.createSession).not.toHaveBeenCalled()
  })

  it("cancels with the persisted cancelled status and blocks later approval", async () => {
    const store = createStore()
    const plugin = crossDevice({
      appName: "Dino",
      trustedOrigins: ["https://app.example"],
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: () => ({
            ok: true as const,
            subject: "pk-cancelled",
          }),
        },
      ],
    })

    const start = await testEndpoints(plugin).crossDeviceStart(
      createContext(store, {
        body: {
          kind: "sign",
          returnTo: "/worker/job/2",
        },
      }),
    )

    const claimed = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )

    const cancelled = await testEndpoints(plugin).crossDeviceCancel(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/cancel" },
        body: {
          orderId: start.orderId,
          desktopToken: start.desktopToken,
        },
      }),
    )

    expect(cancelled).toEqual({
      ok: true,
      orderId: start.orderId,
      status: "cancelled",
    })

    await expect(
      testEndpoints(plugin).crossDeviceApprove(
        createContext(store, {
          request: { url: "https://app.example/api/auth/cross-device/approve" },
          body: {
            orderId: start.orderId,
            challengeToken: claimed.challengeToken,
            proof: {},
          },
        }),
      ),
    ).rejects.toMatchObject({ message: "Order is not ready to approve" })
  })

  it("applies expiry consistently after a phone has claimed an order", async () => {
    const store = createStore()
    const plugin = crossDevice({
      appName: "Dino",
      trustedOrigins: ["https://app.example"],
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: () => ({
            ok: true as const,
            subject: "pk-expired",
          }),
        },
      ],
    })

    const start = await testEndpoints(plugin).crossDeviceStart(
      createContext(store, {
        body: {
          kind: "sign",
          returnTo: "/worker/job/3",
        },
      }),
    )
    const claimed = await testEndpoints(plugin).crossDeviceClaim(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/claim" },
        body: {
          orderId: start.orderId,
          claimToken: start.claimToken,
        },
      }),
    )
    const order = store.orders.get(start.orderId)
    if (!order) throw new Error("Missing started order")
    order.expiresAt = new Date(Date.now() - 1_000)

    await expect(
      testEndpoints(plugin).crossDeviceChallenge(
        createContext(store, {
          request: { url: "https://app.example/api/auth/cross-device/challenge" },
          body: {
            orderId: start.orderId,
            challengeToken: claimed.challengeToken,
          },
        }),
      ),
    ).rejects.toMatchObject({ message: "Order expired" })

    await expect(
      testEndpoints(plugin).crossDeviceApprove(
        createContext(store, {
          request: { url: "https://app.example/api/auth/cross-device/approve" },
          body: {
            orderId: start.orderId,
            challengeToken: claimed.challengeToken,
            proof: {},
          },
        }),
      ),
    ).rejects.toMatchObject({ message: "Order expired" })

    await expect(
      testEndpoints(plugin).crossDeviceReject(
        createContext(store, {
          request: { url: "https://app.example/api/auth/cross-device/reject" },
          body: {
            orderId: start.orderId,
            challengeToken: claimed.challengeToken,
          },
        }),
      ),
    ).rejects.toMatchObject({ message: "Order expired" })

    await expect(
      testEndpoints(plugin).crossDeviceCancel(
        createContext(store, {
          request: { url: "https://app.example/api/auth/cross-device/cancel" },
          body: {
            orderId: start.orderId,
            desktopToken: start.desktopToken,
          },
        }),
      ),
    ).rejects.toMatchObject({ message: "Order expired" })

    await expect(
      testEndpoints(plugin).crossDeviceFinalize(
        createContext(store, {
          request: { url: "https://app.example/api/auth/cross-device/finalize" },
          body: {
            orderId: start.orderId,
            desktopToken: start.desktopToken,
          },
        }),
      ),
    ).rejects.toMatchObject({ message: "Order expired" })
  })

  it("emits the persisted terminal status through events", async () => {
    const store = createStore()
    const plugin = crossDevice({
      appName: "Dino",
      trustedOrigins: ["https://app.example"],
      adapters: [
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: () => ({
            ok: true as const,
            subject: "pk-events",
          }),
        },
      ],
    })

    const start = await testEndpoints(plugin).crossDeviceStart(
      createContext(store, {
        body: {
          kind: "sign",
        },
      }),
    )

    await testEndpoints(plugin).crossDeviceCancel(
      createContext(store, {
        request: { url: "https://app.example/api/auth/cross-device/cancel" },
        body: {
          orderId: start.orderId,
          desktopToken: start.desktopToken,
        },
      }),
    )

    const response = (await testEndpoints(plugin).crossDeviceEvents(
      createContext(store, {
        request: {
          url: "https://app.example/api/auth/cross-device/events",
          signal: new AbortController().signal,
        },
        query: {
          orderId: start.orderId,
          eventToken: start.eventToken,
        },
      }),
    )) as Response
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Missing event stream")
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("x-accel-buffering")).toBe("no")

    let event = ""
    while (!event.includes("event: cancelled")) {
      const chunk = await reader.read()
      event += new TextDecoder().decode(chunk.value)
    }
    expect(event).toContain("event: cancelled")
    expect(event).toContain('"status":"cancelled"')

    await expect(
      testEndpoints(plugin).crossDeviceEvents(
        createContext(store, {
          request: {
            url: "https://app.example/api/auth/cross-device/events",
            signal: new AbortController().signal,
          },
          query: {
            orderId: start.orderId,
            eventToken: start.desktopToken,
          },
        }),
      ),
    ).rejects.toThrow("Invalid event token")
    await expect(
      testEndpoints(plugin).crossDeviceEvents(
        createContext(store, {
          request: {
            url: "https://app.example/api/auth/cross-device/events",
            signal: new AbortController().signal,
          },
          query: {
            orderId: "missing-order",
            eventToken: start.eventToken,
          },
        }),
      ),
    ).rejects.toThrow("Order not found")
  })
})
