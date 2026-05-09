import type { Session, User } from "better-auth"

export type CrossDeviceOrderKind = "login" | "sign" | "transaction"
export type CrossDeviceOrderStatus =
  | "created"
  | "claimed"
  | "waiting_user"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "finalized"
export type StoredCrossDeviceOrderStatus = CrossDeviceOrderStatus | "finalizing"
export type CrossDeviceOrderEvent =
  | "claimed"
  | "waiting_user"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "finalized"
export type CrossDeviceProofErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_SERVER_ERROR"

export interface CrossDeviceChallengeDisplay {
  title: string
  summary: string
}

export interface CrossDeviceChallengeEnvelope {
  action: string
  challengeId: string
  details?: Record<string, string | number | boolean | null | undefined>
  issuedAt: number
  orderId: string
  kind: CrossDeviceOrderKind
  origin: string
  nonce: string
  exp: string
  expiresAt: number
  display: CrossDeviceChallengeDisplay
  payloadHash?: string
  requestId?: string
  resource?: string
  sessionBinding?: string
  message: string
}

export interface CrossDeviceVerifiedProof {
  ok: true
  subject: string
  userId?: string
  identity?: Record<string, unknown>
  proofArtifact?: unknown
}

export interface CrossDeviceAdapter {
  id: string
  createChallenge: (
    input: Omit<CrossDeviceChallengeEnvelope, "message"> & { appName: string },
  ) => string
  verifyProof: (input: {
    challenge: CrossDeviceChallengeEnvelope
    proof: unknown
  }) => Promise<CrossDeviceVerifiedProof> | CrossDeviceVerifiedProof
}

export interface StoredOrderRecord {
  id: string
  publicId?: string | null
  action?: string | null
  challengeId?: string | null
  kind: CrossDeviceOrderKind
  adapterId: string
  origin: string
  nonce: string
  issuedAt?: Date | null
  message: string
  returnTo: string
  status: StoredCrossDeviceOrderStatus
  displayTitle: string
  displaySummary: string
  detailsJson?: string | null
  payloadHash?: string | null
  claimTokenHash: string
  desktopTokenHash: string
  eventTokenHash?: string | null
  challengeToken?: string | null
  challengeTokenHash?: string | null
  approvedUserId?: string | null
  approvedSubject?: string | null
  identityJson?: string | null
  proofArtifactJson?: string | null
  claimedAt?: Date | null
  approvedAt?: Date | null
  rejectedAt?: Date | null
  cancelledAt?: Date | null
  finalizedAt?: Date | null
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface CrossDeviceAdapterWhere {
  field: string
  value: unknown
  operator?: "in"
}

export interface CrossDeviceAdapterQuery {
  model: string
  where: CrossDeviceAdapterWhere[]
}

export interface CrossDeviceAdapterCreateInput {
  model: string
  data: Record<string, unknown>
}

export interface CrossDeviceAdapterUpdateInput {
  model: string
  where: CrossDeviceAdapterWhere[]
  update: Record<string, unknown>
}

export interface CrossDeviceDatabaseAdapter {
  create: (input: CrossDeviceAdapterCreateInput) => Promise<unknown>
  findOne: (input: CrossDeviceAdapterQuery) => Promise<unknown>
  update: (input: CrossDeviceAdapterUpdateInput) => Promise<unknown>
}

export type CrossDeviceSession = Session & { token: string; [key: string]: unknown }
export type CrossDeviceUser = User & { id: string; [key: string]: unknown }

export interface CrossDeviceRuntimeContext {
  request?: {
    headers?: Headers
    signal?: AbortSignal
    url?: string
  }
  headers?: Record<string, string | undefined>
  context?: Record<string, unknown>
  json?: <T>(payload: T) => T
  setHeader?: (name: string, value: string) => void
}

export interface ResolveCrossDeviceLoginInput {
  order: StoredOrderRecord
  approvedSubject: string
  approvedUserId?: string | null
  approvedIdentity?: Record<string, unknown> | null
  proofArtifact?: unknown
  ctx: CrossDeviceRuntimeContext
}

export interface CrossDevicePluginOptions {
  appName?: string
  endpointPrefix?: `/${string}`
  trustedOrigins?: string[]
  orderTtlSeconds?: number
  tokenHeaderName?: string
  orderModelName?: string
  enforceOrigin?: boolean
  claimPathTemplate?: string
  adapters: readonly CrossDeviceAdapter[]
  resolveLogin?: (
    input: ResolveCrossDeviceLoginInput,
  ) => Promise<CrossDeviceUser | null | undefined>
}

export interface CrossDeviceStartResponse {
  orderId: string
  adapterId: string
  kind: CrossDeviceOrderKind
  status: "created"
  claimToken: string
  claimUrl: string
  eventToken: string
  desktopToken: string
  expiresAt: number
}

export interface CrossDeviceClientError {
  message?: string
  code?: string
  status?: number
  statusText?: string
  [key: string]: unknown
}

export type CrossDeviceClientResponse<T> =
  | { data: T; error: null }
  | { data: null; error: CrossDeviceClientError }

export interface CrossDeviceClaimResponse {
  ok: true
  orderId: string
  status: "claimed"
  challengeToken: string
}

export interface CrossDeviceChallengeResponse extends CrossDeviceChallengeEnvelope {
  adapterId: string
  status: "claimed" | "waiting_user" | "approved"
}

export interface CrossDeviceApproveResponse {
  ok: true
  orderId: string
  status: "approved"
}

export interface CrossDeviceRejectResponse {
  ok: true
  orderId: string
  status: "rejected"
}

export interface CrossDeviceCancelResponse {
  ok: true
  orderId: string
  status: "cancelled"
}

export interface CrossDeviceFinalizeResponse {
  ok: true
  orderId: string
  status: "finalized"
  kind: CrossDeviceOrderKind
  redirectTo?: string
  token?: string
  proofArtifact?: unknown
}
