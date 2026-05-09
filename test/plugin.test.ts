import { describe, expect, it, vi } from "vitest"
import { crossDeviceClient } from "../src/client"
import { CROSS_DEVICE_ERROR_CODES, crossDevice } from "../src/index"
import * as serverExports from "../src/index"
import {
  claimAndChallenge,
  createContext,
  createStore,
  createTestPlugin,
  runApprove,
  runCancel,
  runChallenge,
  runClaim,
  runFinalize,
  runReject,
  runStart,
  signedVerifyProof,
  testEndpoints,
} from "./helpers"

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
          verifyProof: () => ({ ok: true as const, subject: "pk-shape" }),
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
    const plugin = createTestPlugin()
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
          body: { kind: "login" },
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
          body: { kind: "login" },
        }),
      ),
    ).rejects.toMatchObject({ message: CROSS_DEVICE_ERROR_CODES.UNTRUSTED_ORIGIN.message })
    expect(globallyTrusted).toHaveBeenCalledWith("https://other.example")
  })

  it("starts, approves, and finalizes a login order", async () => {
    const store = createStore()
    const plugin = createTestPlugin({
      verifyProof: signedVerifyProof(),
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

    const start = await runStart(plugin, store, {
      kind: "login",
      returnTo: "/admin",
      displayTitle: "Admin Login",
      displaySummary: "Approve Dino admin login",
    })

    expect(start.status).toBe("created")
    expect(start.claimUrl).toContain(start.orderId)

    const { claimed, challenge } = await claimAndChallenge(plugin, store, start)
    expect(challenge.status).toBe("waiting_user")

    const approved = await runApprove(plugin, store, {
      orderId: start.orderId,
      challengeToken: claimed.challengeToken,
      proof: { subject: "pk-1", signature: `sig:${challenge.message}` },
    })
    expect(approved.status).toBe("approved")

    const finalizeBody = { orderId: start.orderId, desktopToken: start.desktopToken }
    const finalized = await runFinalize(plugin, store, finalizeBody)
    expect(finalized).toMatchObject({
      ok: true,
      status: "finalized",
      kind: "login",
      redirectTo: "/admin",
    })
    expect(store.internalAdapter.createSession).toHaveBeenCalledTimes(1)

    await expect(runFinalize(plugin, store, finalizeBody)).rejects.toThrow(
      "Cross-device login finalization was already used",
    )
    expect(store.internalAdapter.createSession).toHaveBeenCalledTimes(1)
  })

  it("reuses the active challenge token across repeated claims", async () => {
    const store = createStore()
    const plugin = createTestPlugin({
      verifyProof: signedVerifyProof(),
      resolveLogin: async ({ approvedSubject }) => {
        const user = await store.internalAdapter.createUser({
          email: `${approvedSubject}@example.invalid`,
          name: "",
          image: null,
        })
        return { ...user, role: "admin" }
      },
    })

    const start = await runStart(plugin, store, {
      kind: "login",
      returnTo: "/admin",
      displayTitle: "Admin Login",
      displaySummary: "Approve Dino admin login",
    })

    const claimBody = { orderId: start.orderId, claimToken: start.claimToken }
    const firstClaim = await runClaim(plugin, store, claimBody)
    const secondClaim = await runClaim(plugin, store, claimBody)
    expect(secondClaim.challengeToken).toBe(firstClaim.challengeToken)

    const challenge = await runChallenge(plugin, store, {
      orderId: start.orderId,
      challengeToken: firstClaim.challengeToken,
    })
    expect(challenge.status).toBe("waiting_user")

    const thirdClaim = await runClaim(plugin, store, claimBody)
    expect(thirdClaim.challengeToken).toBe(firstClaim.challengeToken)

    await runApprove(plugin, store, {
      orderId: start.orderId,
      challengeToken: firstClaim.challengeToken,
      proof: { subject: "pk-repeat", signature: `sig:${challenge.message}` },
    })

    const fourthClaim = await runClaim(plugin, store, claimBody)
    expect(fourthClaim.challengeToken).toBe(firstClaim.challengeToken)
  })

  it("finalizes a sign order with the verified proof artifact", async () => {
    const store = createStore()
    const plugin = createTestPlugin({
      verifyProof: signedVerifyProof((record) => ({
        signature: record.signature,
        subject: record.subject,
      })),
    })

    const start = await runStart(plugin, store, {
      kind: "sign",
      returnTo: "/worker/job/1",
      displayTitle: "Approve Apply",
      displaySummary: "Approve this application",
      payloadHash: "payload-1",
    })

    const { claimed, challenge } = await claimAndChallenge(plugin, store, start)
    expect(challenge.kind).toBe("sign")
    expect(challenge.payloadHash).toBe("payload-1")

    await runApprove(plugin, store, {
      orderId: start.orderId,
      challengeToken: claimed.challengeToken,
      proof: { subject: "pk-2", signature: `sig:${challenge.message}` },
    })

    const finalized = await runFinalize(plugin, store, {
      orderId: start.orderId,
      desktopToken: start.desktopToken,
    })
    expect(finalized).toMatchObject({
      ok: true,
      status: "finalized",
      kind: "sign",
      redirectTo: "/worker/job/1",
      proofArtifact: { signature: `sig:${challenge.message}`, subject: "pk-2" },
    })
    expect(store.internalAdapter.createSession).not.toHaveBeenCalled()
  })

  it("finalizes a transaction order with the approved transaction artifact", async () => {
    const store = createStore()
    const plugin = createTestPlugin({
      verifyProof: ({ challenge, proof }) => {
        const record = proof as Record<string, string>
        if (record.signature !== `sig:${challenge.message}`) throw new Error("bad proof")
        return {
          ok: true as const,
          subject: record.publicKeyHex,
          identity: { address: record.address, publicKeyHex: record.publicKeyHex },
          proofArtifact: {
            address: record.address,
            publicKeyHex: record.publicKeyHex,
            providerResultRaw: record.providerResultRaw,
            txHash: record.txHash,
          },
        }
      },
    })

    const start = await runStart(plugin, store, {
      kind: "transaction",
      returnTo: "/sponsor",
      displayTitle: "Release payout",
      displaySummary: "Approve this payout transaction",
      payloadHash: "payload-tx-1",
    })

    const { claimed, challenge } = await claimAndChallenge(plugin, store, start)
    expect(challenge.kind).toBe("transaction")
    expect(challenge.payloadHash).toBe("payload-tx-1")

    await runApprove(plugin, store, {
      orderId: start.orderId,
      challengeToken: claimed.challengeToken,
      proof: {
        address: "NQ07TEST",
        publicKeyHex: "pk-3",
        providerResultRaw: "0xabc",
        signature: `sig:${challenge.message}`,
        txHash: "0xabc",
      },
    })

    const finalized = await runFinalize(plugin, store, {
      orderId: start.orderId,
      desktopToken: start.desktopToken,
    })
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
    const plugin = createTestPlugin({ subject: "pk-cancelled" })

    const start = await runStart(plugin, store, { kind: "sign", returnTo: "/worker/job/2" })
    const claimed = await runClaim(plugin, store, {
      orderId: start.orderId,
      claimToken: start.claimToken,
    })

    const cancelled = await runCancel(plugin, store, {
      orderId: start.orderId,
      desktopToken: start.desktopToken,
    })
    expect(cancelled).toEqual({ ok: true, orderId: start.orderId, status: "cancelled" })

    await expect(
      runApprove(plugin, store, {
        orderId: start.orderId,
        challengeToken: claimed.challengeToken,
        proof: {},
      }),
    ).rejects.toMatchObject({ message: "Order is not ready to approve" })
  })

  it("applies expiry consistently after a phone has claimed an order", async () => {
    const store = createStore()
    const plugin = createTestPlugin({ subject: "pk-expired" })

    const start = await runStart(plugin, store, { kind: "sign", returnTo: "/worker/job/3" })
    const claimed = await runClaim(plugin, store, {
      orderId: start.orderId,
      claimToken: start.claimToken,
    })
    const order = store.orders.get(start.orderId)
    if (!order) throw new Error("Missing started order")
    order.expiresAt = new Date(Date.now() - 1_000)

    const orderRef = { orderId: start.orderId, challengeToken: claimed.challengeToken }
    const desktopRef = { orderId: start.orderId, desktopToken: start.desktopToken }
    const expired = { message: "Order expired" }

    await expect(runChallenge(plugin, store, orderRef)).rejects.toMatchObject(expired)
    await expect(runApprove(plugin, store, { ...orderRef, proof: {} })).rejects.toMatchObject(
      expired,
    )
    await expect(runReject(plugin, store, orderRef)).rejects.toMatchObject(expired)
    await expect(runCancel(plugin, store, desktopRef)).rejects.toMatchObject(expired)
    await expect(runFinalize(plugin, store, desktopRef)).rejects.toMatchObject(expired)
  })

  it("emits the persisted terminal status through events", async () => {
    const store = createStore()
    const plugin = createTestPlugin({ subject: "pk-events" })

    const start = await runStart(plugin, store, { kind: "sign" })
    await runCancel(plugin, store, {
      orderId: start.orderId,
      desktopToken: start.desktopToken,
    })

    const eventsCtx = (overrides: Record<string, unknown>) =>
      createContext(store, {
        request: {
          url: "https://app.example/api/auth/cross-device/events",
          signal: new AbortController().signal,
        },
        ...overrides,
      })

    const response = (await testEndpoints(plugin).crossDeviceEvents(
      eventsCtx({ query: { orderId: start.orderId, eventToken: start.eventToken } }),
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
        eventsCtx({ query: { orderId: start.orderId, eventToken: start.desktopToken } }),
      ),
    ).rejects.toThrow("Invalid event token")
    await expect(
      testEndpoints(plugin).crossDeviceEvents(
        eventsCtx({ query: { orderId: "missing-order", eventToken: start.eventToken } }),
      ),
    ).rejects.toThrow("Order not found")
  })
})
