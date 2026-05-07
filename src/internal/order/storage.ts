import type {
  CrossDeviceDatabaseAdapter,
  CrossDeviceRuntimeContext,
  StoredCrossDeviceOrderStatus,
  StoredOrderRecord,
} from "../types"
import { isOrderExpired, isTerminalOrderStatus } from "./state"

export interface CrossDeviceOrderStorage {
  create: (
    ctx: CrossDeviceRuntimeContext,
    data: Omit<StoredOrderRecord, "id">,
  ) => Promise<StoredOrderRecord>
  findByPublicId: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
  ) => Promise<StoredOrderRecord | null>
  update: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    update: Partial<StoredOrderRecord> & Record<string, unknown>,
  ) => Promise<StoredOrderRecord | null>
  transition: (
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    currentStatus: StoredCrossDeviceOrderStatus | readonly StoredCrossDeviceOrderStatus[],
    update: Partial<StoredOrderRecord> & Record<string, unknown>,
  ) => Promise<StoredOrderRecord | null>
  ensureActive: (
    ctx: CrossDeviceRuntimeContext,
    order: StoredOrderRecord,
  ) => Promise<StoredOrderRecord>
}

export function createCrossDeviceOrderStorage(orderModelName: string): CrossDeviceOrderStorage {
  function getAdapter(ctx: CrossDeviceRuntimeContext) {
    const adapter = ctx.context?.adapter
    if (
      !adapter ||
      typeof adapter !== "object" ||
      !("create" in adapter) ||
      !("findOne" in adapter) ||
      !("update" in adapter)
    )
      throw new Error("Missing Better Auth adapter in cross-device context")

    return adapter as CrossDeviceDatabaseAdapter
  }

  async function update(
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    update: Partial<StoredOrderRecord> & Record<string, unknown>,
  ): Promise<StoredOrderRecord | null> {
    return (await getAdapter(ctx).update({
      model: orderModelName,
      where: [{ field: "id", value: orderId }],
      update: {
        ...update,
        updatedAt: new Date(),
      },
    })) as StoredOrderRecord | null
  }

  async function transition(
    ctx: CrossDeviceRuntimeContext,
    orderId: string,
    currentStatus: StoredCrossDeviceOrderStatus | readonly StoredCrossDeviceOrderStatus[],
    update: Partial<StoredOrderRecord> & Record<string, unknown>,
  ): Promise<StoredOrderRecord | null> {
    const statusClause = Array.isArray(currentStatus)
      ? { field: "status", value: currentStatus, operator: "in" as const }
      : { field: "status", value: currentStatus }

    return (await getAdapter(ctx).update({
      model: orderModelName,
      where: [{ field: "id", value: orderId }, statusClause],
      update: {
        ...update,
        updatedAt: new Date(),
      },
    })) as StoredOrderRecord | null
  }

  return {
    async create(ctx, data) {
      return (await getAdapter(ctx).create({
        model: orderModelName,
        data,
      })) as StoredOrderRecord
    },

    async findByPublicId(ctx, orderId) {
      return (await getAdapter(ctx).findOne({
        model: orderModelName,
        where: [{ field: "publicId", value: orderId }],
      })) as StoredOrderRecord | null
    },

    update,
    transition,

    async ensureActive(ctx, order) {
      if (!isOrderExpired(order)) return order

      if (
        order.status === "approved" ||
        order.status === "finalizing" ||
        isTerminalOrderStatus(order.status)
      )
        return order

      const expired = {
        ...order,
        status: "expired" as StoredCrossDeviceOrderStatus,
        updatedAt: new Date(),
      }
      return (await transition(ctx, order.id, order.status, { status: "expired" })) ?? expired
    },
  }
}
