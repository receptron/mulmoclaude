import http from "http";
import { Server as IOServer, type Socket } from "socket.io";

import { log } from "../../system/logger/index.js";
import { isAuthorizedPubSubHandshake, PUBSUB_HANDSHAKE_REFUSED } from "./handshakeAuth.js";

export interface IPubSub {
  /** Publish data to all clients subscribed to this channel. */
  publish: (channel: string, data: unknown) => void;
}

export interface PubSubOptions {
  /** The bearer token a handshake must present. `null` while the server
   *  has none yet, which refuses every handshake. */
  tokenProvider: () => string | null;
}

const logRoomError =
  (action: string, channel: string) =>
  (err: unknown): void => {
    log.warn("pubsub", `socket room ${action} failed`, { channel, error: String(err) });
  };

// `join`/`leave` return `void | Promise<void>`: the in-memory adapter runs
// synchronously and returns undefined, while a clustered adapter goes over
// the wire. Nothing here depends on the result, but the promise branch
// still needs a terminal handler — a bare `void` would turn an adapter
// failure into an unhandled rejection. `Promise.resolve` normalises both.
function bindRoomEvents(socket: Socket): void {
  socket.on("subscribe", (channel: unknown) => {
    if (typeof channel === "string") Promise.resolve(socket.join(channel)).catch(logRoomError("subscribe", channel));
  });
  socket.on("unsubscribe", (channel: unknown) => {
    if (typeof channel === "string") Promise.resolve(socket.leave(channel)).catch(logRoomError("unsubscribe", channel));
  });
}

// Channel names are treated as socket.io rooms — one room per
// channel. Subscribe/unsubscribe is plain `socket.join` /
// `socket.leave`. Publish broadcasts to the room. Reconnect /
// heartbeat / multi-transport fallback are handled by socket.io
// itself, which is why we switched off raw ws.

export function createPubSub(server: http.Server, options: PubSubOptions): IPubSub {
  const ioServer = new IOServer(server, {
    path: "/ws/pubsub",
    // Server binds to 127.0.0.1 only, so CORS is moot — but
    // socket.io defaults to rejecting cross-origin upgrade
    // requests. Allow same-origin explicitly to cover the
    // dev-proxy case (vite serves on a different port than the
    // API server during `yarn dev`).
    cors: { origin: true, credentials: true },
    // Skip the long-poll transport negotiation: loopback-only
    // deployment can always upgrade to WebSocket, and starting
    // there avoids the 200ms long-poll round trip on first
    // connection.
    transports: ["websocket"],
  });

  // Same token every `/api/*` call presents (#3433). A refused handshake
  // destroys the client socket, so socket.io does not retry it — the SPA
  // reads that as "reload for a fresh token" rather than spinning.
  ioServer.use((socket, next) => {
    if (isAuthorizedPubSubHandshake(socket.handshake.auth, options.tokenProvider())) {
      next();
      return;
    }
    log.warn("pubsub", "handshake refused: bearer token missing or invalid", { address: socket.handshake.address });
    next(new Error(PUBSUB_HANDSHAKE_REFUSED));
  });

  ioServer.on("connection", bindRoomEvents);

  return {
    publish(channel: string, data: unknown): void {
      ioServer.to(channel).emit("data", { channel, data });
    },
  };
}
