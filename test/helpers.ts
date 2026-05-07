import { APIError } from "better-auth"
import { vi } from "vitest"
import { createCrossDeviceOrderLifecycle } from "../src/internal/order/lifecycle"
import type {
  CrossDeviceAdapterCreateInput,
  CrossDeviceAdapterQuery,
  CrossDeviceAdapterUpdateInput,
  CrossDeviceAdapterWhere,
  CrossDeviceRuntimeContext,
  CrossDeviceSession,
  CrossDeviceUser,
} from "../src/internal/types"

export interface StoredRecord {
  id: string
  publicId?: string
  [key: string]: unknown
}

export function createStore() {
  const orders = new Map<string, StoredRecord>()
  const users = new Map<string, StoredRecord>()

  function matchesWhere(record: StoredRecord, where: CrossDeviceAdapterWhere[]) {
    return where.every(({ field, value, operator }) => {
      if (operator === "in") return Array.isArray(value) && value.includes(record[field])
      return record[field] === value
    })
  }

  const adapter = {
    findOne: vi.fn(async ({ model, where }: CrossDeviceAdapterQuery) => {
      if (model === "crossDeviceOrder" || model === "customOrder")
        return Array.from(orders.values()).find((order) => matchesWhere(order, where)) ?? null

      if (model === "user")
        return Array.from(users.values()).find((user) => matchesWhere(user, where)) ?? null

      return null
    }),
    create: vi.fn(async ({ model, data }: CrossDeviceAdapterCreateInput) => {
      const record: StoredRecord = {
        ...data,
        id: typeof data.id === "string" ? data.id : `order-${orders.size + 1}`,
      }
      if (model === "crossDeviceOrder" || model === "customOrder")
        orders.set(record.publicId ?? record.id, record)
      return record
    }),
    update: vi.fn(async ({ model, where, update }: CrossDeviceAdapterUpdateInput) => {
      if (model !== "crossDeviceOrder" && model !== "customOrder") return null

      const current = Array.from(orders.values()).find((order) => matchesWhere(order, where))
      if (!current) return null

      const next = { ...current, ...update }
      orders.set(next.publicId ?? next.id, next)
      return next
    }),
  }

  const internalAdapter = {
    findUserById: vi.fn(async (id: string) => users.get(id) ?? null),
    createUser: vi.fn(
      async (
        data: Partial<CrossDeviceUser> & Record<string, unknown>,
      ): Promise<CrossDeviceUser> => {
        const now = new Date()
        const user: CrossDeviceUser = {
          id: `user-${users.size + 1}`,
          name: "",
          email: "",
          emailVerified: false,
          image: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        }

        users.set(user.id, user)
        return user
      },
    ),
    createSession: vi.fn(async (userId: string): Promise<CrossDeviceSession | null> => {
      const now = new Date()
      return {
        id: `session-${userId}`,
        token: `session-${userId}`,
        userId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      }
    }),
  }

  return { adapter, internalAdapter, orders, users }
}

export function createContext(
  store: ReturnType<typeof createStore>,
  overrides: Record<string, unknown> = {},
): CrossDeviceRuntimeContext & Record<string, unknown> {
  return {
    request: {
      url: "https://app.example/api/auth/cross-device/start",
      signal: new AbortController().signal,
    },
    context: {
      adapter: store.adapter,
      internalAdapter: store.internalAdapter,
      baseURL: "https://app.example",
      isTrustedOrigin: (origin: string) => origin === "https://app.example",
    },
    setHeader: vi.fn(),
    json: <T>(payload: T) => payload,
    ...overrides,
  }
}

export function createLifecycle(
  options: {
    kind?: "login" | "sign" | "transaction"
    resolveLogin?: Parameters<typeof createCrossDeviceOrderLifecycle>[0]["resolveLogin"]
  } = {},
) {
  return createCrossDeviceOrderLifecycle({
    appName: "Dino",
    adapters: new Map([
      [
        "nimiq",
        {
          id: "nimiq",
          createChallenge: (input) => `order=${input.orderId};nonce=${input.nonce}`,
          verifyProof: ({ challenge, proof }) => {
            const record = proof as Record<string, string>
            if (record.signature !== `sig:${challenge.message}`) throw new Error("bad proof")

            return {
              ok: true as const,
              subject: record.subject ?? record.publicKeyHex,
              identity: { address: record.address ?? "NQ07TEST" },
              proofArtifact:
                options.kind === "transaction"
                  ? {
                      address: record.address,
                      publicKeyHex: record.publicKeyHex,
                      txHash: record.txHash,
                    }
                  : {
                      signature: record.signature,
                      subject: record.subject,
                    },
            }
          },
        },
      ],
    ]),
    firstAdapterId: "nimiq",
    orderModelName: "crossDeviceOrder",
    orderTtlSeconds: 120,
    claimPathTemplate: "/cross-device/claim/{orderId}?token={claimToken}",
    normalizeProofError: (error) =>
      error instanceof APIError
        ? error
        : new APIError("INTERNAL_SERVER_ERROR", {
            message: error instanceof Error ? error.message : "Unable to verify proof",
          }),
    resolveLogin: options.resolveLogin,
  })
}

export async function approveOrder(
  lifecycle: ReturnType<typeof createLifecycle>,
  ctx: ReturnType<typeof createContext>,
  input: {
    kind: "login" | "sign" | "transaction"
    proof?: (challenge: { message: string }) => Record<string, string>
  },
) {
  const started = await lifecycle.start(ctx, {
    kind: input.kind,
    origin: "https://app.example",
    returnTo: "/done",
    payloadHash: input.kind === "login" ? undefined : "payload-1",
  })
  const claimed = await lifecycle.claim(ctx, started.orderId, started.claimToken)
  const challenge = await lifecycle.getChallenge(ctx, started.orderId, claimed.challengeToken)
  await lifecycle.approve(ctx, {
    orderId: started.orderId,
    challengeToken: claimed.challengeToken,
    origin: "https://app.example",
    enforceOrigin: true,
    proof: input.proof?.(challenge) ?? {
      subject: "pk-1",
      signature: `sig:${challenge.message}`,
    },
  })

  return { started, claimed, challenge }
}
