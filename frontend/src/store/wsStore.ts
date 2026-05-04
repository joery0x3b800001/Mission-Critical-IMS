import { create } from 'zustand';
import { frontendConfig } from '../config';

interface WsStore {
  connected: boolean;
  lastEvent: Record<string, unknown> | null;
  connect: () => void;
}

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

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
    
    // Clear any pending reconnect timeout
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    
    const url = frontendConfig.wsUrl + '/ws';
    ws = new WebSocket(url);

    ws.onopen = () => {
      set({ connected: true });
      reconnectAttempts = 0; // Reset counter on successful connection
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
    };
    ws.onclose = () => {
      set({ connected: false });
      // Clean up old websocket reference
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws = null;
      }
      
      // Exponential backoff reconnection (max attempts configurable, then stop)
      if (reconnectAttempts < frontendConfig.wsMaxReconnectAttempts) {
        const delay = getReconnectDelay(reconnectAttempts);
        reconnectAttempts++;
        reconnectTimeout = setTimeout(() => useWsStore.getState().connect(), delay);
      } else {
        console.warn('[WebSocket] Max reconnection attempts reached. Giving up.');
      }
    };
    ws.onerror = () => {
      // Error handler to prevent unhandled errors
      console.error('[WebSocket] Connection error');
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        set({ lastEvent: data });
      } catch (_) {}
    };
  },
}));
