import { describe, expect, it } from "vitest"
import { approveOrder, createContext, createLifecycle, createStore } from "./helpers"

describe("cross-device order lifecycle", () => {
  it("owns login finalization and returns session data for the route adapter", async () => {
    const store = createStore()
    const ctx = createContext(store)
    const lifecycle = createLifecycle({
      kind: "login",
      resolveLogin: async ({ approvedSubject }) =>
        store.internalAdapter.createUser({
          email: `${approvedSubject}@example.invalid`,
          name: "",
          image: null,
        }),
    })
    const { started } = await approveOrder(lifecycle, ctx, { kind: "login" })

    const finalized = await lifecycle.finalize(ctx, started.orderId, started.desktopToken)

    expect(finalized.response).toMatchObject({
      ok: true,
      orderId: started.orderId,
      status: "finalized",
      kind: "login",
      redirectTo: "/done",
      token: "session-user-1",
    })
    expect(finalized.session?.session.token).toBe("session-user-1")
    await expect(lifecycle.finalize(ctx, started.orderId, started.desktopToken)).rejects.toThrow(
      "Cross-device login finalization was already used",
    )
    expect(store.internalAdapter.createSession).toHaveBeenCalledTimes(1)
  })

  it("finalizes non-login orders with the verified proof artifact", async () => {
    const store = createStore()
    const ctx = createContext(store)
    const lifecycle = createLifecycle({ kind: "transaction" })
    const { started } = await approveOrder(lifecycle, ctx, {
      kind: "transaction",
      proof: (challenge) => ({
        address: "NQ07TEST",
        publicKeyHex: "pk-3",
        signature: `sig:${challenge.message}`,
        txHash: "0xabc",
      }),
    })

    const finalized = await lifecycle.finalize(ctx, started.orderId, started.desktopToken)

    expect(finalized.response).toMatchObject({
      ok: true,
      status: "finalized",
      kind: "transaction",
      proofArtifact: {
        address: "NQ07TEST",
        publicKeyHex: "pk-3",
        txHash: "0xabc",
      },
    })
    expect(finalized.session).toBeUndefined()
  })

  it("does not expire approved orders before desktop finalization", async () => {
    const store = createStore()
    const ctx = createContext(store)
    const lifecycle = createLifecycle({ kind: "sign" })
    const { started } = await approveOrder(lifecycle, ctx, { kind: "sign" })
    const order = store.orders.get(started.orderId)
    if (!order) throw new Error("Missing started order")
    order.expiresAt = new Date(Date.now() - 1_000)

    const finalized = await lifecycle.finalize(ctx, started.orderId, started.desktopToken)

    expect(finalized.response).toMatchObject({
      ok: true,
      status: "finalized",
      kind: "sign",
    })
  })

  it("allows only one concurrent login finalization to create a session", async () => {
    const store = createStore()
    const ctx = createContext(store)
    let releaseSession!: () => void
    let sessionStarted!: () => void
    const sessionStartedPromise = new Promise<void>((resolve) => {
      sessionStarted = resolve
    })
    store.internalAdapter.createSession.mockImplementation(async (userId: string) => {
      sessionStarted()
      await new Promise<void>((resolve) => {
        releaseSession = resolve
      })
      const now = new Date()
      return {
        id: `session-${userId}`,
        token: `session-${userId}`,
        userId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      }
    })
    const lifecycle = createLifecycle({
      kind: "login",
      resolveLogin: async ({ approvedSubject }) =>
        store.internalAdapter.createUser({
          email: `${approvedSubject}@example.invalid`,
        }),
    })
    const { started } = await approveOrder(lifecycle, ctx, { kind: "login" })

    const firstFinalize = lifecycle.finalize(ctx, started.orderId, started.desktopToken)
    await sessionStartedPromise
    await expect(lifecycle.finalize(ctx, started.orderId, started.desktopToken)).rejects.toThrow(
      "Cross-device login finalization was already used",
    )
    releaseSession()
    await expect(firstFinalize).resolves.toMatchObject({
      response: { status: "finalized", token: "session-user-1" },
    })
    expect(store.internalAdapter.createSession).toHaveBeenCalledTimes(1)
  })

  it("rolls a failed login finalization lock back to approved", async () => {
    const store = createStore()
    const ctx = createContext(store)
    store.internalAdapter.createSession.mockResolvedValue(null)
    const lifecycle = createLifecycle({
      kind: "login",
      resolveLogin: async ({ approvedSubject }) =>
        store.internalAdapter.createUser({
          email: `${approvedSubject}@example.invalid`,
        }),
    })
    const { started } = await approveOrder(lifecycle, ctx, { kind: "login" })

    await expect(lifecycle.finalize(ctx, started.orderId, started.desktopToken)).rejects.toThrow(
      "Failed to create session",
    )
    expect(store.orders.get(started.orderId)?.status).toBe("approved")
  })

  it("owns cancellation and event payload decisions", async () => {
    const store = createStore()
    const ctx = createContext(store)
    const lifecycle = createLifecycle()
    const started = await lifecycle.start(ctx, {
      kind: "sign",
      origin: "https://app.example",
    })

    await lifecycle.claim(ctx, started.orderId, started.claimToken)
    await lifecycle.cancel(ctx, started.orderId, started.desktopToken)

    const event = await lifecycle.getNextEvent(ctx, started.orderId, started.eventToken)
    const repeated = await lifecycle.getNextEvent(
      ctx,
      started.orderId,
      started.eventToken,
      "cancelled",
    )

    expect(event).toMatchObject({
      event: "cancelled",
      payload: {
        orderId: started.orderId,
        status: "cancelled",
        kind: "sign",
      },
      terminal: true,
    })
    expect(repeated).toBeNull()
    await expect(
      lifecycle.getNextEvent(ctx, started.orderId, started.desktopToken),
    ).rejects.toThrow("Invalid event token")
  })

  it("allows only one competing terminal phone transition", async () => {
    const store = createStore()
    const ctx = createContext(store)
    const lifecycle = createLifecycle({ kind: "sign" })
    const started = await lifecycle.start(ctx, {
      kind: "sign",
      origin: "https://app.example",
      payloadHash: "payload-1",
    })
    const claimed = await lifecycle.claim(ctx, started.orderId, started.claimToken)
    const challenge = await lifecycle.getChallenge(ctx, started.orderId, claimed.challengeToken)

    const results = await Promise.allSettled([
      lifecycle.approve(ctx, {
        orderId: started.orderId,
        challengeToken: claimed.challengeToken,
        origin: "https://app.example",
        enforceOrigin: true,
        proof: { subject: "pk-1", signature: `sig:${challenge.message}` },
      }),
      lifecycle.reject(ctx, started.orderId, claimed.challengeToken),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })

  it("applies expiry consistently through lifecycle methods", async () => {
    const store = createStore()
    const ctx = createContext(store)
    const lifecycle = createLifecycle()
    const started = await lifecycle.start(ctx, {
      kind: "sign",
      origin: "https://app.example",
    })
    const claimed = await lifecycle.claim(ctx, started.orderId, started.claimToken)
    const order = store.orders.get(started.orderId)
    if (!order) throw new Error("Missing started order")
    order.expiresAt = new Date(Date.now() - 1_000)

    await expect(
      lifecycle.getChallenge(ctx, started.orderId, claimed.challengeToken),
    ).rejects.toThrow("Order expired")
    await expect(
      lifecycle.approve(ctx, {
        orderId: started.orderId,
        challengeToken: claimed.challengeToken,
        origin: "https://app.example",
        enforceOrigin: true,
        proof: {},
      }),
    ).rejects.toThrow("Order expired")
    await expect(lifecycle.reject(ctx, started.orderId, claimed.challengeToken)).rejects.toThrow(
      "Order expired",
    )
    await expect(lifecycle.cancel(ctx, started.orderId, started.desktopToken)).rejects.toThrow(
      "Order expired",
    )
    await expect(lifecycle.finalize(ctx, started.orderId, started.desktopToken)).rejects.toThrow(
      "Order expired",
    )
  })
})
