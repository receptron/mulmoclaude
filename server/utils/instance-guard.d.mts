// Type declarations for instance-guard.mjs.

import type { ServerPresence } from "./launcher/detect-server.d.mts";

export const SERVER_PORT_FILENAME: string;

export function serverPortPathIn(workspacePath: string): string;

export function parsePublishedPort(text: unknown): number | null;

export function shouldStopForRunningInstance(state: { livePort: number | null; allowMultiple: boolean }): boolean;

export function instanceGuardMessage(port: number): string;

export interface FindLiveInstanceDeps {
  read?: (path: string) => Promise<string>;
  probe?: (port: number) => Promise<ServerPresence>;
}

export function findLiveInstancePort(serverPortPath: string, deps?: FindLiveInstanceDeps): Promise<number | null>;
