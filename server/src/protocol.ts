// ============ CLIENT → SERVER ============

export interface JoinQueueMsg {
  type: 'join_queue';
  name: string;
  avatarUrl?: string;
  initData?: string;
}

export interface CreateRoomMsg {
  type: 'create_room';
  name: string;
  avatarUrl?: string;
  initData?: string;
}

export interface JoinRoomMsg {
  type: 'join_room';
  roomId: string;
  name: string;
  avatarUrl?: string;
  initData?: string;
}

export interface PositionMsg {
  type: 'position';
  y: number;
  boostsUsed: number;
}

export interface BoostMsg {
  type: 'boost';
}

export interface FinishedMsg {
  type: 'finished';
  time: number;
}

export interface ReadyMsg {
  type: 'ready';
}

export type ClientMessage =
  | JoinQueueMsg
  | CreateRoomMsg
  | JoinRoomMsg
  | PositionMsg
  | BoostMsg
  | FinishedMsg
  | ReadyMsg;

// ============ SERVER → CLIENT ============

export interface RoomJoinedMsg {
  type: 'room_joined';
  roomId: string;
  slot: number;
  seed: number;
  players: PlayerInfo[];
}

export interface PlayerInfo {
  slot: number;
  name: string;
  avatarUrl?: string;
  ready?: boolean;
}

export interface PlayerJoinedMsg {
  type: 'player_joined';
  slot: number;
  name: string;
  avatarUrl?: string;
}

export interface PlayerLeftMsg {
  type: 'player_left';
  slot: number;
}

export interface PlayerReadyMsg {
  type: 'player_ready';
  slot: number;
}

export interface CountdownMsg {
  type: 'countdown';
  seconds: number;
}

export interface RaceStartMsg {
  type: 'race_start';
  serverTime: number;
}

export interface PositionsMsg {
  type: 'positions';
  players: { slot: number; y: number; boostsUsed: number }[];
}

export interface PlayerFinishedMsg {
  type: 'player_finished';
  slot: number;
  place: number;
}

export interface RaceEndMsg {
  type: 'race_end';
  finishOrder: { slot: number; place: number; name: string }[];
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export interface QueueUpdateMsg {
  type: 'queue_update';
  count: number;
}

export type ServerMessage =
  | RoomJoinedMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | PlayerReadyMsg
  | CountdownMsg
  | RaceStartMsg
  | PositionsMsg
  | PlayerFinishedMsg
  | RaceEndMsg
  | ErrorMsg
  | QueueUpdateMsg;
