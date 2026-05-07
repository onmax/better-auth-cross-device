import type { CrossDeviceOrderLifecycle } from "../order/lifecycle"
import type { CrossDeviceOrderEvent, CrossDeviceRuntimeContext } from "../types"
import { CROSS_DEVICE_ERROR_CODES } from "../error-codes"
import { encodeSse, encodeSseComment, encodeSseRetry, readPayloadStatus } from "./context"

interface CreateOrderEventStreamOptions {
  ctx: CrossDeviceRuntimeContext
  lifecycle: CrossDeviceOrderLifecycle
  orderId: string
  eventToken: string
}

const POLL_INTERVAL_MS = 1000
const RETRY_HINT_MS = 3000

export async function createOrderEventStream({
  ctx,
  lifecycle,
  orderId,
  eventToken,
}: CreateOrderEventStreamOptions): Promise<ReadableStream<Uint8Array>> {
  const firstEvent = await lifecycle.getNextEvent(ctx, orderId, eventToken)

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      const enqueue = (chunk: string) => controller.enqueue(encoder.encode(chunk))
      const send = (event: CrossDeviceOrderEvent, payload: Record<string, unknown>) =>
        enqueue(encodeSse(event, payload))

      let lastStatus = firstEvent ? readPayloadStatus(firstEvent.payload) : ""
      let interval: ReturnType<typeof setInterval> | undefined
      let running = false
      const close = () => {
        if (interval) clearInterval(interval)
        controller.close()
      }

      enqueue(encodeSseRetry(RETRY_HINT_MS))

      if (firstEvent) {
        send(firstEvent.event, firstEvent.payload)
        if (firstEvent.terminal) {
          close()
          return
        }
      }

      const tick = async () => {
        if (running) return
        running = true
        try {
          const next = await lifecycle.getNextEvent(ctx, orderId, eventToken, lastStatus)
          if (!next) return

          lastStatus = readPayloadStatus(next.payload)
          send(next.event, next.payload)
          if (next.terminal) close()
        } catch (error) {
          enqueue(
            encodeSse("error", {
              orderId,
              error:
                error instanceof Error
                  ? error.message
                  : CROSS_DEVICE_ERROR_CODES.EVENT_STREAM_FAILED.message,
            }),
          )
          close()
        } finally {
          running = false
        }
      }

      interval = setInterval(() => {
        enqueue(encodeSseComment("keepalive"))
        void tick()
      }, POLL_INTERVAL_MS)

      ctx.request?.signal?.addEventListener?.("abort", close)
    },
  })
}
