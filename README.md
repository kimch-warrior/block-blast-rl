# Block Blast RL

8×8 블록 퍼즐 웹 게임과 CPU 멀티스레드 강화학습 환경입니다. 로컬 Docker에서 게임을 플레이하거나, 화면 없이 여러 환경을 API로 진행할 수 있습니다.

- 기본 **256개 환경**, 전체 세션 합계 **최대 512개**, CPU 작업자 **4개**
- 게임판 조회·블록 배치 API, 학습용 배치 `step/reset` API
- 선택한 학습 환경을 브라우저에서 읽기 전용으로 관찰
- 백엔드 자동 플레이 기록, 영구 기록 조회와 시드 기반 재생 검증
- 외부 npm 의존성 없이 Node.js 내장 HTTP·SQLite·Worker Threads 사용

Block Blast를 바탕으로 만든 비공식 독립 구현입니다. 원본 APK나 앱 리소스는 포함하지 않습니다. 다음 블록 생성은 자체 재구성이므로 원본 Android 게임과 같은 분포를 보장하지 않습니다. 점수는 분석한 10.9.3 기본 클래식 공식을 적용하며 튜토리얼·원격 trait별 보정은 제외합니다.

## 빠른 시작

Docker Engine과 Compose v2가 필요합니다. Windows에서는 Docker Desktop을 실행하고 Linux 컨테이너 모드를 사용하세요.

비공개 저장소는 접근 권한이 있는 GitHub 계정으로 인증한 뒤 복제합니다.

```sh
git clone https://github.com/kimch-warrior/block-blast-rl.git
cd block-blast-rl
docker compose up --build -d
```

브라우저에서 [게임 화면](http://127.0.0.1:5173/)을 엽니다. 블록을 드래그하거나 선택 후 보드의 위치를 클릭해 배치합니다. 키보드는 `1/2/3` 선택, 방향키 이동, `Enter` 배치, `Esc` 취소입니다.

Windows CMD에서는 프로젝트 폴더에서 다음 실행 파일을 사용할 수 있습니다.

```cmd
start-local.cmd
```

| 주소 | 용도 |
|---|---|
| [http://127.0.0.1:5173/](http://127.0.0.1:5173/) | 게임 화면 |
| [http://127.0.0.1:5173/api/state](http://127.0.0.1:5173/api/state) | 현재 일반 게임 상태 |
| [http://127.0.0.1:5173/api/openapi.json](http://127.0.0.1:5173/api/openapi.json) | OpenAPI 명세 |
| [http://127.0.0.1:5173/api/rl/stats](http://127.0.0.1:5173/api/rl/stats) | 학습 작업자·환경 수 |
| [http://127.0.0.1:5173/healthz](http://127.0.0.1:5173/healthz) | 서버·DB 상태 |

일반 게임을 아직 만들지 않았다면 `/api/state`는 `404 NO_ACTIVE_GAME`을 반환합니다. 게임 화면을 열거나 `POST /api/games`로 생성하세요.

```sh
docker compose ps
docker compose logs --tail=50 block-blast
docker compose down
```

Windows의 `stop-local.cmd`도 같은 중지 명령을 실행합니다. 일반 게임과 자동 플레이 기록은 `block-blast-data` 볼륨에 저장되므로 일반 중지·재시작·컨테이너 재생성 후에도 유지됩니다. 실행 중인 학습 환경은 메모리에 있어 서버 재시작 시 사라지고, 미완료 게임 기록은 `interrupted`로 닫습니다.

## CMD에서 화면 없이 실행

게임 컨테이너가 실행 중이면 호스트에 Node.js를 설치하지 않고 시연 클라이언트를 실행할 수 있습니다.

```cmd
docker compose exec block-blast node examples/rl-client.mjs --url http://127.0.0.1:3000
```

기본 256개 환경을 합법 행동 중 무작위 선택으로 진행합니다. 최대 환경 수나 실행 길이를 지정할 수 있습니다.

```cmd
docker compose exec block-blast node examples/rl-client.mjs --url http://127.0.0.1:3000 --envs 512 --batches 500
```

배치 가능 여부도 시행착오로 실험하려면 `--mask false`를 사용합니다.

```cmd
docker compose exec block-blast node examples/rl-client.mjs --url http://127.0.0.1:3000 --mask false --batches 500 --delay-ms 100
```

`--mask true`는 합법 행동 마스크를 적용합니다. `--mask false`는 192개 행동 중 무작위로 고르며, 불가능한 배치도 한 번의 시도로 기록하는 `transition` 모드를 사용합니다. 제공한 클라이언트는 환경 동작을 확인하는 무작위 시연이며 학습 모델은 포함하지 않습니다. 종료 시 자신이 만든 세션을 정리합니다.

### 학습 화면 관찰

시연 출력의 `sessionId`를 다음 주소에 넣으면 해당 환경을 볼 수 있습니다.

```text
http://127.0.0.1:5173/game/index.html?session=SESSION_ID&env=0
```

`env`는 해당 세션의 `0`부터 `numEnvs - 1`까지 지정합니다. `--delay-ms 100`처럼 속도를 낮추면 진행을 보기 쉽습니다. 관찰 화면은 게임을 변경하지 않습니다. 저장한 기록은 아래 조회·재생 검증 API로 확인합니다.

컨테이너 내부 API 포트는 `3000`, Windows 브라우저에서 사용하는 호스트 포트는 `5173`입니다. 컨테이너 시연이 출력한 `viewer` 주소에서는 포트를 `5173`으로 바꾸세요.

## 강화학습 API

`POST /api/rl/sessions`에 `{}`를 보내면 기본 256개 환경을 생성합니다. 작업자 4개가 64개씩 나눠 맡으며 512개를 만들면 작업자당 128개를 맡습니다. 전체 한도는 **모든 세션을 합쳐 512개**입니다.

```json
{"numEnvs":256,"seed":123,"maxEpisodeSteps":10000,"invalidActionMode":"reject"}
```

| API | 동작 |
|---|---|
| `POST /api/rl/sessions` | 환경 묶음 생성 |
| `GET /api/rl/sessions/{id}` | 관측·행동 마스크 조회 |
| `POST /api/rl/sessions/{id}/step` | 환경 수만큼 행동을 한 번에 실행 |
| `POST /api/rl/sessions/{id}/reset` | 전체 또는 선택 환경 초기화 |
| `DELETE /api/rl/sessions/{id}` | 환경 해제 |
| `GET /api/rl/sessions/{id}/envs/{envId}` | 관찰용 상세 상태 조회 |

- 관측은 보드 점유, 남은 블록, 점수·콤보·라운드 등입니다. 내부 RNG 상태는 정책 관측에서 제외합니다.
- 행동은 `slot * 64 + row * 8 + col`의 **192개**이며, `actionMask`가 현재 가능한 배치를 표시합니다.
- `reward` 기본값은 점수 증가량입니다. 원래 증가량은 `info.scoreDelta`로도 제공하고, 학습 코드는 별도 보상식이나 실패 감점을 적용할 수 있습니다.
- `reject` 모드는 불가능한 배치를 `422`로 거절합니다. `transition` 모드는 보드를 유지하고 실패 시도를 기록하며 고정 감점을 부과하지 않습니다.
- `terminated`는 게임 자체 종료, `truncated`는 시도 횟수 제한입니다. 자동 초기화하지 않으므로 마지막 관측을 수집한 뒤 명시적으로 `reset`하세요.
- 변경 요청에는 최신 세션 `version`이 필요합니다. 같은 세션은 이전 배치 응답을 받은 뒤 다음 요청을 보내세요.

생성·배치·초기화 응답의 각 환경에는 한 판을 식별하는 `gameId`가 있습니다. 초기화하면 새 ID를 발급하고 이전 게임의 기록은 유지합니다. 기록 키는 `(sessionId, gameId)`이며 관찰용 `id=sessionId-envId`는 사용하지 않습니다.

`requestId`를 전송 전에 생성하고 네트워크 실패로 재시도할 때 같은 요청 내용과 함께 재사용하세요. 성공한 요청의 응답은 영구 저장하며 같은 ID에 다른 내용을 보내면 `409 REQUEST_ID_CONFLICT`입니다. 생략하면 서버가 ID를 생성하지만, 응답을 받지 못한 요청을 안전하게 재전송하려면 클라이언트가 발급해야 합니다.

### 자동 플레이 기록

백엔드는 게임을 생성할 때 실제 `initialGameSeed`와 최초 상태, 규칙·실행 조건, 선택적인 `policyMetadata`를 확정하고 적용한 행동을 순서대로 저장합니다. 점수 증가량, 소거·보충 결과, 배치 전 슬롯·블록 ID와 `x=col`, `y=row` 좌표도 기록합니다. 재현용 정보는 정책의 `observation`과 분리합니다.

기본 영구 저장 위치는 `/app/data/records`입니다. 게임별 JSONL과 종료 JSON을 만들고 SQLite 트랜잭션으로 순서·중복 방지와 조회를 관리합니다. 성공 응답 전에 기록 저장을 끝내며 저장·작업자 실패를 성공으로 응답하지 않습니다. `null` 건너뛰기와 거절된 요청은 행동 기록을 남기지 않고, `transition` 불법 시도는 실제 배치와 별도로 기록합니다.

| API | 용도 |
|---|---|
| `GET /api/rl/history/sessions` | 저장된 세션 목록 |
| `GET /api/rl/history/sessions/{sessionId}/games` | 게임 목록 |
| `GET /api/rl/history/sessions/{sessionId}/games/{gameId}` | 재현 정보·종료 결과 |
| `GET /api/rl/history/sessions/{sessionId}/games/{gameId}/steps` | 순서 있는 행동 기록 |
| `GET /api/rl/history/sessions/{sessionId}/games/{gameId}/replay` | 초기 시드·행동으로 재현하고 결과 검증 |

목록·행동 응답은 `{items,total,limit,offset,hasMore}`이며 `?limit=50&offset=0`으로 페이지를 지정합니다. 실행 세션 삭제 후에도 기록을 조회할 수 있습니다. 수동 초기화는 `manual_reset`, 세션 삭제는 `session_closed`, 재시작으로 실행이 사라진 경우는 `interrupted`로 구분합니다. 재생 검증은 실행을 이어가는 기능과 별개입니다.

요청·응답 전체와 배치 루프 예제는 [RL.md](RL.md), 일반 게임 API와 점수 공식은 [API.md](API.md)를 참고하세요. 관찰용 상세 상태에는 재현·디버깅용 시드가 포함되므로 학습 정책에는 `observation`을 사용하세요.

Compose의 환경 변수로 자원 사용 범위를 조절합니다.

| 환경 변수 | 기본값 | 의미 |
|---|---|---|
| `RL_WORKERS` | `4` | CPU 작업자 수, 1~16 |
| `RL_MAX_ENVS` | `512` | 전체 환경 한도, 1~512 |
| `RL_MAX_PENDING` | `16` | 동시에 처리 중인 풀 요청 제한 |

설정을 바꾼 뒤 `docker compose up -d`로 컨테이너를 다시 생성합니다. 작업자나 환경 수를 늘리면 데이터 전달 비용과 배치 지연도 달라지므로 실제 모델을 연결한 전체 처리량으로 비교하세요.

## 일반 게임을 API로 제어

다음 PowerShell 예제는 새 일반 게임을 만들고, 가능한 첫 위치에 블록을 배치합니다. 이 게임은 웹 화면의 현재 게임으로 지정됩니다.

```powershell
$base = 'http://127.0.0.1:5173'
$game = Invoke-RestMethod -Method Post -Uri "$base/api/games" `
  -ContentType 'application/json' -Body '{"seed":123}'
$slot = $game.legalMoves | Where-Object { $_.positions.Count -gt 0 } | Select-Object -First 1
$move = @{
  gameId = $game.id
  version = $game.version
  slot = $slot.slot
  row = $slot.positions[0].row
  col = $slot.positions[0].col
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/api/place" `
  -ContentType 'application/json' -Body $move
Invoke-RestMethod -Uri "$base/api/state"
```

배치 응답에 다음 게임 상태와 합법 위치가 포함되어 매 수 별도의 조회 요청을 보낼 필요는 없습니다. 일반 화면에는 외부 변경이 약 1.6초 내 반영됩니다.

## 다른 Docker 컨테이너에서 접근

같은 `block-blast-local` 네트워크에서는 `http://block-blast:3000`으로 접근합니다. 다른 Compose 프로젝트의 서비스에는 다음 네트워크를 연결하세요.

```yaml
services:
  trainer:
    image: node:24-alpine
    environment:
      BLOCK_BLAST_URL: http://block-blast:3000
    networks:
      - block-blast
networks:
  block-blast:
    external: true
    name: block-blast-local
```

이미 실행 중인 컨테이너에는 `docker network connect block-blast-local CONTAINER_NAME`으로 연결할 수 있습니다. 컨테이너의 `localhost`는 그 컨테이너 자신을 가리킵니다.

기본 Compose는 호스트의 `127.0.0.1:5173`에만 포트를 공개합니다. API는 로컬 사용을 전제로 하며 로그인이나 API 키를 요구하지 않습니다.

## Node.js로 직접 실행·개발

Node.js **24 이상**이 필요합니다. 외부 npm 패키지를 설치하지 않고 실행할 수 있습니다.

```sh
npm start
```

기본 접속 주소는 `http://127.0.0.1:3000`, 저장 폴더는 `data/`입니다. `HOST`, `PORT`, `DATA_DIR` 환경 변수로 변경합니다. 예를 들어 PowerShell에서 로컬 루프백에 바인딩하려면:

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:DATA_DIR = './data'
npm start
```

별도 터미널에서 시연 클라이언트의 접속 주소를 지정합니다.

```sh
npm run rl:demo -- --url http://127.0.0.1:3000 --envs 256
npm run rl:benchmark -- --workers 1,4 --envs 256
npm test
```

벤치마크는 별도 작업자 풀을 만들며 HTTP·모델 추론·학습·영구 기록 저장 시간은 제외합니다. HTTP 학습 API의 자동 기록 비용까지 포함한 처리량은 실제 실행으로 비교하세요. 테스트는 게임 규칙, 저장·동시 요청, 작업자 복구, 256/512 환경 경계, 자동 기록·중복 방지·재생, 프런트엔드 통신·입력·동기화를 검증합니다.

## 코드 구조

```text
public/game/
  app.js                 # 모듈을 연결하는 31줄 진입점
  engine.js, shapes.js   # 화면·서버 공유 규칙과 모양
  client/                # API, 상태 동기화, 로컬 저장
  ui/                    # 렌더링, 입력, 효과
server/
  index.mjs              # HTTP·정적 파일·API 라우팅
  sqlite-store.mjs       # 일반 게임 저장
  rl/                    # 메모리 환경과 CPU 작업자 풀
examples/rl-client.mjs   # API 시연 클라이언트
scripts/benchmark-rl.mjs # CPU 환경 처리량 측정
```

브라우저 모듈은 각자 상태·이벤트·타이머를 관리하고 `dispose()`로 해제합니다. 기존 `window.BlockBlast` 제어 API도 사용할 수 있습니다.
