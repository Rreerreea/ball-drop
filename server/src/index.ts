import { GameRoom } from './game-room';
import { MatchmakingQueue } from './matchmaking';
import { validateInitData } from './telegram-auth';

export { GameRoom, MatchmakingQueue };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  MATCHMAKING: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // WebSocket: Quick Play matchmaking
    if (url.pathname === '/ws/quickplay') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426, headers: corsHeaders });
      }

      // Validate Telegram initData if bot token is configured
      if (env.TELEGRAM_BOT_TOKEN) {
        const initData = url.searchParams.get('initData') || '';
        const { valid } = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
        if (!valid) {
          return new Response('Invalid initData', { status: 403, headers: corsHeaders });
        }
      }

      const id = env.MATCHMAKING.idFromName('global-queue');
      const stub = env.MATCHMAKING.get(id);
      return stub.fetch(request);
    }

    // WebSocket: Join specific room
    if (url.pathname.startsWith('/ws/room/')) {
      const roomId = url.pathname.split('/ws/room/')[1];
      if (!roomId) {
        return new Response('Missing roomId', { status: 400, headers: corsHeaders });
      }
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426, headers: corsHeaders });
      }

      // Validate Telegram initData if bot token is configured
      if (env.TELEGRAM_BOT_TOKEN) {
        const initData = url.searchParams.get('initData') || '';
        const { valid } = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
        if (!valid) {
          return new Response('Invalid initData', { status: 403, headers: corsHeaders });
        }
      }

      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // REST: Create private room
    if (url.pathname === '/api/create-room' && request.method === 'POST') {
      const roomId = generateRoomId();
      return new Response(JSON.stringify({ roomId }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('OK', { headers: corsHeaders });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
