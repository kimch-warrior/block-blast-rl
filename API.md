# 로컬 게임 API

웹 화면과 모든 API 클라이언트가 같은 현재 게임을 공유합니다. 인증·쿠키 없이 로컬에서 사용합니다.
이 API는 제작한 웹 게임을 제어하며 원래 Android 앱에 접근하지 않습니다.

CPU 멀티스레드 강화학습용 배치 API(`/api/rl/*`)는 [RL.md](RL.md)를 참고하세요. 기본 256개 환경을 작업자 4개로 실행하며 전체 세션을 합쳐 최대 512개까지 생성합니다. 학습 세션은 일반 게임과 별도로 메모리에 보관합니다.

- 호스트: `http://127.0.0.1:5173`
- 같은 Docker 네트워크: `http://block-blast:3000`
- OpenAPI: `GET /api/openapi.json`

| 요청 | 동작 |
|---|---|
| `GET /api/state` | 현재 웹 게임판 조회. 아직 게임이 없으면 `404 NO_ACTIVE_GAME` |
| `POST /api/place` | 현재 게임에 블록 배치 |
| `POST /api/games` | 새 게임 생성 후 현재 게임으로 지정. `{}` 또는 `{ "seed": 123 }` |
| `GET /api/games/{id}` | 지정 게임 조회 |
| `POST /api/games/{id}/place` | 지정 게임 배치 |
| `POST /api/games/{id}/undo` | 최근 한 수 되돌리기. 최근 20수까지 보관 |
| `POST /api/games/{id}/reset` | 같은 ID로 초기화 |
| `GET /api/shapes` | 일반 모양 51개 조회 |
| `GET /healthz` | 서버와 SQLite 정상 여부 |

## 상태 형식

응답은 `{ id, version, state, gameOver, canUndo, legalMoves, lastMove, updatedAt }`입니다.

- `state.board[row][col]`: 8×8 숫자 배열, `-1` 빈칸, 좌상단 `[0][0]`.
- `state.tray`: `[왼쪽 ID, 가운데 ID, 오른쪽 ID]`, 사용한 슬롯은 `-1`.
- `state.colors`: 슬롯별 색상 번호.
- `state.score`, `state.combo`, `state.moves`, `state.lines`, `state.round`, `state.seed`.
- `state.unEliminateTimes`: 연속으로 소거하지 못한 배치 횟수.
- `state.scoreRulesVersion`: `2` = 원본 10.9.3 기본 클래식 배점.
- `legalMoves`: `[{slot, id, positions:[{row,col},...]}]`.

## 배치

```http
POST /api/place
Content-Type: application/json

{
  "gameId": "조회 응답의 id",
  "version": 1,
  "slot": 0,
  "row": 2,
  "col": 3,
  "requestId": "각 명령의 고유 ID"
}
```

`slot`은 0·1·2, `row`와 `col`은 0~7이며 모양 행렬의 왼쪽 위를 놓는 좌표입니다.
서버가 겹침·경계를 확인하고 행·열 소거, 점수, 세 블록 소진 시 새 세트 생성까지 처리합니다.
브라우저가 보낸 보드나 점수로 상태를 덮어쓰지 않습니다.

변경 요청에는 최신 `version`이 필요합니다. 다른 요청이 먼저 판을 바꾸면 `409`와 최신 상태를 반환합니다.
`gameId`는 `/api/place`에서 선택 사항이지만, 다른 클라이언트가 새 게임을 만들었을 때 잘못된 판을 조작하지 않도록 포함하는 편이 좋습니다.
현재 게임이 달라지면 `409 ACTIVE_GAME_CHANGED`를 반환합니다.
`requestId`를 넣으면 마지막 성공 명령의 동일한 재시도가 중복 실행되지 않습니다.

## 점수 계산

튜토리얼 이후의 원본 기본 클래식 코드를 기준으로 합니다. 원본에서 원격으로 켜지는 trait별 점수 보정은 포함하지 않습니다.

- 배치 점수: 놓은 블록의 칸 수 `N`.
- 소거 줄 수 `L=1`: `10 × C`.
- `L>=2`: `10 × C × L × (L-1)`.
- `L=0`: 소거 점수 0.
- 전체 비우기: 해당 수를 놓기 시작한 `round > 5`이면 300점 추가.
- `C`는 내부 콤보 배수입니다. 소거할 때 한 번 증가하며 무소거 1~2수는 유지, 연속 무소거 3수째 해제합니다.
- 원본 화면 콤보는 `C=2`일 때 `COMBO`, 이후 `COMBO (C-1)`로 표시됩니다. 화면 숫자와 점수의 내부 배수를 혼동하지 마세요.

배치 응답의 `lastMove.scoreBreakdown`은 `{placement, elimination, allClear}`로, 세 값을 더하면 `lastMove.points`가 됩니다.
`lastMove.clearScreen`과 `clearScreenBonus`도 함께 반환합니다.
이전 간소화 점수의 저장 게임은 시작부터 이력이 남아 있으면 점수를 다시 계산하고 보드·블록을 보존합니다.
일부 이력만 남은 게임은 과거 누적 점수를 유지하고 이후 배치부터 새 규칙을 적용합니다. 처리 방식은 `state.scoreMigration.mode`로 확인할 수 있습니다.

## 다른 컨테이너에서 한 수 놓기

Node 24의 내장 `fetch`만 사용합니다. 컨테이너가 `block-blast-local` 네트워크에 연결되어 있어야 합니다.

```js
const base = process.env.BLOCK_BLAST_URL || 'http://block-blast:3000';
const api = async (path, body) => {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error.message), {
    status: response.status, result,
  });
  return result;
};

let game = await api('/api/state');
const piece = game.legalMoves.find(item => item.positions.length > 0);
if (piece) {
  const position = piece.positions[0];
  game = await api('/api/place', {
    gameId: game.id,
    version: game.version,
    slot: piece.slot,
    row: position.row,
    col: position.col,
    requestId: crypto.randomUUID(),
  });
}
console.log(game.state.board, game.state.tray, game.state.score);
```

처음부터 API로 시작하려면 `POST /api/games`에 `{}`를 보내세요. 웹 화면은 새로운 현재 게임을 자동으로 따라갑니다.
오류는 `{ error: { code, message } }` 형태이며, 버전 충돌 `409`와 불가능한 배치 `422`에는 최신 상태도 포함합니다.
