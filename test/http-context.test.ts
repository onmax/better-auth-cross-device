import { describe, expect, it, vi } from "vitest"
import { CROSS_DEVICE_ERROR_CODES } from "../src/internal/error-codes"
import {
  applyFinalizedSession,
  assertTrustedOrigin,
  encodeSse,
  readPayloadStatus,
  resolveOrigin,
} from "../src/internal/http/context"

const setSessionCookie = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("better-auth/cookies", () => ({
  setSessionCookie,
}))

describe("cross-device HTTP context", () => {
  it("resolves origin from Origin first and request URL fallback", () => {
    expect(
      resolveOrigin({
        request: {
          headers: new Headers({ origin: "https://wallet.example/path" }),
          url: "https://app.example/api",
        },
      }),
    ).toBe("https://wallet.example")

    expect(
      resolveOrigin({
        request: {
          headers: new Headers({
            "x-forwarded-host": "public.example",
            "x-forwarded-proto": "https",
          }),
          url: "http://internal.example/api",
        },
      }),
    ).toBe("http://internal.example")
  })

  it("requires Better Auth and configured plugin trusted origins when both are available", () => {
    const isTrustedOrigin = vi.fn((origin: string) => origin === "https://app.example")

    expect(() =>
      assertTrustedOrigin(
        { context: { isTrustedOrigin } },
        "https://app.example",
        new Set(["https://app.example"]),
      ),
    ).not.toThrow()
    expect(isTrustedOrigin).toHaveBeenCalledWith("https://app.example")

    expect(() =>
      assertTrustedOrigin(
        { context: { isTrustedOrigin } },
        "https://fallback.example",
        new Set(["https://fallback.example"]),
      ),
    ).toThrow(CROSS_DEVICE_ERROR_CODES.UNTRUSTED_ORIGIN.message)
    expect(() =>
      assertTrustedOrigin(
        { context: { isTrustedOrigin } },
        "https://app.example",
        new Set(["https://other.example"]),
      ),
    ).toThrow(CROSS_DEVICE_ERROR_CODES.UNTRUSTED_ORIGIN.message)
  })

  it("uses plugin trusted origins as a fallback when Better Auth context is absent", () => {
    expect(() =>
      assertTrustedOrigin({}, "https://fallback.example", new Set(["https://fallback.example"])),
    ).not.toThrow()
    expect(() =>
      assertTrustedOrigin({}, "https://blocked.example", new Set(["https://fallback.example"])),
    ).toThrow(CROSS_DEVICE_ERROR_CODES.UNTRUSTED_ORIGIN.message)
  })

  it("applies finalized login session cookies and token header", async () => {
    const setHeader = vi.fn()
    const now = new Date()
    const finalizedSession = {
      session: {
        id: "session-1",
        token: "session-token",
        userId: "user-1",
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
      },
      user: {
        id: "user-1",
        name: "",
        email: "",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    }

    await applyFinalizedSession({ setHeader }, finalizedSession, "set-auth-token")

    expect(setSessionCookie).toHaveBeenCalledWith({ setHeader }, finalizedSession, false)
    expect(setHeader).toHaveBeenCalledWith("set-auth-token", "session-token")
  })

  it("encodes SSE frames and reads payload statuses", () => {
    expect(encodeSse("approved", { orderId: "order", status: "approved" })).toBe(
      'event: approved\ndata: {"orderId":"order","status":"approved"}\n\n',
    )
    expect(readPayloadStatus({ status: "approved" })).toBe("approved")
    expect(readPayloadStatus({ status: 1 })).toBe("")
  })
})
