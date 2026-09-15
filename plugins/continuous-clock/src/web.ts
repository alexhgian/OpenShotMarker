import { WebPlugin } from '@capacitor/core';
import type { ContinuousClockPlugin } from './definitions';

export class ContinuousClockWeb extends WebPlugin implements ContinuousClockPlugin {
  /**
   * The browser exposes nothing that survives deep sleep, so this is performance.now()
   * and is honest about it: `continuous` is false on the web ClockSource, and the §3.4
   * stale-lock guard is what catches the paused counter.
   */
  async now(): Promise<{ ns: number }> {
    return { ns: performance.now() * 1e6 };
  }
}
