/**
 * Live screen (remote view, phase 1), PC side. The server says whether to stream and at what
 * rate (`server.stream`); this sends one JPEG frame at a time, never overlapping captures, and
 * stops at once when told to. Nothing is recorded on the PC.
 */
import type { ServerStream } from '@likapcs/shared';

export const REMOTE_JPEG_QUALITY = 60;

export interface CapturedFrame {
  width: number;
  height: number;
  /** Base64 JPEG. */
  jpeg: string;
}

export interface RemoteStreamDeps {
  capture: (maxWidth: number, quality: number) => Promise<CapturedFrame>;
  send: (frame: {
    type: 'client.frame';
    width: number;
    height: number;
    jpeg: string;
    ts: string;
  }) => void;
  now?: () => number;
}

export class RemoteStreamer {
  private order: ServerStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(private readonly deps: RemoteStreamDeps) {}

  /** Apply an order from the server. Inactive orders stop the stream immediately. */
  apply(order: ServerStream): void {
    if (!order.active) {
      this.stop();
      return;
    }
    this.order = order;
    if (!this.busy && this.timer === null) void this.tick();
  }

  stop(): void {
    this.order = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const order = this.order;
    if (!order) return;
    this.busy = true;
    const now = this.deps.now ?? Date.now;
    const started = now();
    try {
      const frame = await this.deps.capture(order.maxWidth, REMOTE_JPEG_QUALITY);
      // Only send if the same order is still active (a stop or a new order may have arrived).
      if (this.order === order) {
        this.deps.send({
          type: 'client.frame',
          width: frame.width,
          height: frame.height,
          jpeg: frame.jpeg,
          ts: new Date(now()).toISOString(),
        });
      }
    } catch {
      // A failed capture just skips this frame; the next one is scheduled as usual.
    } finally {
      this.busy = false;
      if (this.order === order) {
        const interval = 1000 / Math.min(5, Math.max(0.25, order.fps));
        const delay = Math.max(0, interval - (now() - started));
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.tick();
        }, delay);
      }
    }
  }
}
