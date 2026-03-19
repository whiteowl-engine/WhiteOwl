import { EventEmitter } from 'events';
import { EventMap, EventName, EventBusInterface } from '../types';

interface HistoryEntry {
  event: EventName;
  data: any;
  timestamp: number;
}

const MAX_HISTORY = 1000;

export class EventBus implements EventBusInterface {
  private emitter = new EventEmitter();
  private eventHistory: HistoryEntry[] = [];
  private wildcardHandlers: Array<(event: EventName, data: any) => void> = [];

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends EventName>(event: K, data: EventMap[K]): void {
    const entry: HistoryEntry = { event, data, timestamp: Date.now() };
    this.eventHistory.push(entry);

    if (this.eventHistory.length > MAX_HISTORY) {
      this.eventHistory = this.eventHistory.slice(-MAX_HISTORY);
    }

    this.emitter.emit(event, data);

    for (const handler of this.wildcardHandlers) {
      try {
        handler(event, data);
      } catch (err) {
        console.error(`Wildcard handler error on ${event}:`, err);
      }
    }
  }

  on<K extends EventName>(event: K, handler: (data: EventMap[K]) => void): void {
    this.emitter.on(event, handler);
  }

  off<K extends EventName>(event: K, handler: (data: EventMap[K]) => void): void {
    this.emitter.off(event, handler);
  }

  once<K extends EventName>(event: K, handler: (data: EventMap[K]) => void): void {
    this.emitter.once(event, handler);
  }

  onAny(handler: (event: EventName, data: any) => void): void {
    this.wildcardHandlers.push(handler);
  }

  offAny(handler: (event: EventName, data: any) => void): void {
    this.wildcardHandlers = this.wildcardHandlers.filter(h => h !== handler);
  }

  history(event?: EventName, limit: number = 50): HistoryEntry[] {
    let entries = event
      ? this.eventHistory.filter(e => e.event === event)
      : this.eventHistory;
    return entries.slice(-limit);
  }

  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event);
  }

  removeAllListeners(event?: EventName): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
      this.wildcardHandlers = [];
    }
  }
}
