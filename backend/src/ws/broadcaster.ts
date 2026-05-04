import { WebSocket } from 'ws';

const clients = new Set<WebSocket>();

export function registerClient(ws: WebSocket): void {
  clients.add(ws);
  ws.on('close', () => {
    clients.delete(ws);
  });
  ws.on('error', (err) => {
    console.error('[WebSocket] Client error:', err.message);
    clients.delete(ws);  // Remove on error too
  });
}

export function broadcastUpdate(payload: Record<string, unknown>): void {
  // Pre-serialize message once instead of in every loop iteration (memory optimization)
  let message: string | null = null;

  for (const client of clients) {
    try {
      // Double-check connection state
      if (client.readyState === WebSocket.OPEN) {
        // Lazy-serialize message only if there are open clients
        if (!message) message = JSON.stringify(payload);
        client.send(message);
      } else if (client.readyState !== WebSocket.CONNECTING) {
        // Remove dead connections immediately (memory efficiency)
        clients.delete(client);
      }
    } catch (err) {
      console.error('[Broadcaster] Failed to send to client:', (err as Error).message);
      // Remove failed client immediately
      clients.delete(client);
    }
  }
}

// Graceful shutdown function
export async function closeAllConnections(): Promise<void> {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, 'Server shutting down');
    }
  }
  clients.clear();
}
