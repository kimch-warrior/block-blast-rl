# CPU 강화학습 환경

화면 없이 게임 상태를 메모리에 두고 Node.js `worker_threads`로 진행합니다. 기본 세션은 256개 환경이며 작업자 4개가 64개씩 나눠 맡습니다. 최대 512개를 만들면 작업자당 128개씩 맡습니다. 한 작업자는 여러 환경을 순차 처리하고, 작업자끼리는 CPU 코어에서 병렬 실행됩니다. GPU와 학습 모델은 포함하지 않습니다.

실행 중인 학습 환경은 메모리에 두고, 백엔드가 적용한 플레이 기록은 별도 영구 저장소에 자동 저장합니다. 실행 세션은 서버 재시작 시 사라지지만 저장 기록은 유지됩니다. 전체 세션을 합쳐 최대 512개 환경을 생성할 수 있으며, 실행 세션을 삭제하면 사용하던 자리가 반환됩니다.

## 실행과 접속

```sh
docker compose up --build -d
```

Windows에서는 이 프로젝트 폴더에서 `start-local.cmd`를 더블클릭하거나 PowerShell에서 `./start-local.cmd`를 실행해도 됩니다. 이 실행 파일은 자신의 폴더로 이동한 뒤 같은 Compose 명령을 실행합니다. 종료는 `stop-local.cmd`입니다.

- 호스트: `http://127.0.0.1:5173`
- 같은 `block-blast-local` Docker 네트워크: `http://block-blast:3000`
- 작업자와 환경 수 확인: `GET /api/rl/stats`

현재 PC의 Docker 할당량으로 기본 4개 CPU 작업자를 사용할 수 있습니다. 작업자 수를 늘린다고 처리량이 비례해서 늘지는 않습니다. 특히 작은 배치는 작업자 간 메시지 전달 비용이 계산보다 커질 수 있습니다.

Compose 서비스 환경 변수로 다음 값을 설정합니다. 변경 후 컨테이너를 다시 생성하면 반영되며, 진행 중인 메모리 세션은 사라집니다.

| 환경 변수 | 기본값 | 허용 범위·의미 |
|---|---|---|
| `RL_WORKERS` | `4` | 작업자 스레드 수 `1~16` |
| `RL_MAX_ENVS` | `512` | 전체 세션의 환경 수 합계 제한 `1~512` |
| `RL_MAX_PENDING` | `16` | 동시에 처리 중인 풀 작업 수 제한 |

`RL_MAX_PENDING`은 CPU 작업자 수가 아닙니다. 제한을 올려도 계산 속도는 증가하지 않으며 여러 클라이언트가 요청을 쌓는 양만 달라집니다. 학습 클라이언트는 한 세션에서 이전 배치의 응답을 받고 다음 배치를 보내면 됩니다.

Node 24가 설치된 호스트에서 의존성 없이 예제를 실행할 수 있습니다.

```sh
node examples/rl-client.mjs --envs 256 --batches 200 --seed 123
```

다른 컨테이너에서는 주소를 지정합니다.

```sh
node examples/rl-client.mjs --url http://block-blast:3000 --envs 256
```

호스트에 Node를 설치하지 않고 실행하려면 프로젝트 폴더에서 이미 실행 중인 게임 컨테이너의 Node를 사용합니다.

```sh
docker compose exec block-blast node examples/rl-client.mjs --url http://127.0.0.1:3000 --envs 256 --batches 200 --mask false
```

`--envs`를 생략하면 256개를 만들며 `--envs 512`로 전체 한도까지 실행할 수 있습니다. 다른 세션이 이미 환경을 사용 중이면 전체 합계 한도에 따라 생성이 거절될 수 있습니다.

예제는 합법 행동 중 하나를 선택하는 시연이며 학습 모델은 아닙니다. 종료된 환경만 초기화하고 실행이 끝나거나 Ctrl+C를 누르면 자신이 생성한 세션을 삭제합니다. 같은 환경 시드와 정책 시드, 규칙 버전으로 실행하면 같은 행동과 결과를 재현할 수 있습니다.

## 화면으로 관찰

```sh
node examples/rl-client.mjs --envs 256 --batches 500 --delay-ms 100
```

실행 직후 출력되는 `viewer` 주소를 브라우저에서 열면 0번 환경을 볼 수 있습니다.

```text
http://127.0.0.1:5173/game/index.html?session=세션ID&env=0
```

컨테이너에서 실행하면서 관찰하려면 다음 명령을 사용합니다. 컨테이너 내부의 API 접속 포트는 `3000`이지만, Windows 브라우저에서는 위와 같이 호스트 포트 `5173`으로 여세요. 컨테이너 시연이 출력하는 `viewer` 주소의 포트 `3000`을 `5173`으로 바꾸고 세션 ID와 `env`는 그대로 사용합니다.

```sh
docker compose exec block-blast node examples/rl-client.mjs --url http://127.0.0.1:3000 --envs 256 --batches 500 --mask false --delay-ms 100
```

`env`를 0부터 `numEnvs - 1` 사이 값으로 바꾸면 다른 환경을 관찰합니다. 이 화면은 학습 환경을 읽기만 하며, 사람이 블록을 놓아 학습 진행에 끼어들지 않습니다. 빠르게 진행하면 모든 중간 수가 화면에 보이지 않을 수 있습니다. 기록 조회와 시드 기반 재생 검증은 아래 API를 사용합니다. 브라우저의 타임라인 재생 UI와 중단 지점에서 실행을 재개하는 기능은 포함하지 않습니다.

## API

모든 인덱스는 0부터 시작합니다. 변경 요청은 JSON이며 세션의 최신 `version`을 전달합니다. 클라이언트는 전송 전에 `requestId`를 생성하고 응답 유실로 재시도할 때 같은 ID와 같은 요청 내용을 유지해야 합니다.

| 요청 | 동작 |
|---|---|
| `GET /api/rl/stats` | 작업자·세션·환경 수와 규칙 버전 조회 |
| `GET /api/rl/sessions` | 세션 목록 조회 |
| `POST /api/rl/sessions` | 독립 환경 묶음 생성 |
| `GET /api/rl/sessions/{id}` | 환경 묶음의 현재 관측과 행동 마스크 조회 |
| `POST /api/rl/sessions/{id}/step` | 환경별 행동 한 번씩 실행 |
| `POST /api/rl/sessions/{id}/reset` | 전체 또는 지정 환경 초기화 |
| `GET /api/rl/sessions/{id}/envs/{envId}` | 관찰용 상세 게임판 조회 |
| `DELETE /api/rl/sessions/{id}` | 환경 묶음 삭제 |

생성 요청:

```json
{"numEnvs":256,"seed":123,"maxEpisodeSteps":10000,"invalidActionMode":"reject","requestId":"create-001","policyMetadata":{"name":"ppo","version":"v1","weights":{"checkpoint":"policy.pt","sha256":"CHECKPOINT_SHA256"},"experimentTags":["baseline"]}}
```

응답의 주요 형식:

```js
{
  sessionId, requestId, version, numEnvs, maxEpisodeSteps, invalidActionMode, engineRulesVersion, scoreRulesVersion,
  results: [{
    gameId, envId, episodeId, version,
    observation: { board, tray, score, combo, unEliminateTimes, round, moves },
    actionMask, reward, terminated, truncated, info
  }]
}
```

- `observation.board`: 8×8 점유 배열. 빈칸 `0`, 채운 칸 `1`.
- `observation.tray`: 남은 3개 블록의 모양 ID. 사용한 슬롯은 `-1`입니다. 모양 행렬은 `GET /api/shapes`에서 조회합니다.
- `combo`, `unEliminateTimes`: 배점에 영향을 주므로 관측에 포함합니다.
- `score`, `round`: 블록 생성과 전체 비우기 보너스 조건에 영향을 주므로 관측에 포함합니다.
- `actionMask`: 길이 192의 0/1 배열. 현재 놓을 수 있는 행동은 `1`입니다. 현재 보드와 남은 블록으로 계산한 배치 가능 여부이며 행동의 전략적 가치를 평가하는 값은 아닙니다. 정책이 합법 행동 중에서 선택하도록 쓰면 잘못된 배치 시도와 재요청을 줄일 수 있습니다.
- `reward`: 기본값은 해당 수의 원래 점수 증가량입니다. 같은 원시 값은 `info.scoreDelta`로도 제공합니다. 학습 코드는 이 값을 그대로 사용하거나 목적에 맞게 정규화·변환하거나 다른 보상 함수를 구성할 수 있습니다. 환경 API가 모델의 학습 목표를 고정하지는 않습니다.
- `terminated`: 놓을 수 있는 블록이 없어 게임 자체가 종료된 상태입니다.
- `truncated`: 게임이 진행 가능하지만 `maxEpisodeSteps` 제한에 도달한 상태입니다.

난수 상태는 환경 내부에 유지하며 정책의 `observation`에는 포함하지 않습니다. 상세 게임판 조회의 `state`에는 디버깅·재현용 시드가 포함될 수 있으므로 정책 입력으로 상세 응답 전체를 사용하지 마세요.

행동 번호는 다음 식으로 계산합니다. 블록을 회전하는 행동은 없습니다.

```js
action = slot * 64 + row * 8 + col;
slot = Math.floor(action / 64);
row = Math.floor((action % 64) / 8);
col = action % 8;
```

`actions`는 환경 수와 길이가 같아야 하며 `results`의 환경 순서와 대응합니다. `null`은 해당 환경을 이번 요청에서 건너뜁니다.

```js
const next = await post(`/api/rl/sessions/${batch.sessionId}/step`, {
  requestId: crypto.randomUUID(),
  version: batch.version,
  actions: batch.results.map(result => result.actionMask.findIndex(allowed => allowed === 1))
});
```

종료된 환경을 자동으로 초기화하지 않습니다. 마지막 관측과 보상을 수집한 뒤 원하는 환경만 초기화하세요.

```js
const doneIds = next.results
  .filter(result => result.terminated || result.truncated)
  .map(result => result.envId);
batch = next;
if (doneIds.length) {
  batch = await post(`/api/rl/sessions/${next.sessionId}/reset`, {
    requestId: crypto.randomUUID(), version: next.version, envIds: doneIds
  });
}
```

`envIds`를 생략하면 모든 환경을 초기화합니다. 시드를 생략한 초기화의 난수는 기본 시드·환경 번호·에피소드 번호에서 독립적으로 파생합니다. `seed`를 명시하면 에피소드 번호와 관계없이 같은 시드·환경 번호의 초기 관측을 재현합니다.

동일 세션의 변경 요청은 응답을 받은 뒤 다음 요청을 보내세요. 새로운 요청의 잘못된 버전이나 진행 중인 다른 변경 요청과의 충돌은 `409`입니다. 이미 성공한 `requestId`와 동일한 내용을 재전송하면 과거의 응답을 그대로 반환하며 그때의 버전이 현재보다 오래되어도 중복 실행하지 않습니다. 같은 ID의 내용을 바꾸면 `409 REQUEST_ID_CONFLICT`입니다. 기본 `reject` 모드에서 합법 마스크에 없는 행동은 `422`이며, 배치 전체를 검사한 뒤 실행하므로 이 요청에서 일부 환경만 진행되지 않습니다. 전체 512개 제한 초과는 `409 ENV_LIMIT`, 대기 작업 제한 초과는 `429 RL_OVERLOADED`입니다. 작업자나 기록 저장 실패 시 성공으로 응답하지 않고 관련 실행 세션을 무효화합니다. 이미 저장한 기록은 남습니다.

## 배치 가능 여부도 학습시키는 실험

블록을 효율적으로 놓는 전략에 집중하려면 합법 행동 마스크를 적용할 수 있습니다. 배치 가능 여부 자체를 정책이 익히게 하고 싶다면 세션을 `transition` 모드로 생성하고, 학습 코드에서 마스크를 적용하지 않은 행동도 선택하도록 구성합니다.

```json
{"numEnvs":256,"seed":123,"maxEpisodeSteps":10000,"invalidActionMode":"transition"}
```

| 생성 옵션 | 현재 놓을 수 없는 행동을 보낸 경우 |
|---|---|
| `invalidActionMode: "reject"` (기본값) | HTTP `422`, 배치 전체를 진행하지 않음 |
| `invalidActionMode: "transition"` | HTTP `200`, 해당 환경에 실패한 시도 한 번을 기록하고 다른 환경의 정상 행동도 실행 |

`transition` 모드의 잘못된 배치는 보드·남은 블록·점수·난수 상태·실제 배치 횟수 `observation.moves`를 유지합니다. 시도 횟수 `info.episodeSteps`와 환경 버전은 증가하고 `reward=0`, `info.scoreDelta=0`, `info.actionValid=false`, `info.invalidActionReason="illegal_placement"`로 반환합니다. 따라서 잘못된 행동만 반복해도 `maxEpisodeSteps`에 도달하면 `truncated=true`가 됩니다.

정상 배치는 `info.actionValid=true`, 초기화와 `null`로 건너뛴 환경은 `info.actionValid=null`입니다. `transition`에서도 행동 번호 형식 오류는 `400`, 이미 종료된 환경에 보낸 `null`이 아닌 행동은 `422`입니다. `actionMask`는 두 모드 모두 제공하므로 마스크를 적용한 정책과 적용하지 않은 정책을 비교할 수 있습니다.

환경은 실패에 고정 벌점을 부과하지 않습니다. 학습 코드는 필요하면 `info.actionValid === false`에 자체 벌점을 적용하고 원래 점수 증가량은 `info.scoreDelta`로 별도 기록하면 됩니다. 마스크 없이 학습하면 유효하지 않은 시도에도 표본과 연산을 사용하므로, 전략 학습과 배치 가능 여부 학습의 처리량·최종 성능을 함께 비교하는 것이 좋습니다.

제공한 `examples/rl-client.mjs`의 기본값은 `--mask true`이며 합법 행동 중 무작위로 고릅니다. `--mask false`는 `transition` 세션에서 192개 행동 중 무작위로 고르는 비교 시연입니다. 두 시연 모두 학습된 정책은 포함하지 않습니다.

```sh
node examples/rl-client.mjs --envs 256 --batches 200 --seed 123 --mask true
node examples/rl-client.mjs --envs 256 --batches 200 --seed 123 --mask false
```

출력의 `attempts`는 전체 시도 수, `successfulPlacements`는 실제 블록 배치 수, `invalidActions`와 `invalidActionRate`는 실패 수와 비율입니다. 실패한 시도는 블록 생성·배치를 실행하지 않아 계산 비용이 더 작으므로 `attemptsPerSecond`만으로 게임 진행 처리량을 비교하면 안 됩니다. 실제 진행량은 `placementsPerSecond`와 함께 확인하세요. 이 무작위 시연의 결과가 학습된 모델의 성능을 나타내지는 않습니다.

## 자동 플레이 기록과 재현

HTTP 백엔드는 환경을 생성하는 순간부터 적용한 행동을 자동 기록합니다. 클라이언트가 별도로 플레이 로그를 업로드할 필요가 없습니다. `gameId`는 한 게임 동안 유지되고 초기화할 때마다 새 UUID를 발급합니다. 게임 기록의 키는 **`(sessionId, gameId)`**입니다. `envId`, `episodeId`는 보조 정보이며 관찰 응답의 `id = sessionId-envId`는 기록 키로 사용하지 않습니다.

게임 헤더는 `schemaVersion`, 식별자, 세션 원래 입력 `baseSeed`, 현재 게임의 시드 파생 기준 `gameBaseSeed`, 실제 `createGame` 인자로 사용한 `initialGameSeed`, `initialState`, 규칙 버전, 실행 조건, 정책 메타데이터, 시작·종료 시간을 보관합니다. `initialGameSeed`는 게임 생성 시점에 확정해서 저장합니다. 진행 중 바뀌는 `state.seed`나 논리적인 `episodeId`로 나중에 계산하지 않습니다. 명시적인 `reset(seed=...)` 뒤에도 이 값으로 원래 초기 상태를 재현합니다.

`policyMetadata`는 생성 요청의 JSON 객체를 저장합니다. `name`, `version`, `weights`의 체크포인트 식별자·해시, `experimentTags` 등을 넣을 수 있습니다. 백엔드는 가중치 파일을 다운로드하거나 실행하지 않습니다. 재현용 헤더·시드·정책 메타데이터는 모델 입력인 `observation`과 분리합니다.

각 행동은 0부터 시작하는 `step` 순서로 저장합니다. `x=col`, `y=row`이며 블록 행렬 왼쪽 위를 놓는 0 기반 좌표입니다. `blockId`는 **배치 전 `tray[slot]`**에서 읽습니다. 동일 모양이 여러 슬롯에 있어도 `slot`으로 구분합니다.

```json
{
  "step": 0,
  "requestId": "step-001",
  "action": 26,
  "slot": 0,
  "blockId": 13,
  "x": 2,
  "y": 3,
  "actionValid": true,
  "scoreDelta": 9,
  "scoreAfter": 9,
  "comboAfter": 0,
  "clearedRows": [],
  "clearedCols": [],
  "refilled": false,
  "trayAfter": [-1, 4, 9],
  "scoreBreakdown": {"placement": 9, "elimination": 0, "allClear": 0}
}
```

위 JSON은 필드 형식 예시입니다. 실제 블록·점수·소거·보충 결과는 백엔드가 적용한 값으로 기록합니다.

| 상황 | 행동·종료 기록 |
|---|---|
| 정상 배치 | 행동 추가, `attemptCount`와 `placementCount` 증가 |
| `null` 건너뛰기 | 행동을 추가하지 않음 |
| 형식·버전·합법성 오류로 거절 | 행동을 추가하지 않음 |
| `transition`의 불법 배치 | `actionValid=false` 행동 추가, 시도 횟수만 증가 |
| 놓을 수 있는 블록이 없어 종료 | `endReason=game_over` |
| 최대 시도 수 도달 | `endReason=max_episode_steps` |
| 진행 중 수동 초기화 | 기존 게임을 `manual_reset`으로 닫고 새 `gameId` 생성 |
| 진행 중 실행 세션 삭제 | 남은 게임을 `session_closed`로 닫음 |
| 서버 재시작·실행 유실 | 미완료 게임을 `interrupted`로 닫음 |

이미 정상 종료된 게임은 초기화나 세션 삭제가 기존 종료 이유를 덮어쓰지 않습니다. 실행 세션 삭제는 기록 삭제와 별개이며, 저장 기록을 지우는 API는 제공하지 않습니다.

### 저장 위치와 성공 응답

기본 Docker 영구 볼륨의 `/app/data/records`에 저장합니다. Node 직접 실행은 `DATA_DIR/records`이며 기본값은 `data/records`입니다.

기록 디렉터리 하나당 백엔드 작성자 프로세스 하나를 사용합니다. 독립 백엔드 여러 개를 실행할 때는 각각 다른 `DATA_DIR/records`를 지정합니다.

```text
records/
  history.sqlite              # 트랜잭션과 조회의 기준 저장소
  sessions/{sessionId}/
    session.json
    games/
      {gameId}.jsonl          # header, step, end 이벤트
      {gameId}.json           # 종료한 게임의 메타데이터·결과·steps
```

JSONL은 `{type:"header", ...}`, `{type:"step", ...}`, `{type:"end", ...}` 이벤트를 순서대로 담습니다. 종료 JSON은 헤더와 종료 결과에 전체 `steps`를 더한 문서입니다. 트랜잭션 저장소를 기준으로 파일을 갱신하며, 재시작 시 미완료 게임을 닫고 비정상 종료 중 작성이 끊긴 출력 파일을 복구합니다.

배치가 성공 응답을 받기 전에 기록 저장을 완료합니다. 작업자 일부 실패나 저장 실패를 성공으로 응답하지 않으며, 해당 실행 세션을 무효화해 저장되지 않은 상태로 계속 진행하지 못하게 합니다. 이미 확정된 기록은 보존합니다.

### 중복 요청

`requestId`는 생성·배치·초기화 요청에서 지원합니다. 기존 클라이언트와의 호환을 위해 생략할 수 있으며 이때 서버가 생성한 ID를 응답합니다. **응답 유실 후 안전하게 재시도하려면 클라이언트가 보내기 전에 ID를 만들어야 합니다.** 같은 ID로 재시도할 때 원래 `version`, `actions`, `seed` 등 요청 내용도 유지하세요.

```js
const command = {
  requestId: crypto.randomUUID(),
  version: batch.version,
  actions: batch.results.map(result => result.actionMask.findIndex(Boolean))
};
// 네트워크 실패로 다시 보낼 때 새 ID나 새 version을 만들지 않습니다.
const next = await post(`/api/rl/sessions/${batch.sessionId}/step`, command);
```

생성 요청의 ID는 생성 요청들 사이에서, 배치·초기화 ID는 같은 `sessionId` 안에서 중복을 판별합니다. 이미 성공한 요청은 기록과 응답을 영구 보관하므로 오래된 버전의 재전송도 같은 응답을 반환합니다. 요청 내용이 바뀌면 `409 REQUEST_ID_CONFLICT`입니다. 실행 세션이 삭제되거나 서버가 재시작된 뒤에 과거 응답을 다시 받더라도 실행 세션을 복원하거나 중단 지점에서 재개하지는 않습니다.

제공한 시연 클라이언트도 ID를 전송 전에 발급하고 네트워크 실패 재시도에 같은 요청을 사용합니다. HTTP 오류에 새 ID를 붙여 같은 행동을 자동 재실행하지 않습니다.

### 기록 조회와 재생 검증 API

| API | 응답 |
|---|---|
| `GET /api/rl/history/sessions` | 저장된 세션 목록 |
| `GET /api/rl/history/sessions/{sessionId}/games` | 초기화 전 게임을 포함한 게임 목록 |
| `GET /api/rl/history/sessions/{sessionId}/games/{gameId}` | 재현 헤더·시도/배치 횟수·종료 결과 |
| `GET /api/rl/history/sessions/{sessionId}/games/{gameId}/steps` | 순서 있는 행동 |
| `GET /api/rl/history/sessions/{sessionId}/games/{gameId}/replay` | 시드와 행동으로 재현한 상태 및 일치 여부 |

목록과 행동 조회는 `?limit=50&offset=0`처럼 페이지를 지정하며 `{items,total,limit,offset,hasMore}`를 반환합니다. 게임 목록 항목은 식별자·시간·종료 이유·시도/배치 횟수·점수·콤보를 담은 요약이며, 최초 상태와 시드 등 전체 헤더는 개별 게임 조회에서 제공합니다. 세션·게임 목록 기본 `limit`은 50, 행동은 100이며 최대 1,000입니다. 행동은 `step` 오름차순입니다.

```sh
curl "http://127.0.0.1:5173/api/rl/history/sessions?limit=10&offset=0"
curl "http://127.0.0.1:5173/api/rl/history/sessions/SESSION_ID/games?limit=10&offset=0"
curl "http://127.0.0.1:5173/api/rl/history/sessions/SESSION_ID/games/GAME_ID/steps?limit=100&offset=0"
curl "http://127.0.0.1:5173/api/rl/history/sessions/SESSION_ID/games/GAME_ID/replay"
```

재생 API는 캡처한 `initialGameSeed`로 생성한 상태가 `initialState`와 같은지 확인한 뒤 기록된 행동을 순서대로 적용합니다. 블록 ID·좌표·성공 여부·점수·콤보·소거·보충 결과와 저장된 마지막 상태가 일치해야 `valid=true`를 반환합니다. 결과에는 재현한 `state`, `attemptCount`, `placementCount`, `terminated`, `truncated`가 포함됩니다. 불일치는 `422 REPLAY_MISMATCH`, 현재 엔진이 기록의 규칙·형식 버전을 지원하지 않으면 `409 UNSUPPORTED_RULES`입니다. 재생 작업자는 제한된 수로 실행하며 모두 사용 중이면 `429 REPLAY_OVERLOADED`입니다.

## 처리량 측정

```sh
node scripts/benchmark-rl.mjs --workers 1,4 --envs 256 --warmup 20 --batches 200
```

서버에 접속하지 않고 별도 작업자 풀을 생성해 1개와 4개 작업자를 비교합니다. 일반 게임과 실행 중인 학습 세션을 변경하지 않습니다. 출력은 구성별 JSON 한 줄이며 초당 환경 수 진행(`stepsPerSecond`), 배치 지연, 초기화 수, 작업자 정보를 포함합니다.

측정에는 관측·합법 마스크 작성, 작업자 메시지 전달, 다음 블록 생성, 종료 환경 초기화가 포함됩니다. HTTP·디스크 로그 저장·모델 추론과 학습 시간은 제외합니다. 작업자 스레드가 실제로 여러 개 생성되는 것과 특정 구성의 처리량이 증가하는 것은 별도로 확인해야 합니다.

## 원본과의 관계

점수는 분석한 Block Blast 10.9.3 기본 클래식 공식을 사용하며 튜토리얼·원격 설정별 보정은 제외합니다. 블록 생성은 원본 서버 알고리즘과 같은 구현이 아니라 자체 재구성입니다. 이 환경에서 학습한 정책의 원본 Android 게임 성능은 별도 검증이 필요합니다. 실험 결과와 함께 `engineRulesVersion`, `scoreRulesVersion`, 환경 시드, 정책 설정을 기록하세요.
