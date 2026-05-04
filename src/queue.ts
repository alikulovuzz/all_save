import { QueueItem } from "./types";

export class DownloadQueue {
  private queue: QueueItem[] = [];
  private active = 0;
  private readonly concurrency: number;
  private processor: (item: QueueItem) => Promise<void>;

  constructor(processor: (item: QueueItem) => Promise<void>, concurrency = 1) {
    this.processor = processor;
    this.concurrency = Math.max(1, concurrency);
  }

  enqueue(item: QueueItem): number {
    this.queue.push(item);
    const position = this.active + this.queue.length;
    this.fillSlots();
    return position;
  }

  private fillSlots(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active++;
      this.runOne(item);
    }
  }

  private async runOne(item: QueueItem): Promise<void> {
    try {
      await this.processor(item);
    } catch (err) {
      console.error("Queue processor error:", err);
    } finally {
      this.active--;
      this.fillSlots();
    }
  }

  get isBusy(): boolean {
    return this.active > 0;
  }

  get length(): number {
    return this.queue.length;
  }

  get inFlight(): number {
    return this.active;
  }
}
