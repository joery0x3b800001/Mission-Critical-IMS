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
  const message = JSON.stringify(payload);
  const deadClients: WebSocket[] = [];

  for (const client of clients) {
    try {
      // Double-check connection state
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      } else if (client.readyState !== WebSocket.CONNECTING) {
        // Mark for removal if not open or connecting
        deadClients.push(client);
      }
    } catch (err) {
      console.error('[Broadcaster] Failed to send to client:', (err as Error).message);
      deadClients.push(client);
    }
  }

  // Clean up dead connections
  for (const client of deadClients) {
    clients.delete(client);
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
