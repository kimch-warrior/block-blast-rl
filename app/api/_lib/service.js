import { createGame, placements, place, isGameOver } from "../../../public/game/engine.js";

export class ApiError extends Error {
  constructor(status, code, message, snapshot = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.snapshot = snapshot;
  }
}

const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const fail = (code, message) => { throw new ApiError(400, code, message); };

export function validateSeed(seed) {
  if (seed !== undefined && !integerIn(seed, 1, 2147483646)) {
    fail("INVALID_SEED", "seed는 1~2147483646 정수여야 합니다.");
  }
}

function validateCommand(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("INVALID_BODY", "JSON 객체를 보내주세요.");
  if (!integerIn(body.version, 1, Number.MAX_SAFE_INTEGER)) fail("INVALID_VERSION", "현재 게임의 version이 필요합니다.");
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !/^[\w.:-]{1,128}$/.test(body.requestId))) {
    fail("INVALID_REQUEST_ID", "requestId는 1~128자의 영문, 숫자, 밑줄, 점, 콜론, 하이픈을 사용할 수 있습니다.");
  }
}

export function createGameService(store, options = {}) {
  const makeId = options.makeId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  function snapshot(row) {
    const state = JSON.parse(row.stateJson);
    return {
      id: row.id, version: row.version, state, gameOver: isGameOver(state),
      canUndo: JSON.parse(row.historyJson).length > 0,
      legalMoves: state.tray.map((id, slot) => ({ slot, id, positions: id === -1 ? [] : placements(state.board, id) })),
      lastMove: row.lastMoveJson ? JSON.parse(row.lastMoveJson) : null,
      updatedAt: row.updatedAt,
    };
  }

  async function find(id, ownerId) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ApiError(404, "GAME_NOT_FOUND", "게임을 찾을 수 없습니다.");
    const row = await store.find(id, ownerId);
    if (!row) throw new ApiError(404, "GAME_NOT_FOUND", "게임을 찾을 수 없습니다.");
    return row;
  }

  return {
    async create(ownerId, body = {}) {
      if (!body || typeof body !== "object" || Array.isArray(body)) fail("INVALID_BODY", "JSON 객체를 보내주세요.");
      validateSeed(body.seed);
      const time = now();
      const row = {
        id: makeId(), ownerId, version: 1,
        stateJson: JSON.stringify(createGame(body.seed)), historyJson: "[]", lastMoveJson: null,
        lastRequestId: null, lastRequestAction: null, createdAt: time, updatedAt: time,
      };
      await store.insert(row);
      return snapshot(row);
    },
    async get(ownerId, id) { return snapshot(await find(id, ownerId)); },
    async command(ownerId, id, action, body) {
      validateCommand(body);
      if (action === "place") {
        if (!integerIn(body.slot, 0, 2) || !integerIn(body.row, 0, 7) || !integerIn(body.col, 0, 7)) {
          fail("INVALID_PLACEMENT", "slot은 0~2, row와 col은 0~7 정수여야 합니다.");
        }
      } else if (action === "reset") validateSeed(body.seed);
      else if (action !== "undo") throw new ApiError(404, "ENDPOINT_NOT_FOUND", "API를 찾을 수 없습니다.");

      const signature = JSON.stringify({ action, version: body.version, slot: body.slot, row: body.row, col: body.col, seed: body.seed });
      const row = await find(id, ownerId);
      if (body.requestId && row.lastRequestId === body.requestId) {
        if (row.lastRequestAction !== signature) throw new ApiError(409, "REQUEST_ID_CONFLICT", "같은 requestId를 다른 명령에 사용할 수 없습니다.", snapshot(row));
        return snapshot(row);
      }
      if (row.version !== body.version) throw new ApiError(409, "VERSION_CONFLICT", "게임 상태가 변경되었습니다. 최신 상태에서 다시 시도해주세요.", snapshot(row));

      let state = JSON.parse(row.stateJson);
      const history = JSON.parse(row.historyJson);
      let lastMove = null;
      if (action === "place") {
        const result = place(state, body.slot, body.row, body.col);
        if (!result) throw new ApiError(422, "ILLEGAL_MOVE", "이 위치에 블록을 놓을 수 없습니다.", snapshot(row));
        history.push(state);
        if (history.length > 20) history.shift();
        state = result.state;
        lastMove = { slot: body.slot, row: body.row, col: body.col, points: result.points,
          clearedRows: result.clearedRows, clearedCols: result.clearedCols, refilled: result.refilled,
          clearScreen: result.clearScreen, clearScreenBonus: result.clearScreenBonus,
          scoreBreakdown: result.scoreBreakdown };
      } else if (action === "undo") {
        if (!history.length) throw new ApiError(422, "NO_UNDO", "되돌릴 수 있는 수가 없습니다.", snapshot(row));
        state = history.pop();
      } else {
        state = createGame(body.seed);
        history.length = 0;
      }
      const next = { ...row, version: row.version + 1, stateJson: JSON.stringify(state), historyJson: JSON.stringify(history),
        lastMoveJson: lastMove ? JSON.stringify(lastMove) : null, lastRequestId: body.requestId ?? null,
        lastRequestAction: body.requestId ? signature : null, updatedAt: now() };
      if (!(await store.update(next, row.version))) {
        const latest = await find(id, ownerId);
        if (body.requestId && latest.lastRequestId === body.requestId && latest.lastRequestAction === signature) return snapshot(latest);
        throw new ApiError(409, "VERSION_CONFLICT", "다른 요청이 먼저 처리되었습니다. 최신 상태에서 다시 시도해주세요.", snapshot(latest));
      }
      return snapshot(next);
    },
  };
}
