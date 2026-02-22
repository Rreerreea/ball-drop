import { randomSeed } from './seeded-random';
import type {
  ClientMessage,
  ServerMessage,
  PlayerInfo,
} from './protocol';

type RoomState = 'WAITING' | 'COUNTDOWN' | 'PLAYING' | 'FINISHED';

interface PlayerSlot {
  ws: WebSocket;
  slot: number;
  name: string;
  avatarUrl?: string;
  lastY: number;
  boostsUsed: number;
  finished: boolean;
  place: number;
  lastPositionTime: number;
  positionCount: number;
  ready: boolean;
}

const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 5000;
const MAX_RACE_MS = 90_000;
const AFTER_FIRST_FINISH_MS = 30_000;
const POSITION_BROADCAST_INTERVAL = 100; // ~10Hz
const MIN_FINISH_TIME_MS = 5000;
const MAX_BOOSTS = 3;
const MAX_POSITION_RATE = 30; // max messages per second
const MIN_PLAYERS_TO_START = 2;

export class GameRoom {
  private state: DurableObjectState;
  private players: Map<WebSocket, PlayerSlot> = new Map();
  private slots: (PlayerSlot | null)[] = new Array(MAX_PLAYERS).fill(null);
  private roomState: RoomState = 'WAITING';
  private seed: number = 0;
  private raceStartTime: number = 0;
  private finishOrder: { slot: number; name: string }[] = [];
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  private raceTimeout: ReturnType<typeof setTimeout> | null = null;
  private afterFinishTimeout: ReturnType<typeof setTimeout> | null = null;
  private isPrivate: boolean = false;
  private expectedPlayers: number = 0;
  private fromMatchmaking: boolean = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.isPrivate = url.searchParams.get('private') === '1';
    const expected = parseInt(url.searchParams.get('expected') || '0');
    if (expected > 0) this.expectedPlayers = expected;
    if (url.searchParams.get('matchmaking') === '1') this.fromMatchmaking = true;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server);
    this.handleConnect(server, url);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== 'string') return;
    try {
      const msg = JSON.parse(data) as ClientMessage;
      this.handleMessage(ws, msg);
    } catch {
      // Ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.handleDisconnect(ws);
  }

  private handleConnect(ws: WebSocket, url: URL) {
    const name = url.searchParams.get('name') || 'Player';
    const avatarUrl = url.searchParams.get('avatar') || undefined;

    if (this.roomState !== 'WAITING') {
      this.send(ws, { type: 'error', message: 'Race already started' });
      ws.close(1000, 'Race already started');
      return;
    }

    // Find free slot
    const slotIdx = this.slots.findIndex(s => s === null);
    if (slotIdx === -1) {
      this.send(ws, { type: 'error', message: 'Room is full' });
      ws.close(1000, 'Room full');
      return;
    }

    const player: PlayerSlot = {
      ws,
      slot: slotIdx,
      name: name.substring(0, 20),
      avatarUrl,
      lastY: 0,
      boostsUsed: 0,
      finished: false,
      place: 0,
      lastPositionTime: 0,
      positionCount: 0,
      ready: false,
    };

    this.players.set(ws, player);
    this.slots[slotIdx] = player;

    // Generate seed once (first player triggers)
    if (this.seed === 0) {
      this.seed = randomSeed();
    }

    // Send room_joined to new player with current player list
    const existingPlayers: PlayerInfo[] = [];
    this.slots.forEach(s => {
      if (s && s !== player) {
        existingPlayers.push({ slot: s.slot, name: s.name, avatarUrl: s.avatarUrl, ready: s.ready });
      }
    });

    this.send(ws, {
      type: 'room_joined',
      roomId: this.state.id.toString(),
      slot: slotIdx,
      seed: this.seed,
      players: existingPlayers,
    });

    // Notify others about new player
    this.broadcast({
      type: 'player_joined',
      slot: slotIdx,
      name: player.name,
      avatarUrl: player.avatarUrl,
    }, ws);

    // All players must manually ready up
  }

  private handleMessage(ws: WebSocket, msg: ClientMessage) {
    const player = this.players.get(ws);
    if (!player) return;

    switch (msg.type) {
      case 'ready':
        this.handleReady(player);
        break;
      case 'position':
        this.handlePosition(player, msg.y, msg.boostsUsed);
        break;
      case 'boost':
        this.handleBoost(player);
        break;
      case 'finished':
        this.handleFinished(player, msg.time);
        break;
    }
  }

  private handleReady(player: PlayerSlot) {
    if (this.roomState !== 'WAITING') return;
    if (player.ready) return;

    player.ready = true;
    this.broadcast({ type: 'player_ready', slot: player.slot });
    this.checkAllReady();
  }

  private checkAllReady() {
    if (this.roomState !== 'WAITING') return;
    const playerCount = this.getPlayerCount();
    if (playerCount < MIN_PLAYERS_TO_START) return;

    const allReady = Array.from(this.players.values()).every(p => p.ready);
    if (allReady) {
      this.startCountdown();
    }
  }

  private handlePosition(player: PlayerSlot, y: number, boostsUsed: number) {
    if (this.roomState !== 'PLAYING') return;
    if (player.finished) return;

    // Rate limit: max 30 position updates per second
    const now = Date.now();
    if (now - player.lastPositionTime < 1000 / MAX_POSITION_RATE) return;
    player.lastPositionTime = now;

    player.lastY = y;
    player.boostsUsed = Math.min(boostsUsed, MAX_BOOSTS);
  }

  private handleBoost(player: PlayerSlot) {
    if (this.roomState !== 'PLAYING') return;
    if (player.finished) return;
    if (player.boostsUsed >= MAX_BOOSTS) return;
    player.boostsUsed++;
  }

  private handleFinished(player: PlayerSlot, clientTime: number) {
    if (this.roomState !== 'PLAYING') return;
    if (player.finished) return;

    // Anti-cheat: finish time must be > 5s
    const elapsed = Date.now() - this.raceStartTime;
    if (elapsed < MIN_FINISH_TIME_MS) return;

    player.finished = true;
    this.finishOrder.push({ slot: player.slot, name: player.name });
    player.place = this.finishOrder.length;

    // Broadcast finish
    this.broadcast({
      type: 'player_finished',
      slot: player.slot,
      place: player.place,
    });

    // Start after-finish timeout on first finish
    if (this.finishOrder.length === 1 && !this.afterFinishTimeout) {
      this.afterFinishTimeout = setTimeout(() => {
        this.endRace();
      }, AFTER_FIRST_FINISH_MS);
    }

    // All finished?
    const activePlayers = Array.from(this.players.values()).filter(p => !p.finished);
    if (activePlayers.length === 0) {
      this.endRace();
    }
  }

  private handleDisconnect(ws: WebSocket) {
    const player = this.players.get(ws);
    if (!player) return;

    this.players.delete(ws);
    this.slots[player.slot] = null;

    if (this.roomState === 'WAITING' || this.roomState === 'COUNTDOWN') {
      // In lobby — broadcast leave
      this.broadcast({ type: 'player_left', slot: player.slot });

      // If room is now empty, clean up
      if (this.getPlayerCount() === 0) {
        this.cleanup();
      }
    } else if (this.roomState === 'PLAYING') {
      // During race — auto-place last
      if (!player.finished) {
        player.finished = true;
        this.finishOrder.push({ slot: player.slot, name: player.name });
        player.place = this.finishOrder.length;

        this.broadcast({
          type: 'player_left',
          slot: player.slot,
        });
      }

      // Check if all remaining have finished
      const activePlayers = Array.from(this.players.values()).filter(p => !p.finished);
      if (activePlayers.length === 0) {
        this.endRace();
      }
    }
  }

  startCountdown() {
    if (this.roomState !== 'WAITING') return;
    this.roomState = 'COUNTDOWN';

    // Send countdown ticks
    this.broadcast({ type: 'countdown', seconds: 5 });
    setTimeout(() => this.broadcast({ type: 'countdown', seconds: 4 }), 1000);
    setTimeout(() => this.broadcast({ type: 'countdown', seconds: 3 }), 2000);
    setTimeout(() => this.broadcast({ type: 'countdown', seconds: 2 }), 3000);
    setTimeout(() => this.broadcast({ type: 'countdown', seconds: 1 }), 4000);

    setTimeout(() => {
      this.startRace();
    }, COUNTDOWN_MS);
  }

  private startRace() {
    this.roomState = 'PLAYING';
    this.raceStartTime = Date.now();

    this.broadcast({
      type: 'race_start',
      serverTime: this.raceStartTime,
    });

    // Position relay broadcast loop (~10Hz)
    this.broadcastInterval = setInterval(() => {
      this.broadcastPositions();
    }, POSITION_BROADCAST_INTERVAL);

    // Max race timeout
    this.raceTimeout = setTimeout(() => {
      this.endRace();
    }, MAX_RACE_MS);
  }

  private broadcastPositions() {
    if (this.roomState !== 'PLAYING') return;

    const positions = Array.from(this.players.values())
      .filter(p => !p.finished)
      .map(p => ({
        slot: p.slot,
        y: p.lastY,
        boostsUsed: p.boostsUsed,
      }));

    if (positions.length > 0) {
      this.broadcast({ type: 'positions', players: positions });
    }
  }

  private endRace() {
    if (this.roomState === 'FINISHED') return;
    this.roomState = 'FINISHED';

    // Clear timers
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    if (this.raceTimeout) clearTimeout(this.raceTimeout);
    if (this.afterFinishTimeout) clearTimeout(this.afterFinishTimeout);

    // Auto-finish any remaining players
    for (const player of this.players.values()) {
      if (!player.finished) {
        player.finished = true;
        this.finishOrder.push({ slot: player.slot, name: player.name });
        player.place = this.finishOrder.length;
      }
    }

    // Broadcast race end
    this.broadcast({
      type: 'race_end',
      finishOrder: this.finishOrder.map((f, i) => ({
        slot: f.slot,
        place: i + 1,
        name: f.name,
      })),
    });

    // Close all connections after a delay
    setTimeout(() => {
      for (const player of this.players.values()) {
        try { player.ws.close(1000, 'Race ended'); } catch {}
      }
      this.cleanup();
    }, 5000);
  }

  private cleanup() {
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    if (this.raceTimeout) clearTimeout(this.raceTimeout);
    if (this.afterFinishTimeout) clearTimeout(this.afterFinishTimeout);
    this.players.clear();
    this.slots.fill(null);
  }

  private getPlayerCount(): number {
    return this.slots.filter(s => s !== null).length;
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  private broadcast(msg: ServerMessage, exclude?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const player of this.players.values()) {
      if (player.ws !== exclude) {
        try { player.ws.send(data); } catch {}
      }
    }
  }
}
