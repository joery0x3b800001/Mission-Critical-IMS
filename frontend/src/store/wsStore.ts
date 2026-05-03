import { create } from 'zustand';

interface WsStore {
  connected: boolean;
  lastEvent: Record<string, unknown> | null;
  connect: () => void;
}

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (capped at 60s)
function getReconnectDelay(attempt: number): number {
  const baseDelay = 1000; // 1 second
  const delay = Math.min(baseDelay * Math.pow(2, attempt), 60_000); // Cap at 60s
  return delay;
}

export const useWsStore = create<WsStore>((set) => ({
  connected: false,
  lastEvent: null,
  connect() {
    if (ws) return;
    const url = (import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001') + '/ws';
    ws = new WebSocket(url);

    ws.onopen = () => {
      set({ connected: true });
      reconnectAttempts = 0; // Reset counter on successful connection
    };
    ws.onclose = () => {
      set({ connected: false });
      ws = null;
      
      // Exponential backoff reconnection (max 10 attempts, then stop)
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = getReconnectDelay(reconnectAttempts);
        reconnectAttempts++;
        setTimeout(() => useWsStore.getState().connect(), delay);
      } else {
        console.warn('[WebSocket] Max reconnection attempts reached. Giving up.');
      }
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        set({ lastEvent: data });
      } catch (_) {}
    };
  },
}));
