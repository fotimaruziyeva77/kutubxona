"use client";

import { useEffect, useRef, useCallback } from "react";
import { apiOrigin } from "@/lib/api/base";

// socket.io-client package.json ga qo'shiladi
// npm install socket.io-client

type StatsUpdatePayload = {
  type: "national" | "viloyat" | "tuman";
  viloyatId?: string;
  tumanId?: string;
  data: unknown;
  ts: string;
};

type AlertPayload = {
  data: unknown;
  ts: string;
};

type SocketOptions = {
  room: string;
  onStatsUpdate?: (payload: StatsUpdatePayload) => void;
  onAlertNew?: (payload: AlertPayload) => void;
  onAlertResolved?: (payload: { id: string; ts: string }) => void;
};

/**
 * useStatsSocket — WebSocket orqali real vaqt dashboard yangilanishlarini
 * qabul qilish uchun hook.
 *
 * @example
 * useStatsSocket({
 *   room: 'national',
 *   onStatsUpdate: (data) => setStats(data.data),
 * });
 */
export function useStatsSocket(options: SocketOptions) {
  const { room, onStatsUpdate, onAlertNew, onAlertResolved } = options;

  // socket.io-client o'rnatilgunga qadar dynamic import bilan yuklash
  const socketRef = useRef<ReturnType<typeof import("socket.io-client")["io"]> | null>(null);

  const connect = useCallback(async () => {
    const { io } = await import("socket.io-client");

    // H18: Socket.IO handshakes at the BARE backend origin (path /ws lives
    // outside the /api REST prefix) — hence apiOrigin(), not apiBase().
    const backendUrl = apiOrigin();

    const socket = io(backendUrl, {
      path: "/ws",
      transports: ["websocket"],
      autoConnect: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("subscribe", { room });
    });

    socket.on("stats:update", (payload: StatsUpdatePayload) => {
      onStatsUpdate?.(payload);
    });

    socket.on("alert:new", (payload: AlertPayload) => {
      onAlertNew?.(payload);
    });

    socket.on("alert:resolved", (payload: { id: string; ts: string }) => {
      onAlertResolved?.(payload);
    });

    socket.on("connect_error", (err) => {
      // WebSocket ishlamasa silent fail — polling bilan davom etadi
      console.debug("[StatsSocket] ulanish xatosi:", err.message);
    });
  }, [room, onStatsUpdate, onAlertNew, onAlertResolved]);

  useEffect(() => {
    connect();

    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [connect]);
}
