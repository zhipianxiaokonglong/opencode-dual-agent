/**
 * UI 事件总线（v1.1 §4.2）：先落库后推送。
 * - 每个事件写入 Store.events（单调序号 seq）后才通知订阅者
 * - 断线重连按 seq 补发（Store.listEvents），保证不丢不乱序
 */
import type { Store } from "../ports";
import type { UIEvent, UIEventEnvelope } from "../protocols/ui-event";

export type UIEventSink = (envelope: UIEventEnvelope) => void;

export class EventBus {
  readonly #sinks = new Set<UIEventSink>();

  constructor(
    private readonly store: Store,
    private readonly runId: string,
  ) {}

  /** 落库 → 推送。返回带序号信封。 */
  async emit(event: UIEvent): Promise<UIEventEnvelope> {
    const [envelope] = await this.store.appendEvents(this.runId, [event]);
    for (const sink of this.#sinks) {
      try {
        sink(envelope!);
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
    return envelope!;
  }

  async emitMany(events: readonly UIEvent[]): Promise<UIEventEnvelope[]> {
    const envelopes = await this.store.appendEvents(this.runId, events);
    for (const envelope of envelopes) {
      for (const sink of this.#sinks) {
        try {
          sink(envelope);
        } catch {
          // 忽略单订阅者异常
        }
      }
    }
    return envelopes;
  }

  /** 订阅实时推送；返回取消函数。 */
  subscribe(sink: UIEventSink): () => void {
    this.#sinks.add(sink);
    return () => this.#sinks.delete(sink);
  }

  /** 断线补发：seq 严格大于 since 的事件，升序。 */
  since(seq: number, limit?: number): Promise<UIEventEnvelope[]> {
    return this.store.listEvents(this.runId, seq, limit);
  }
}
