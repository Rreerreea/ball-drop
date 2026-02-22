var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-aGxkVa/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/seeded-random.ts
function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}
__name(randomSeed, "randomSeed");

// src/game-room.ts
var MAX_PLAYERS = 8;
var COUNTDOWN_MS = 3e3;
var MAX_RACE_MS = 9e4;
var AFTER_FIRST_FINISH_MS = 3e4;
var POSITION_BROADCAST_INTERVAL = 100;
var MIN_FINISH_TIME_MS = 5e3;
var MAX_BOOSTS = 3;
var MAX_POSITION_RATE = 30;
var MIN_PLAYERS_TO_START = 2;
var GameRoom = class {
  state;
  players = /* @__PURE__ */ new Map();
  slots = new Array(MAX_PLAYERS).fill(null);
  roomState = "WAITING";
  seed = 0;
  raceStartTime = 0;
  finishOrder = [];
  broadcastInterval = null;
  raceTimeout = null;
  afterFinishTimeout = null;
  isPrivate = false;
  expectedPlayers = 0;
  fromMatchmaking = false;
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const url = new URL(request.url);
    this.isPrivate = url.searchParams.get("private") === "1";
    const expected = parseInt(url.searchParams.get("expected") || "0");
    if (expected > 0)
      this.expectedPlayers = expected;
    if (url.searchParams.get("matchmaking") === "1")
      this.fromMatchmaking = true;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    this.handleConnect(server, url);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    if (typeof data !== "string")
      return;
    try {
      const msg = JSON.parse(data);
      this.handleMessage(ws, msg);
    } catch {
    }
  }
  async webSocketClose(ws) {
    this.handleDisconnect(ws);
  }
  async webSocketError(ws) {
    this.handleDisconnect(ws);
  }
  handleConnect(ws, url) {
    const name = url.searchParams.get("name") || "Player";
    const avatarUrl = url.searchParams.get("avatar") || void 0;
    if (this.roomState !== "WAITING") {
      this.send(ws, { type: "error", message: "Race already started" });
      ws.close(1e3, "Race already started");
      return;
    }
    const slotIdx = this.slots.findIndex((s) => s === null);
    if (slotIdx === -1) {
      this.send(ws, { type: "error", message: "Room is full" });
      ws.close(1e3, "Room full");
      return;
    }
    const player = {
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
      ready: false
    };
    this.players.set(ws, player);
    this.slots[slotIdx] = player;
    if (this.seed === 0) {
      this.seed = randomSeed();
    }
    const existingPlayers = [];
    this.slots.forEach((s) => {
      if (s && s !== player) {
        existingPlayers.push({ slot: s.slot, name: s.name, avatarUrl: s.avatarUrl, ready: s.ready });
      }
    });
    this.send(ws, {
      type: "room_joined",
      roomId: this.state.id.toString(),
      slot: slotIdx,
      seed: this.seed,
      players: existingPlayers
    });
    this.broadcast({
      type: "player_joined",
      slot: slotIdx,
      name: player.name,
      avatarUrl: player.avatarUrl
    }, ws);
    if (this.fromMatchmaking) {
      player.ready = true;
      this.checkAllReady();
    }
  }
  handleMessage(ws, msg) {
    const player = this.players.get(ws);
    if (!player)
      return;
    switch (msg.type) {
      case "ready":
        this.handleReady(player);
        break;
      case "position":
        this.handlePosition(player, msg.y, msg.boostsUsed);
        break;
      case "boost":
        this.handleBoost(player);
        break;
      case "finished":
        this.handleFinished(player, msg.time);
        break;
    }
  }
  handleReady(player) {
    if (this.roomState !== "WAITING")
      return;
    if (player.ready)
      return;
    player.ready = true;
    this.broadcast({ type: "player_ready", slot: player.slot });
    this.checkAllReady();
  }
  checkAllReady() {
    if (this.roomState !== "WAITING")
      return;
    const playerCount = this.getPlayerCount();
    if (playerCount < MIN_PLAYERS_TO_START)
      return;
    const allReady = Array.from(this.players.values()).every((p) => p.ready);
    if (allReady) {
      this.startCountdown();
    }
  }
  handlePosition(player, y, boostsUsed) {
    if (this.roomState !== "PLAYING")
      return;
    if (player.finished)
      return;
    const now = Date.now();
    if (now - player.lastPositionTime < 1e3 / MAX_POSITION_RATE)
      return;
    player.lastPositionTime = now;
    player.lastY = y;
    player.boostsUsed = Math.min(boostsUsed, MAX_BOOSTS);
  }
  handleBoost(player) {
    if (this.roomState !== "PLAYING")
      return;
    if (player.finished)
      return;
    if (player.boostsUsed >= MAX_BOOSTS)
      return;
    player.boostsUsed++;
  }
  handleFinished(player, clientTime) {
    if (this.roomState !== "PLAYING")
      return;
    if (player.finished)
      return;
    const elapsed = Date.now() - this.raceStartTime;
    if (elapsed < MIN_FINISH_TIME_MS)
      return;
    player.finished = true;
    this.finishOrder.push({ slot: player.slot, name: player.name });
    player.place = this.finishOrder.length;
    this.broadcast({
      type: "player_finished",
      slot: player.slot,
      place: player.place
    });
    if (this.finishOrder.length === 1 && !this.afterFinishTimeout) {
      this.afterFinishTimeout = setTimeout(() => {
        this.endRace();
      }, AFTER_FIRST_FINISH_MS);
    }
    const activePlayers = Array.from(this.players.values()).filter((p) => !p.finished);
    if (activePlayers.length === 0) {
      this.endRace();
    }
  }
  handleDisconnect(ws) {
    const player = this.players.get(ws);
    if (!player)
      return;
    this.players.delete(ws);
    this.slots[player.slot] = null;
    if (this.roomState === "WAITING" || this.roomState === "COUNTDOWN") {
      this.broadcast({ type: "player_left", slot: player.slot });
      if (this.getPlayerCount() === 0) {
        this.cleanup();
      }
    } else if (this.roomState === "PLAYING") {
      if (!player.finished) {
        player.finished = true;
        this.finishOrder.push({ slot: player.slot, name: player.name });
        player.place = this.finishOrder.length;
        this.broadcast({
          type: "player_left",
          slot: player.slot
        });
      }
      const activePlayers = Array.from(this.players.values()).filter((p) => !p.finished);
      if (activePlayers.length === 0) {
        this.endRace();
      }
    }
  }
  startCountdown() {
    if (this.roomState !== "WAITING")
      return;
    this.roomState = "COUNTDOWN";
    this.broadcast({ type: "countdown", seconds: 3 });
    setTimeout(() => this.broadcast({ type: "countdown", seconds: 2 }), 1e3);
    setTimeout(() => this.broadcast({ type: "countdown", seconds: 1 }), 2e3);
    setTimeout(() => {
      this.startRace();
    }, COUNTDOWN_MS);
  }
  startRace() {
    this.roomState = "PLAYING";
    this.raceStartTime = Date.now();
    this.broadcast({
      type: "race_start",
      serverTime: this.raceStartTime
    });
    this.broadcastInterval = setInterval(() => {
      this.broadcastPositions();
    }, POSITION_BROADCAST_INTERVAL);
    this.raceTimeout = setTimeout(() => {
      this.endRace();
    }, MAX_RACE_MS);
  }
  broadcastPositions() {
    if (this.roomState !== "PLAYING")
      return;
    const positions = Array.from(this.players.values()).filter((p) => !p.finished).map((p) => ({
      slot: p.slot,
      y: p.lastY,
      boostsUsed: p.boostsUsed
    }));
    if (positions.length > 0) {
      this.broadcast({ type: "positions", players: positions });
    }
  }
  endRace() {
    if (this.roomState === "FINISHED")
      return;
    this.roomState = "FINISHED";
    if (this.broadcastInterval)
      clearInterval(this.broadcastInterval);
    if (this.raceTimeout)
      clearTimeout(this.raceTimeout);
    if (this.afterFinishTimeout)
      clearTimeout(this.afterFinishTimeout);
    for (const player of this.players.values()) {
      if (!player.finished) {
        player.finished = true;
        this.finishOrder.push({ slot: player.slot, name: player.name });
        player.place = this.finishOrder.length;
      }
    }
    this.broadcast({
      type: "race_end",
      finishOrder: this.finishOrder.map((f, i) => ({
        slot: f.slot,
        place: i + 1,
        name: f.name
      }))
    });
    setTimeout(() => {
      for (const player of this.players.values()) {
        try {
          player.ws.close(1e3, "Race ended");
        } catch {
        }
      }
      this.cleanup();
    }, 5e3);
  }
  cleanup() {
    if (this.broadcastInterval)
      clearInterval(this.broadcastInterval);
    if (this.raceTimeout)
      clearTimeout(this.raceTimeout);
    if (this.afterFinishTimeout)
      clearTimeout(this.afterFinishTimeout);
    this.players.clear();
    this.slots.fill(null);
  }
  getPlayerCount() {
    return this.slots.filter((s) => s !== null).length;
  }
  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
    }
  }
  broadcast(msg, exclude) {
    const data = JSON.stringify(msg);
    for (const player of this.players.values()) {
      if (player.ws !== exclude) {
        try {
          player.ws.send(data);
        } catch {
        }
      }
    }
  }
};
__name(GameRoom, "GameRoom");

// src/matchmaking.ts
var MAX_PLAYERS2 = 8;
var QUEUE_TIMEOUT_MS = 15e3;
var QUEUE_CHECK_INTERVAL = 1e3;
var MIN_PLAYERS = 2;
var MatchmakingQueue = class {
  state;
  env;
  queue = [];
  checkInterval = null;
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    const name = url.searchParams.get("name") || "Player";
    const avatarUrl = url.searchParams.get("avatar") || void 0;
    const player = {
      ws: server,
      name: name.substring(0, 20),
      avatarUrl,
      joinedAt: Date.now()
    };
    this.queue.push(player);
    this.broadcastQueueUpdate();
    if (!this.checkInterval) {
      this.checkInterval = setInterval(() => {
        this.checkQueue();
      }, QUEUE_CHECK_INTERVAL);
    }
    this.checkQueue();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketClose(ws) {
    this.removeFromQueue(ws);
  }
  async webSocketError(ws) {
    this.removeFromQueue(ws);
  }
  async webSocketMessage(_ws, _data) {
  }
  removeFromQueue(ws) {
    this.queue = this.queue.filter((p) => p.ws !== ws);
    this.broadcastQueueUpdate();
    if (this.queue.length === 0 && this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
  checkQueue() {
    if (this.queue.length >= MAX_PLAYERS2) {
      const group = this.queue.splice(0, MAX_PLAYERS2);
      this.createRoom(group);
      return;
    }
    if (this.queue.length >= MIN_PLAYERS) {
      const oldest = this.queue[0];
      if (Date.now() - oldest.joinedAt > QUEUE_TIMEOUT_MS) {
        const group = this.queue.splice(0, Math.min(this.queue.length, MAX_PLAYERS2));
        this.createRoom(group);
        return;
      }
    }
  }
  createRoom(group) {
    const roomId = this.generateRoomId();
    group.forEach((player) => {
      this.send(player.ws, {
        type: "room_joined",
        roomId,
        slot: -1,
        seed: 0,
        players: []
      });
      try {
        player.ws.close(1e3, "Room created");
      } catch {
      }
    });
    this.broadcastQueueUpdate();
  }
  broadcastQueueUpdate() {
    const msg = {
      type: "queue_update",
      count: this.queue.length
    };
    const data = JSON.stringify(msg);
    for (const player of this.queue) {
      try {
        player.ws.send(data);
      } catch {
      }
    }
  }
  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
    }
  }
  generateRoomId() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let id = "";
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }
};
__name(MatchmakingQueue, "MatchmakingQueue");

// src/telegram-auth.ts
async function validateInitData(initData, botToken) {
  if (!initData || !botToken)
    return { valid: false };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash)
      return { valid: false };
    params.delete("hash");
    const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const secretHash = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
    const validationKey = await crypto.subtle.importKey(
      "raw",
      secretHash,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", validationKey, encoder.encode(dataCheckString));
    const computedHash = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (computedHash !== hash)
      return { valid: false };
    const userStr = params.get("user");
    if (userStr) {
      const user = JSON.parse(userStr);
      return { valid: true, user };
    }
    return { valid: true };
  } catch {
    return { valid: false };
  }
}
__name(validateInitData, "validateInitData");

// src/index.ts
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (url.pathname === "/ws/quickplay") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426, headers: corsHeaders });
      }
      if (env.TELEGRAM_BOT_TOKEN) {
        const initData = url.searchParams.get("initData") || "";
        const { valid } = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
        if (!valid) {
          return new Response("Invalid initData", { status: 403, headers: corsHeaders });
        }
      }
      const id = env.MATCHMAKING.idFromName("global-queue");
      const stub = env.MATCHMAKING.get(id);
      return stub.fetch(request);
    }
    if (url.pathname.startsWith("/ws/room/")) {
      const roomId = url.pathname.split("/ws/room/")[1];
      if (!roomId) {
        return new Response("Missing roomId", { status: 400, headers: corsHeaders });
      }
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426, headers: corsHeaders });
      }
      if (env.TELEGRAM_BOT_TOKEN) {
        const initData = url.searchParams.get("initData") || "";
        const { valid } = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
        if (!valid) {
          return new Response("Invalid initData", { status: 403, headers: corsHeaders });
        }
      }
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }
    if (url.pathname === "/api/create-room" && request.method === "POST") {
      const roomId = generateRoomId();
      return new Response(JSON.stringify({ roomId }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
    if (url.pathname === "/health") {
      return new Response("OK", { headers: corsHeaders });
    }
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
__name(generateRoomId, "generateRoomId");

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-aGxkVa/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-aGxkVa/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  GameRoom,
  MatchmakingQueue,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
