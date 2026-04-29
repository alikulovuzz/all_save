import { QueueItem } from "./types";

export class DownloadQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private processor: (item: QueueItem) => Promise<void>;

  constructor(processor: (item: QueueItem) => Promise<void>) {
    this.processor = processor;
  }

  enqueue(item: QueueItem): number {
    this.queue.push(item);
    const position = this.queue.length;
    if (!this.processing) {
      this.processNext();
    }
    return position;
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const item = this.queue.shift()!;

    try {
      await this.processor(item);
    } catch (err) {
      console.error("Queue processor error:", err);
    }

    await this.processNext();
  }

  get isBusy(): boolean {
    return this.processing;
  }

  get length(): number {
    return this.queue.length;
  }
}
