import { create } from 'zustand';

interface WsStore {
  connected: boolean;
  lastEvent: Record<string, unknown> | null;
  connect: () => void;
}

let ws: WebSocket | null = null;

export const useWsStore = create<WsStore>((set) => ({
  connected: false,
  lastEvent: null,
  connect() {
    if (ws) return;
    const url = (import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001') + '/ws';
    ws = new WebSocket(url);

    ws.onopen = () => set({ connected: true });
    ws.onclose = () => {
      set({ connected: false });
      ws = null;
      // Reconnect after 3s
      setTimeout(() => useWsStore.getState().connect(), 3000);
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        set({ lastEvent: data });
      } catch (_) {}
    };
  },
}));
