import type { CrossDeviceOrderStatus } from "../src"
import { describe, expect, it } from "vitest"
import {
  assertCanApprove,
  assertCanCancel,
  assertCanFinalize,
  assertCanReject,
  assertNotTerminal,
  isOrderExpired,
  isTerminalOrderStatus,
} from "../src/internal/order/state"

function order(status: CrossDeviceOrderStatus) {
  return { status }
}

describe("order state transitions", () => {
  it("identifies terminal and expired order state without storage writes", () => {
    expect(isTerminalOrderStatus("finalized")).toBe(true)
    expect(isTerminalOrderStatus("approved")).toBe(false)
    expect(isOrderExpired({ expiresAt: new Date(1_000) }, 1_001)).toBe(true)
    expect(isOrderExpired({ expiresAt: new Date(1_000) }, 999)).toBe(false)
  })

  it("allows only active approval, rejection, cancel, and finalize transitions", () => {
    expect(() => assertCanApprove(order("claimed"))).not.toThrow()
    expect(() => assertCanApprove(order("waiting_user"))).not.toThrow()
    expect(() => assertCanApprove(order("approved"))).not.toThrow()
    expect(() => assertCanApprove(order("created"))).toThrow("Order is not ready to approve")

    expect(() => assertCanReject(order("waiting_user"))).not.toThrow()
    expect(() => assertCanReject(order("approved"))).toThrow("Order is not ready to reject")

    expect(() => assertCanCancel(order("created"))).not.toThrow()
    expect(() => assertCanCancel(order("finalized"))).toThrow("Order is not ready to cancel")

    expect(() => assertCanFinalize(order("approved"))).not.toThrow()
    expect(() => assertCanFinalize(order("finalized"))).not.toThrow()
    expect(() => assertCanFinalize(order("claimed"))).toThrow("Order is not ready to finalize")
  })

  it("blocks terminal orders from active actions", () => {
    expect(() => assertNotTerminal(order("rejected"))).toThrow(
      "Order status changed before this operation completed",
    )
  })
})
