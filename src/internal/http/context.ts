import { setSessionCookie } from "better-auth/cookies"
import { CROSS_DEVICE_ERROR_CODES, crossDeviceApiError } from "../error-codes"
import type { CrossDeviceFinalizedSession } from "../order/lifecycle"
import type { CrossDeviceRuntimeContext } from "../types"

type SessionCookieContext = Parameters<typeof setSessionCookie>[0]

function readNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readFromGetter(headers: Headers | undefined, names: string[]): string | null {
  if (!headers?.get) return null
  for (const name of names) {
    const found = readNonEmpty(headers.get(name))
    if (found) return found
  }
  return null
}

function readFromObject(
  headers: Record<string, unknown> | undefined,
  names: string[],
): string | null {
  if (!headers || typeof headers !== "object") return null
  for (const name of names) {
    const found = readNonEmpty(headers[name])
    if (found) return found
  }
  return null
}

function readHeader(ctx: CrossDeviceRuntimeContext, name: string): string | null {
  const names = [name.toLowerCase(), name]
  return readFromGetter(ctx?.request?.headers, names) ?? readFromObject(ctx?.headers, names)
}

export function resolveOrigin(ctx: CrossDeviceRuntimeContext): string {
  const explicitOrigin = readHeader(ctx, "origin")
  if (explicitOrigin && explicitOrigin !== "null") {
    try {
      return new URL(explicitOrigin).origin
    } catch {}
  }

  const requestUrl = ctx?.request?.url || readContextString(ctx, "baseURL")
  if (!requestUrl)
    throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.UNABLE_TO_RESOLVE_ORIGIN)

  const fallback = new URL(requestUrl)
  return fallback.origin
}

export function assertTrustedOrigin(
  ctx: CrossDeviceRuntimeContext,
  origin: string,
  fallbackTrustedOrigins: Set<string>,
): void {
  const checkTrustedOrigin = ctx.context?.isTrustedOrigin
  const trustedByBetterAuth =
    typeof checkTrustedOrigin === "function" ? checkTrustedOrigin(origin) : true
  const trustedByPlugin = fallbackTrustedOrigins.size === 0 || fallbackTrustedOrigins.has(origin)
  const trusted = trustedByBetterAuth && trustedByPlugin

  if (!trusted) throw crossDeviceApiError("BAD_REQUEST", CROSS_DEVICE_ERROR_CODES.UNTRUSTED_ORIGIN)
}

function readContextString(ctx: CrossDeviceRuntimeContext, key: string): string | undefined {
  const value = ctx.context?.[key]
  return typeof value === "string" ? value : undefined
}

export async function applyFinalizedSession(
  ctx: CrossDeviceRuntimeContext,
  finalizedSession: CrossDeviceFinalizedSession,
  tokenHeaderName: string,
): Promise<void> {
  await setSessionCookie(ctx as SessionCookieContext, finalizedSession, false)
  ctx.setHeader?.(tokenHeaderName, finalizedSession.session.token)
}

export function encodeSse(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

export function encodeSseComment(comment: string): string {
  return `: ${comment}\n\n`
}

export function encodeSseRetry(milliseconds: number): string {
  return `retry: ${milliseconds}\n\n`
}

export function readPayloadStatus(payload: Record<string, unknown>): string {
  return typeof payload.status === "string" ? payload.status : ""
}
