import type { BetterAuthClientPlugin } from "better-auth/client"
import type { crossDevice } from "./index"
import type {
  CrossDeviceApproveResponse,
  CrossDeviceCancelResponse,
  CrossDeviceChallengeResponse,
  CrossDeviceClaimResponse,
  CrossDeviceClientError,
  CrossDeviceClientResponse,
  CrossDeviceFinalizeResponse,
  CrossDeviceOrderEvent,
  CrossDeviceRejectResponse,
  CrossDeviceStartResponse,
} from "./internal/types"
import {
  createPathMethods,
  CROSS_DEVICE_ENDPOINTS,
  CROSS_DEVICE_ORDER_EVENTS,
  type CrossDeviceEndpointKey,
  normalizeEndpointPrefix,
  TERMINAL_ORDER_EVENTS,
} from "./internal/endpoint-catalog"

interface RequestInit {
  method: "GET" | "POST"
  body?: Record<string, unknown>
  query?: Record<string, string>
}

export type AuthClientFetcher = <T = unknown>(
  path: string,
  options?: Record<string, unknown>,
) => Promise<T>

export type CrossDeviceFetchOptions = Record<string, unknown>

type FetcherResponse<T> = T | CrossDeviceClientResponse<T>

function normalizeFetcherResponse<T>(response: FetcherResponse<T>): CrossDeviceClientResponse<T> {
  const record = response as Record<string, unknown>
  if ("error" in record) {
    if (record.error) return { data: null, error: readFetcherError(record.error) }
    if ("data" in record) return { data: record.data as T, error: null }
  }
  if ("data" in record && Object.keys(record).length === 1)
    return { data: record.data as T, error: null }

  return { data: response as T, error: null }
}

function readFetcherErrorPrimitive(error: unknown): CrossDeviceClientError | null {
  if (typeof error === "string" && error.trim()) return { message: error }
  if (error instanceof Error) return { message: error.message }
  if (!error || typeof error !== "object") return { message: "Request failed" }
  return null
}

function readFetcherError(error: unknown): CrossDeviceClientError {
  const primitive = readFetcherErrorPrimitive(error)
  if (primitive) return primitive

  const record = error as Record<string, unknown>
  return {
    ...record,
    message: typeof record.message === "string" ? record.message : "Request failed",
    code: typeof record.code === "string" ? record.code : undefined,
    status: typeof record.status === "number" ? record.status : undefined,
    statusText: typeof record.statusText === "string" ? record.statusText : undefined,
  }
}

async function requestCrossDevice<T>(
  fetcher: AuthClientFetcher,
  endpointPrefix: `/${string}` | undefined,
  path: string,
  init: RequestInit,
  fetchOptions?: CrossDeviceFetchOptions,
): Promise<CrossDeviceClientResponse<T>> {
  const prefix = normalizeEndpointPrefix(endpointPrefix)
  const url = init.query
    ? `${prefix}${path}?${new URLSearchParams(init.query).toString()}`
    : `${prefix}${path}`
  const response = await fetcher<T>(url, {
    ...fetchOptions,
    method: init.method,
    ...(init.body !== undefined ? { body: init.body } : {}),
  })
  return normalizeFetcherResponse(response)
}

interface BaseActionOptions {
  endpointPrefix?: `/${string}`
}

type ActionEndpointKey = Exclude<CrossDeviceEndpointKey, "events">

function createAction<TOptions extends BaseActionOptions, TResponse>(
  key: ActionEndpointKey,
  pickBody: (options: TOptions) => Record<string, unknown>,
) {
  const path = CROSS_DEVICE_ENDPOINTS[key].path
  return (
    fetcher: AuthClientFetcher,
    options: TOptions,
    fetchOptions?: CrossDeviceFetchOptions,
  ): Promise<CrossDeviceClientResponse<TResponse>> =>
    requestCrossDevice<TResponse>(
      fetcher,
      options.endpointPrefix,
      path,
      { method: "POST", body: pickBody(options) },
      fetchOptions,
    )
}

export interface StartCrossDeviceOrderOptions extends BaseActionOptions {
  adapterId?: string
  kind: "login" | "sign" | "transaction"
  returnTo?: string
  displayTitle?: string
  displaySummary?: string
  payloadHash?: string
}

export interface ClaimCrossDeviceOrderOptions extends BaseActionOptions {
  orderId: string
  claimToken: string
}

export interface GetCrossDeviceChallengeOptions extends BaseActionOptions {
  orderId: string
  challengeToken: string
}

export interface ApproveCrossDeviceOrderOptions extends BaseActionOptions {
  orderId: string
  challengeToken: string
  proof: unknown
}

export interface RejectCrossDeviceOrderOptions extends BaseActionOptions {
  orderId: string
  challengeToken: string
}

export interface CancelCrossDeviceOrderOptions extends BaseActionOptions {
  orderId: string
  desktopToken: string
}

export interface FinalizeCrossDeviceOrderOptions extends BaseActionOptions {
  orderId: string
  desktopToken: string
}

export interface SubscribeCrossDeviceOrderOptions {
  orderId: string
  eventToken: string
  endpointPrefix?: `/${string}`
  basePath?: `/${string}` | ""
  onEvent: (event: CrossDeviceOrderEvent, payload: Record<string, unknown>) => void
  onError?: (error: Event) => void
}

export const startCrossDeviceOrder = createAction<
  StartCrossDeviceOrderOptions,
  CrossDeviceStartResponse
>("start", (o) => ({
  adapterId: o.adapterId,
  kind: o.kind,
  returnTo: o.returnTo,
  displayTitle: o.displayTitle,
  displaySummary: o.displaySummary,
  payloadHash: o.payloadHash,
}))

export const claimCrossDeviceOrder = createAction<
  ClaimCrossDeviceOrderOptions,
  CrossDeviceClaimResponse
>("claim", (o) => ({ orderId: o.orderId, claimToken: o.claimToken }))

export const getCrossDeviceChallenge = createAction<
  GetCrossDeviceChallengeOptions,
  CrossDeviceChallengeResponse
>("challenge", (o) => ({ orderId: o.orderId, challengeToken: o.challengeToken }))

export const approveCrossDeviceOrder = createAction<
  ApproveCrossDeviceOrderOptions,
  CrossDeviceApproveResponse
>("approve", (o) => ({
  orderId: o.orderId,
  challengeToken: o.challengeToken,
  proof: o.proof,
}))

export const rejectCrossDeviceOrder = createAction<
  RejectCrossDeviceOrderOptions,
  CrossDeviceRejectResponse
>("reject", (o) => ({ orderId: o.orderId, challengeToken: o.challengeToken }))

export const cancelCrossDeviceOrder = createAction<
  CancelCrossDeviceOrderOptions,
  CrossDeviceCancelResponse
>("cancel", (o) => ({ orderId: o.orderId, desktopToken: o.desktopToken }))

export const finalizeCrossDeviceOrder = createAction<
  FinalizeCrossDeviceOrderOptions,
  CrossDeviceFinalizeResponse
>("finalize", (o) => ({ orderId: o.orderId, desktopToken: o.desktopToken }))

export function subscribeToCrossDeviceOrder(
  options: SubscribeCrossDeviceOrderOptions,
): EventSource {
  if (typeof window === "undefined")
    throw new Error("Cross-device order subscriptions require a browser runtime")

  const endpointPrefix = normalizeEndpointPrefix(options.endpointPrefix)
  const basePath = options.basePath ?? ""
  const url = new URL(
    `${window.location.origin}${basePath}${endpointPrefix}${CROSS_DEVICE_ENDPOINTS.events.path}`,
  )
  url.searchParams.set("orderId", options.orderId)
  url.searchParams.set("eventToken", options.eventToken)

  const source = new EventSource(url.toString(), { withCredentials: true })
  for (const event of CROSS_DEVICE_ORDER_EVENTS)
    source.addEventListener(event, (payload) => {
      const message = payload as MessageEvent<string>
      options.onEvent(event, message.data ? JSON.parse(message.data) : {})
      if (TERMINAL_ORDER_EVENTS.includes(event)) source.close()
    })

  if (options.onError) source.addEventListener("error", options.onError)

  return source
}

export interface CrossDeviceClientPluginOptions {
  endpointPrefix?: `/${string}`
}

const ACTION_BUILDERS = {
  startCrossDeviceOrder,
  claimCrossDeviceOrder,
  getCrossDeviceChallenge,
  approveCrossDeviceOrder,
  rejectCrossDeviceOrder,
  cancelCrossDeviceOrder,
  finalizeCrossDeviceOrder,
} as const

type ActionName = keyof typeof ACTION_BUILDERS
type ActionInputOf<N extends ActionName> = Parameters<(typeof ACTION_BUILDERS)[N]>[1]
type ActionResultOf<N extends ActionName> = ReturnType<(typeof ACTION_BUILDERS)[N]>

type CrossDeviceClientActions = {
  [N in ActionName]: (
    runOptions: Omit<ActionInputOf<N>, "endpointPrefix">,
    fetchOptions?: CrossDeviceFetchOptions,
  ) => ActionResultOf<N>
}

export function crossDeviceClient(options: CrossDeviceClientPluginOptions = {}) {
  const endpointPrefix = normalizeEndpointPrefix(options.endpointPrefix)

  return {
    id: "cross-device",
    $InferServerPlugin: {} as ReturnType<typeof crossDevice>,
    pathMethods: createPathMethods(endpointPrefix),
    getActions: (fetcher) => {
      const fetch = fetcher as AuthClientFetcher
      const names = Object.keys(ACTION_BUILDERS) as ActionName[]
      return Object.fromEntries(
        names.map((name) => [
          name,
          (
            runOptions: Omit<ActionInputOf<typeof name>, "endpointPrefix">,
            fetchOptions?: CrossDeviceFetchOptions,
          ) =>
            (
              ACTION_BUILDERS[name] as (
                fetcher: AuthClientFetcher,
                o: ActionInputOf<typeof name>,
                f?: CrossDeviceFetchOptions,
              ) => ActionResultOf<typeof name>
            )(fetch, { ...runOptions, endpointPrefix } as ActionInputOf<typeof name>, fetchOptions),
        ]),
      ) as CrossDeviceClientActions
    },
  } satisfies BetterAuthClientPlugin
}
