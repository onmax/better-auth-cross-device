import type {
  CrossDeviceAdapter,
  CrossDeviceChallengeEnvelope,
  CrossDeviceOrderKind,
  StoredOrderRecord,
} from "../types"
import { constantTimeEqual, generateRandomString } from "better-auth/crypto"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { CROSS_DEVICE_ERROR_CODES, crossDeviceApiError } from "../error-codes"
import { parseOrderExpiresAt, publicOrderId } from "../order/state"
import { parseJson } from "../utils/json"

const DEFAULT_CHALLENGE_APP_NAME = "Cross Device Approval"
const DEFAULT_CHALLENGE_TTL_SECONDS = 300

const KIND_LABELS: Record<CrossDeviceOrderKind, { label: string; summary: string }> = {
  login: { label: "login", summary: "Approve login" },
  sign: { label: "signature", summary: "Approve signature" },
  transaction: { label: "transaction", summary: "Approve transaction" },
}

const CROSS_DEVICE_ACTIONS = {
  login: "auth.login",
  orderApprove: "order.approve",
} as const

type ChallengeValue = string | number | boolean | null | undefined
type TokenHashField =
  | "claimTokenHash"
  | "desktopTokenHash"
  | "eventTokenHash"
  | "challengeTokenHash"
type InvalidTokenCode =
  | "INVALID_CLAIM_TOKEN"
  | "INVALID_DESKTOP_TOKEN"
  | "INVALID_EVENT_TOKEN"
  | "INVALID_CHALLENGE_TOKEN"

export interface IssueOrderSecurityInput {
  adapter: CrossDeviceAdapter
  appName: string
  kind: CrossDeviceOrderKind
  origin: string
  payloadHash?: string
  returnTo?: string
  displayTitle?: string
  displaySummary?: string
  orderTtlSeconds: number
}

export interface IssuedOrderSecurity {
  action: string
  challengeId: string
  claimToken: string
  desktopToken: string
  eventToken: string
  displaySummary: string
  displayTitle: string
  detailsJson: string | null
  expiresAt: Date
  expiresAtMs: number
  issuedAt: Date
  message: string
  nonce: string
  orderId: string
  returnTo: string
}

export function hashToken(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)))
}

export function normalizeReturnTo(returnTo: string | undefined): string {
  const value = returnTo ?? "/"
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  )
    throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.RETURN_TO_NOT_ALLOWED)

  return value
}

function approvalAction(kind: CrossDeviceOrderKind): string {
  return kind === "login" ? CROSS_DEVICE_ACTIONS.login : CROSS_DEVICE_ACTIONS.orderApprove
}

function formatChallengeValue(value: ChallengeValue): string | null {
  if (value === null || value === undefined) return null

  return String(value)
}

function buildChallengeMessage(params: {
  action: string
  appName?: string
  challengeId: string
  details?: Record<string, ChallengeValue>
  expiresAt: number
  issuedAt: number
  nonce: string
  origin: string
  payloadHash?: string
  requestId?: string
  resource?: string
  sessionBinding?: string
}): string {
  const lines = [
    `${params.appName || DEFAULT_CHALLENGE_APP_NAME} requests cross-device approval`,
    `Action: ${params.action}`,
    `Origin: ${params.origin}`,
    `Challenge ID: ${params.challengeId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${new Date(params.issuedAt).toISOString()}`,
    `Expires At: ${new Date(params.expiresAt).toISOString()}`,
  ]

  if (params.requestId) lines.push(`Request ID: ${params.requestId}`)
  if (params.resource) lines.push(`Resource: ${params.resource}`)
  if (params.payloadHash) lines.push(`Payload Hash: ${params.payloadHash}`)
  if (params.sessionBinding) lines.push(`Session Binding: ${params.sessionBinding}`)

  const details = Object.entries(params.details ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  for (const [key, rawValue] of details) {
    const value = formatChallengeValue(rawValue)
    if (value !== null) lines.push(`${key}: ${value}`)
  }

  return lines.join("\n")
}

export function issueOrderSecurity(input: IssueOrderSecurityInput): IssuedOrderSecurity {
  const orderId = generateRandomString(22)
  const claimToken = generateRandomString(32)
  const desktopToken = generateRandomString(32)
  const eventToken = generateRandomString(32)
  const challengeId = generateRandomString(22)
  const nonce = generateRandomString(32)
  const labels = KIND_LABELS[input.kind]
  const displayTitle = input.displayTitle?.trim() || `${input.appName} ${labels.label}`
  const displaySummary = input.displaySummary?.trim() || `${labels.summary} for ${input.appName}.`
  const returnTo = normalizeReturnTo(input.returnTo)
  const issuedAt = Date.now()
  const expiresAt = issuedAt + (input.orderTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS) * 1000
  const action = approvalAction(input.kind)
  const details: Record<string, ChallengeValue> = {
    kind: input.kind,
    orderId,
    title: displayTitle,
    summary: displaySummary,
  }
  const message = buildChallengeMessage({
    action,
    appName: input.appName,
    challengeId,
    details,
    expiresAt,
    issuedAt,
    nonce,
    origin: input.origin,
    payloadHash: input.payloadHash,
    requestId: orderId,
    resource: returnTo,
  })

  const envelope: CrossDeviceChallengeEnvelope = {
    action,
    challengeId,
    details,
    display: { title: displayTitle, summary: displaySummary },
    exp: new Date(expiresAt).toISOString(),
    expiresAt,
    issuedAt,
    kind: input.kind,
    message,
    nonce,
    orderId,
    origin: input.origin,
    payloadHash: input.payloadHash,
    requestId: orderId,
    resource: returnTo,
  }

  return {
    action,
    challengeId,
    claimToken,
    desktopToken,
    eventToken,
    displaySummary,
    displayTitle,
    detailsJson: JSON.stringify(details),
    expiresAt: new Date(expiresAt),
    expiresAtMs: expiresAt,
    issuedAt: new Date(issuedAt),
    message: input.adapter.createChallenge({ ...envelope, appName: input.appName }),
    nonce,
    orderId,
    returnTo,
  }
}

export function buildOrderChallengeEnvelope(
  order: StoredOrderRecord,
): CrossDeviceChallengeEnvelope {
  const orderId = publicOrderId(order)
  const issuedAt = order.issuedAt?.getTime() ?? order.createdAt.getTime()
  const expiresAt = parseOrderExpiresAt(order.expiresAt).getTime()

  return {
    action: order.action || approvalAction(order.kind),
    challengeId: order.challengeId || orderId,
    details: parseJson<Record<string, ChallengeValue>>(order.detailsJson) ?? undefined,
    display: { title: order.displayTitle, summary: order.displaySummary },
    exp: new Date(expiresAt).toISOString(),
    expiresAt,
    issuedAt,
    kind: order.kind,
    message: order.message,
    nonce: order.nonce,
    orderId,
    origin: order.origin,
    payloadHash: order.payloadHash ?? undefined,
    requestId: orderId,
    resource: order.returnTo,
  }
}

export function issueChallengeToken(): string {
  return generateRandomString(32)
}

export function assertOrderToken(
  order: StoredOrderRecord,
  token: string,
  field: TokenHashField,
  errorCode: InvalidTokenCode,
): void {
  const expected = order[field]
  if (!expected || !constantTimeEqual(hashToken(token), expected))
    throw crossDeviceApiError("UNAUTHORIZED", CROSS_DEVICE_ERROR_CODES[errorCode])
}

export function buildProofVerificationInput(order: StoredOrderRecord, proof: unknown) {
  return {
    challenge: buildOrderChallengeEnvelope(order),
    proof,
  }
}
