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

      // Validate Telegram initData (soft check — log only, don't block)
      // TODO: enforce after testing
      if (env.TELEGRAM_BOT_TOKEN) {
        const initData = url.searchParams.get('initData') || '';
        const { valid } = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
        if (!valid) {
          console.warn('Invalid initData for', url.pathname);
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

      // Validate Telegram initData (soft check — log only, don't block)
      // TODO: enforce after testing
      if (env.TELEGRAM_BOT_TOKEN) {
        const initData = url.searchParams.get('initData') || '';
        const { valid } = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
        if (!valid) {
          console.warn('Invalid initData for', url.pathname);
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

    // Telegram Bot Webhook
    if (url.pathname === '/bot/webhook' && request.method === 'POST') {
      try {
        const update = await request.json() as any;
        if (update.message?.text) {
          const text = update.message.text as string;
          const chatId = update.message.chat.id;

          if (text.startsWith('/start')) {
            const parts = text.split(' ');
            const roomCode = parts[1];
            const webAppUrl = 'https://ball-drop.pages.dev' + (roomCode ? `?room=${roomCode}#room=${roomCode}` : '');

            const keyboard = roomCode
              ? { inline_keyboard: [[{ text: 'Join Game', web_app: { url: webAppUrl } }]] }
              : { inline_keyboard: [[{ text: 'Play', web_app: { url: 'https://ball-drop.pages.dev' } }]] };

            const msgText = roomCode
              ? `You've been invited to Ball Drop Race!\nRoom: ${roomCode}`
              : 'Welcome to Ball Drop Race!';

            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: msgText,
                reply_markup: keyboard,
              }),
            });
          }
        }
      } catch {}
      return new Response('ok', { headers: corsHeaders });
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
