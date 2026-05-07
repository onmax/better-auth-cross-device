import { describe, expect, it } from "vitest"
import { createCrossDeviceOrderStorage } from "../src/internal/order/storage"
import { createContext, createStore } from "./helpers"

function orderRecord(publicId: string) {
  const now = new Date()
  return {
    publicId,
    action: "order.approve",
    challengeId: publicId,
    kind: "sign" as const,
    adapterId: "nimiq",
    origin: "https://app.example",
    nonce: "nonce",
    issuedAt: now,
    message: "message",
    returnTo: "/",
    status: "created" as const,
    displayTitle: "Title",
    displaySummary: "Summary",
    detailsJson: null,
    payloadHash: null,
    claimTokenHash: "claim",
    desktopTokenHash: "desktop",
    eventTokenHash: "event",
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
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: now,
    updatedAt: now,
  }
}

describe("cross-device order storage", () => {
  it("hides Better Auth adapter lookup and update details behind order-shaped calls", async () => {
    const store = createStore()
    const ctx = createContext(store)
    const storage = createCrossDeviceOrderStorage("crossDeviceOrder")

    const created = await storage.create(ctx, orderRecord("order-public"))
    const found = await storage.findByPublicId(ctx, "order-public")
    const updated = await storage.update(ctx, created.id, { status: "claimed" })

    expect(found?.publicId).toBe("order-public")
    expect(updated?.status).toBe("claimed")
    expect(store.adapter.findOne).toHaveBeenCalledWith({
      model: "crossDeviceOrder",
      where: [{ field: "publicId", value: "order-public" }],
    })
    expect(store.adapter.update).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "crossDeviceOrder",
        where: [{ field: "id", value: created.id }],
      }),
    )
  })

  it("persists expiry through the configured model name", async () => {
    const store = createStore()
    const ctx = createContext(store)
    const storage = createCrossDeviceOrderStorage("customOrder")
    const created = await storage.create(ctx, {
      ...orderRecord("custom-public"),
      expiresAt: new Date(Date.now() - 1_000),
    })

    const active = await storage.ensureActive(ctx, created)

    expect(active.status).toBe("expired")
    expect(store.adapter.update).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "customOrder",
        where: [
          { field: "id", value: created.id },
          { field: "status", value: "created" },
        ],
      }),
    )
  })
})
