import { create } from 'zustand';
import { frontendConfig } from '../config';

interface WsStore {
  connected: boolean;
  lastEvent: Record<string, unknown> | null;
  connect: () => void;
}

let ws: WebSocket | null = null;
let reconnectAttempts = 0;

// Exponential backoff: configurable base delay capped at configurable max
function getReconnectDelay(attempt: number): number {
  const delay = Math.min(
    frontendConfig.wsBaseReconnectDelayMs * Math.pow(2, attempt),
    frontendConfig.wsMaxReconnectDelayMs
  );
  return delay;
}

export const useWsStore = create<WsStore>((set) => ({
  connected: false,
  lastEvent: null,
  connect() {
    if (ws) return;
    const url = frontendConfig.wsUrl + '/ws';
    ws = new WebSocket(url);

    ws.onopen = () => {
      set({ connected: true });
      reconnectAttempts = 0; // Reset counter on successful connection
    };
    ws.onclose = () => {
      set({ connected: false });
      ws = null;
      
      // Exponential backoff reconnection (max attempts configurable, then stop)
      if (reconnectAttempts < frontendConfig.wsMaxReconnectAttempts) {
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
