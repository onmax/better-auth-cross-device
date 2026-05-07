import type { BetterAuthPluginDBSchema } from "better-auth/db"

export function createCrossDeviceSchema(orderModelName: string): BetterAuthPluginDBSchema {
  return {
    [orderModelName]: {
      fields: {
        id: { type: "string", required: true },
        publicId: { type: "string", required: true, unique: true },
        action: { type: "string", required: false },
        challengeId: { type: "string", required: false },
        kind: { type: "string", required: true },
        adapterId: { type: "string", required: true },
        origin: { type: "string", required: true },
        nonce: { type: "string", required: true },
        issuedAt: { type: "date", required: false },
        message: { type: "string", required: true },
        returnTo: { type: "string", required: true },
        status: { type: "string", required: true },
        displayTitle: { type: "string", required: true },
        displaySummary: { type: "string", required: true },
        detailsJson: { type: "string", required: false },
        payloadHash: { type: "string", required: false },
        claimTokenHash: { type: "string", required: true },
        desktopTokenHash: { type: "string", required: true },
        eventTokenHash: { type: "string", required: false },
        challengeToken: { type: "string", required: false },
        challengeTokenHash: { type: "string", required: false },
        approvedUserId: {
          type: "string",
          required: false,
          references: { model: "user", field: "id" },
        },
        approvedSubject: { type: "string", required: false },
        identityJson: { type: "string", required: false },
        proofArtifactJson: { type: "string", required: false },
        claimedAt: { type: "date", required: false },
        approvedAt: { type: "date", required: false },
        rejectedAt: { type: "date", required: false },
        cancelledAt: { type: "date", required: false },
        finalizedAt: { type: "date", required: false },
        expiresAt: { type: "date", required: true },
        createdAt: { type: "date", required: true },
        updatedAt: { type: "date", required: true },
      },
    },
  }
}
