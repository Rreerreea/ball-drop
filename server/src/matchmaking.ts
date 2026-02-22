import type { Env } from './index';
import type { ServerMessage } from './protocol';

interface QueuedPlayer {
  ws: WebSocket;
  name: string;
  avatarUrl?: string;
  joinedAt: number;
}

const MAX_PLAYERS = 8;
const QUEUE_TIMEOUT_MS = 15_000; // Start with fewer after 15s
const QUEUE_CHECK_INTERVAL = 1000;
const MIN_PLAYERS = 2;

export class MatchmakingQueue {
  private state: DurableObjectState;
  private env!: Env;
  private queue: QueuedPlayer[] = [];
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server);

    const name = url.searchParams.get('name') || 'Player';
    const avatarUrl = url.searchParams.get('avatar') || undefined;

    const player: QueuedPlayer = {
      ws: server,
      name: name.substring(0, 20),
      avatarUrl,
      joinedAt: Date.now(),
    };

    this.queue.push(player);
    this.broadcastQueueUpdate();

    // Start checking if not already
    if (!this.checkInterval) {
      this.checkInterval = setInterval(() => {
        this.checkQueue();
      }, QUEUE_CHECK_INTERVAL);
    }

    // Check immediately if we have enough
    this.checkQueue();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketClose(ws: WebSocket) {
    this.removeFromQueue(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.removeFromQueue(ws);
  }

  async webSocketMessage(_ws: WebSocket, _data: string | ArrayBuffer) {
    // Matchmaking queue doesn't process messages from clients
  }

  private removeFromQueue(ws: WebSocket) {
    this.queue = this.queue.filter(p => p.ws !== ws);
    this.broadcastQueueUpdate();

    if (this.queue.length === 0 && this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private checkQueue() {
    // If we have 8, start immediately
    if (this.queue.length >= MAX_PLAYERS) {
      const group = this.queue.splice(0, MAX_PLAYERS);
      this.createRoom(group);
      return;
    }

    // If oldest player waited > 15s and we have at least MIN_PLAYERS, start
    if (this.queue.length >= MIN_PLAYERS) {
      const oldest = this.queue[0];
      if (Date.now() - oldest.joinedAt > QUEUE_TIMEOUT_MS) {
        const group = this.queue.splice(0, Math.min(this.queue.length, MAX_PLAYERS));
        this.createRoom(group);
        return;
      }
    }
  }

  private createRoom(group: QueuedPlayer[]) {
    const roomId = this.generateRoomId();

    // Send redirect to each player — they'll connect to the GameRoom DO
    group.forEach(player => {
      this.send(player.ws, {
        type: 'room_joined',
        roomId,
        slot: -1,
        seed: 0,
        players: [],
      });
      try {
        player.ws.close(1000, 'Room created');
      } catch {}
    });

    this.broadcastQueueUpdate();
  }

  private broadcastQueueUpdate() {
    const msg: ServerMessage = {
      type: 'queue_update',
      count: this.queue.length,
    };
    const data = JSON.stringify(msg);
    for (const player of this.queue) {
      try { player.ws.send(data); } catch {}
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  private generateRoomId(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }
}
