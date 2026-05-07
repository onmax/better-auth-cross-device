import { describe, expect, it } from "vitest"
import { CROSS_DEVICE_ERROR_CODES } from "../src/internal/error-codes"
import {
  assertOrderToken,
  buildOrderChallengeEnvelope,
  buildProofVerificationInput,
  hashToken,
  issueChallengeToken,
  issueOrderSecurity,
  normalizeReturnTo,
} from "../src/internal/security"
import type { CrossDeviceAdapter, StoredOrderRecord } from "../src/internal/types"

const adapter: CrossDeviceAdapter = {
  id: "test",
  createChallenge: (input) => `message:${input.orderId}:${input.nonce}`,
  verifyProof: ({ challenge, proof }) => ({
    ok: true,
    subject: `${challenge.orderId}:${String(proof)}`,
  }),
}

function createStoredOrder(): StoredOrderRecord {
  const issued = issueOrderSecurity({
    adapter,
    appName: "Dino",
    kind: "sign",
    origin: "https://app.example",
    payloadHash: "payload-1",
    returnTo: "/sign",
    orderTtlSeconds: 120,
  })

  return {
    id: "db-1",
    publicId: issued.orderId,
    action: issued.action,
    challengeId: issued.challengeId,
    kind: "sign",
    adapterId: adapter.id,
    origin: "https://app.example",
    nonce: issued.nonce,
    issuedAt: issued.issuedAt,
    message: issued.message,
    returnTo: issued.returnTo,
    status: "waiting_user",
    displayTitle: issued.displayTitle,
    displaySummary: issued.displaySummary,
    detailsJson: issued.detailsJson,
    payloadHash: "payload-1",
    claimTokenHash: hashToken(issued.claimToken),
    desktopTokenHash: hashToken(issued.desktopToken),
    eventTokenHash: hashToken(issued.eventToken),
    challengeToken: "challenge-token",
    challengeTokenHash: hashToken("challenge-token"),
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
    createdAt: issued.issuedAt,
    updatedAt: issued.issuedAt,
  }
}

describe("cross-device security", () => {
  it("issues unique order and token material", () => {
    const first = issueOrderSecurity({
      adapter,
      appName: "Dino",
      kind: "login",
      origin: "https://app.example",
      orderTtlSeconds: 120,
    })
    const second = issueOrderSecurity({
      adapter,
      appName: "Dino",
      kind: "login",
      origin: "https://app.example",
      orderTtlSeconds: 120,
    })

    expect(first.orderId).not.toBe(second.orderId)
    expect(first.claimToken).not.toBe(second.claimToken)
    expect(first.desktopToken).not.toBe(second.desktopToken)
    expect(first.eventToken).not.toBe(second.eventToken)
    expect(first.eventToken).not.toBe(first.desktopToken)
    expect(issueChallengeToken()).not.toBe(issueChallengeToken())
  })

  it("verifies hashed tokens and rejects invalid tokens with stable messages", () => {
    const order = createStoredOrder()

    expect(() =>
      assertOrderToken(order, "challenge-token", "challengeTokenHash", "INVALID_CHALLENGE_TOKEN"),
    ).not.toThrow()
    expect(() =>
      assertOrderToken(order, "wrong", "challengeTokenHash", "INVALID_CHALLENGE_TOKEN"),
    ).toThrow(CROSS_DEVICE_ERROR_CODES.INVALID_CHALLENGE_TOKEN.message)
    expect(() => assertOrderToken(order, "wrong", "eventTokenHash", "INVALID_EVENT_TOKEN")).toThrow(
      CROSS_DEVICE_ERROR_CODES.INVALID_EVENT_TOKEN.message,
    )
    try {
      assertOrderToken(order, "wrong", "eventTokenHash", "INVALID_EVENT_TOKEN")
      throw new Error("Expected invalid event token")
    } catch (error) {
      expect(error).toMatchObject({
        body: {
          code: "INVALID_EVENT_TOKEN",
          message: CROSS_DEVICE_ERROR_CODES.INVALID_EVENT_TOKEN.message,
        },
      })
    }
  })

  it("rebuilds stable challenge envelopes from stored order data", () => {
    const order = createStoredOrder()
    const first = buildOrderChallengeEnvelope(order)
    const second = buildOrderChallengeEnvelope(order)

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      orderId: order.publicId,
      kind: "sign",
      origin: "https://app.example",
      payloadHash: "payload-1",
      display: {
        title: "Dino signature",
        summary: "Approve signature for Dino.",
      },
      message: order.message,
    })
  })

  it("builds adapter proof verification input from the stored order", () => {
    const order = createStoredOrder()
    const proofInput = buildProofVerificationInput(order, { signature: "sig" })

    expect(proofInput).toEqual({
      challenge: buildOrderChallengeEnvelope(order),
      proof: { signature: "sig" },
    })
  })

  it("accepts only relative returnTo paths", () => {
    expect(normalizeReturnTo(undefined)).toBe("/")
    expect(normalizeReturnTo("/done?x=1#ok")).toBe("/done?x=1#ok")

    for (const value of ["", "https://evil.example", "//evil.example", "app://done", "\\done"])
      expect(() => normalizeReturnTo(value)).toThrow("returnTo must be a relative path")
  })
})
