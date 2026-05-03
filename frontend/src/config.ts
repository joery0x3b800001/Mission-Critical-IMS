// Frontend Configuration
// These values can be overridden via environment variables (VITE_*)

export const frontendConfig = {
  // WebSocket Configuration
  wsUrl: import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001',
  
  // Reconnection Configuration
  wsBaseReconnectDelayMs: parseInt(import.meta.env.VITE_WS_BASE_RECONNECT_DELAY_MS ?? '1000', 10),
  wsMaxReconnectDelayMs: parseInt(import.meta.env.VITE_WS_MAX_RECONNECT_DELAY_MS ?? '60000', 10),
  wsMaxReconnectAttempts: parseInt(import.meta.env.VITE_WS_MAX_RECONNECT_ATTEMPTS ?? '10', 10),
};
