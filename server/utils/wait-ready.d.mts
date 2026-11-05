// Type declarations for wait-ready.mjs.

export const READY_POLL_INTERVAL_MS: number;

export const SLOW_START_NOTICE_AFTER_MS: number;

export function shouldAnnounceSlowStart(state: { elapsedMs: number; announced: boolean }): boolean;

export function slowStartMessage(url: string, options: { willOpenBrowser: boolean }): string;

export interface WaitUntilReadyOptions {
  port: number;
  isServerAlive: () => boolean;
  onSlowStart: () => void;
  probe?: (port: number) => Promise<boolean>;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

export function waitUntilReady(options: WaitUntilReadyOptions): Promise<boolean>;
