import { registerPlugin } from '@capacitor/core';
import type { ContinuousClockPlugin } from './definitions';

const ContinuousClock = registerPlugin<ContinuousClockPlugin>('ContinuousClock', {
  web: () => import('./web').then((m) => new m.ContinuousClockWeb()),
});

export * from './definitions';
export { ContinuousClock };
