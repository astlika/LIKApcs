import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStream } from '@likapcs/shared';
import { RemoteStreamer, type CapturedFrame } from './remote-stream';

const order = (over: Partial<ServerStream> = {}): ServerStream => ({
  type: 'server.stream',
  active: true,
  fps: 3,
  maxWidth: 1280,
  maxHeight: 720,
  ...over,
});

describe('RemoteStreamer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends frames at the ordered rate while active, and stops at once', async () => {
    const frame: CapturedFrame = { width: 960, height: 540, jpeg: 'AAAAAAAAAAAAAAAAAAAA' };
    const capture = vi.fn(async () => frame);
    const send = vi.fn();
    const streamer = new RemoteStreamer({ capture, send });

    streamer.apply(order());
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledWith(1280, 720, 60);
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(send.mock.calls.length).toBeLessThanOrEqual(4);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      type: 'client.frame',
      width: 960,
      height: 540,
    });

    streamer.apply(order({ active: false }));
    const sent = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(send.mock.calls.length).toBe(sent);
    expect(capture.mock.calls.length).toBeLessThanOrEqual(sent + 1);
  });

  it('never starts a second capture while one is still running', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const capture = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 900));
      inFlight -= 1;
      return { width: 1, height: 1, jpeg: 'AAAAAAAAAAAAAAAAAAAA' };
    });
    const streamer = new RemoteStreamer({ capture, send: vi.fn() });
    streamer.apply(order({ fps: 5 }));
    await vi.advanceTimersByTimeAsync(3000);
    streamer.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(maxInFlight).toBe(1);
  });

  it('skips a frame whose capture fails and keeps going', async () => {
    const capture = vi
      .fn<() => Promise<CapturedFrame>>()
      .mockRejectedValueOnce(new Error('gdi busy'))
      .mockResolvedValue({ width: 2, height: 2, jpeg: 'AAAAAAAAAAAAAAAAAAAA' });
    const send = vi.fn();
    const streamer = new RemoteStreamer({ capture, send });
    streamer.apply(order());
    await vi.advanceTimersByTimeAsync(1200);
    expect(send).toHaveBeenCalled();
    streamer.stop();
  });
});
