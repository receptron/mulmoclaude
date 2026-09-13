# MulmoClaude

[![npm version](https://img.shields.io/npm/v/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![npm downloads](https://img.shields.io/npm/dm/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![License: MIT](https://img.shields.io/npm/l/mulmoclaude.svg)](LICENSE)
[![CI](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml/badge.svg)](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml)
[![GitHub stars](https://img.shields.io/github/stars/receptron/mulmoclaude.svg?style=social)](https://github.com/receptron/mulmoclaude/stargazers)

[English](README.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · **한국어** · [Español](README.es.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**당신에 대해 모든 것을 알고 하루 24시간 곁에서 도와주는 AI 어시스턴트는 어디에서도 팔지 않습니다. 살 수는 없습니다 — 오직 직접 키울 수 있을 뿐입니다. MulmoClaude는 나만의 AI 어시스턴트를 자신의 컴퓨터 위에서 키우기 위한 도구입니다.**

어시스턴트의 실체는 AI 모델이 아닙니다 — 모델은 엔진에 불과합니다. 어시스턴트의 가치를 결정하는 것은 당신에 대해 얼마나 알고 있는가입니다: 당신의 대화, 일정, 메모, 데이터, 그리고 사용하는 앱들. 그토록 중요한 것을 특정 서비스 제공자에게 맡겨서는 안 됩니다 — 오래 쓸수록 떠나기가 어려워지기 때문입니다. MulmoClaude는 오픈소스이며 로컬에서 실행되므로, 어시스턴트가 축적하는 모든 것 — 기억, 데이터, 앱이 워크스페이스 안의 일반 파일로 남아, 당신 자신의 손 안에 있습니다.

키우려면 환경이 필요하고, MulmoClaude가 그 환경을 제공합니다: 기억을 축적하는 곳(Claude가 스스로 만들고 관리하는 개인 위키), 데이터를 두는 곳(스키마 기반 컬렉션, 피드, 일반 파일), 그리고 나만을 위한 앱을 만드는 곳 — 프로그래밍 지식은 필요 없습니다. "이런 게 있었으면 좋겠어"라고 일상 언어로 말하기만 하면, Claude가 필요한 작은 앱을 만들어 줍니다: 레스토랑 리스트, 청구서 트래커, 단어 연습 — 모두 단 한 사람을 위한 소프트웨어입니다. 설치 직후의 정원은 아직 텅 비어 있습니다. 씨앗을 심고 흙을 가꾸며, 오직 나만의 어시스턴트를 키워 가는 것입니다.

그리고 어시스턴트는 책상 앞에서만 쓰는 것이 아닙니다. 스마트폰에서 — 또는 이미 쓰고 있는 메시징 앱에서 — 로그인하면, 컴퓨터 안에 살고 있는 같은 어시스턴트에 연결됩니다. 릴레이 서버는 전송 중인 메시지를 전달할 뿐 — 당신의 기억도, 데이터도, 앱도 컴퓨터 밖으로 나가지 않습니다.

내부적으로 MulmoClaude는 AI-네이티브 애플리케이션 플랫폼입니다: 각 기능은 하나의 레지스트리 안에 있는 플러그인으로 구축되고(현재: 실제 서버사이드 부기 로직을 갖춘 완전한 회계 시스템, 개인 위키, SEC 공시 리더 등), Claude는 이들을 가로질러 구성하는 유니버설 컨트롤러 역할을 하며, 채팅이 작업에 적합한 GUI를 호출합니다 — markdown, 차트, 폼, 위키, 스프레드시트, 3D 장면.

> **[How AI-Native Applications Should Be Built](MANIFEST.md)** — MulmoClaude의 아키텍처, UX, 그리고 프로토콜에 대한 주장.

## 📣 업데이트 소식

새 릴리스와 새 기능은 X에서 **일본어**로 안내합니다.

- [Singularity Society (@SingularitySoci)](https://x.com/SingularitySoci) — 릴리스 및 새 기능 안내
- [나카지마 사토시 (@snakajima)](https://x.com/snakajima) — MulmoClaude 오너

## 빠른 시작

```bash
npx mulmoclaude@latest
```

런처가 서버를 띄우고 브라우저에서 [http://localhost:3001](http://localhost:3001) 을 엽니다. 이제 끝입니다 — 대화를 시작하세요.

> **백그라운드로 계속 실행하기**: 터미널을 닫으면 서버도 종료됩니다. 백그라운드로 운영하려면 `tmux` / `screen` (macOS/Linux) 안에서 실행하거나 Windows 의 작업 스케줄러에 시작 작업으로 등록하세요.

### 필수 조건

- **Node.js 22.19+** — 런타임
- **[Claude Code CLI](https://claude.ai/code)** — 설치 및 인증 완료. `claude` 를 한 번 실행해 OAuth 를 완료해 주세요
- **ffmpeg** — 동영상 생성에 필요합니다. 동영상을 생성하지 않으면 건너뛰어도 됩니다
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
- **Docker Desktop** (선택 사항이지만 권장) — 샌드박스 모드를 활성화합니다. 아래 [Docker Desktop 설치](#docker-desktop-설치) 를 참조하세요

> **UI 언어**: 영어, 일본어, 중국어, 한국어, 스페인어, 포르투갈어 (브라질), 프랑스어, 독일어 등 8개 언어를 지원합니다. 기본값은 브라우저 / OS 언어 설정에서 자동으로 감지됩니다. 명시적으로 지정하려면 `.env` 에 `VITE_LOCALE=ko` 를 설정하세요. 로케일은 빌드/개발 시점에 결정되므로 변경 후 `yarn dev` 를 재시작해야 합니다. 문자열 추가 방법은 [`docs/developer.md`](docs/developer.md#i18n-vue-i18n) 를 참고하세요.

### 소스에서 실행하기 (개발자용)

코드를 수정하면서 실행하려면:

```bash
git clone git@github.com:receptron/mulmoclaude.git
cd mulmoclaude && yarn install
cp .env.example .env   # 선택 사항 — 이미지 생성을 위해 GEMINI_API_KEY 추가
yarn dev
```

[http://localhost:5173](http://localhost:5173) 을 여세요. 아키텍처와 스크립트 자세한 내용은 [`docs/developer.md`](docs/developer.md) 를 참고하세요.

> **UI가 깨지거나 스타일이 적용되지 않나요?** 아이콘이 글자로 표시됨, `dist/*` 404, 재시작 후 `401` — [`docs/troubleshooting.md`](docs/troubleshooting.md) 를 참고하세요.

## 무엇을 할 수 있나요?

| Claude에게 요청해 보세요...       | 결과물                                             |
| --------------------------------- | -------------------------------------------------- |
| "프로젝트 제안서 작성해 줘"       | 캔버스에 풍부한 마크다운 문서                      |
| "지난 분기 매출을 차트로 보여 줘" | 인터랙티브 ECharts 시각화                          |
| "교토 여행 계획 만들어 줘"        | 이미지가 포함된 일러스트 가이드                    |
| "할 일 관리해 줘"                 | 드래그 앤 드롭 가능한 Kanban 보드                  |
| "이 기사를 수집해 줘: URL"        | 장기 기억을 위한 `[[links]]` 가 포함된 위키 페이지 |
| "매일 뉴스 요약을 예약해 줘"      | 자동으로 실행되는 반복 작업                        |
| "석양 이미지 생성해 줘"           | AI 생성 이미지 (Gemini)                            |
| "이 RSS 피드를 구독해 줘"         | `/feeds` 에 데이터 피드로 등록되어 일정에 따라 가져옴 |
| "내 피드의 새 글 보여 줘"         | `/feeds` 에 모인 피드 항목                         |

> **바로 접근할 수 있는 페이지**: `/wiki`(탐색 + Lint), `/feeds`(데이터 피드), `/collections`(데이터 앱), `/automations`(반복 작업), `/files`, `/skills`, `/roles`. 각 페이지에는 페이지 컨텍스트를 미리 적용한 새 채팅을 시작하는 전용 채팅 컴포저가 있습니다.

> **MulmoClaude를 해킹하고 싶으신가요?** 환경 변수, 스크립트, 아키텍처는 [`docs/developer.md`](docs/developer.md) 를 참고하세요.

<a id="messaging-bridges"></a>
### 메시징 브릿지

MulmoClaude는 **브릿지 프로세스**를 통해 메시징 앱에서 접근할 수 있습니다. 브릿지는 별도의 자식 프로세스로 실행되며 socket.io 를 통해 서버에 연결됩니다.

```bash
# 인터랙티브 CLI 브릿지 (동일 머신)
yarn cli

# Telegram 봇 브릿지 (.env에 TELEGRAM_BOT_TOKEN 필요)
yarn telegram
```

브릿지는 독립형 npm 패키지로도 제공됩니다:

```bash
# 채팅 플랫폼
npx @mulmobridge/cli@latest          # CLI 브릿지
npx @mulmobridge/telegram@latest     # Telegram 브릿지
npx @mulmobridge/slack@latest        # Slack 브릿지
npx @mulmobridge/discord@latest      # Discord 브릿지
npx @mulmobridge/line@latest         # LINE 브릿지
npx @mulmobridge/whatsapp@latest     # WhatsApp 브릿지
npx @mulmobridge/matrix@latest       # Matrix 브릿지
npx @mulmobridge/irc@latest          # IRC 브릿지
npx @mulmobridge/mattermost@latest   # Mattermost 브릿지
npx @mulmobridge/zulip@latest        # Zulip 브릿지
npx @mulmobridge/messenger@latest    # Facebook Messenger 브릿지
npx @mulmobridge/google-chat@latest  # Google Chat 브릿지
npx @mulmobridge/mastodon@latest     # Mastodon 브릿지
npx @mulmobridge/bluesky@latest      # Bluesky 브릿지
npx @mulmobridge/chatwork@latest     # Chatwork 브릿지 (일본 비즈니스 채팅)
npx @mulmobridge/xmpp@latest         # XMPP / Jabber 브릿지
npx @mulmobridge/rocketchat@latest   # Rocket.Chat 브릿지
npx @mulmobridge/signal@latest       # Signal 브릿지 (signal-cli-rest-api 경유)
npx @mulmobridge/teams@latest        # Microsoft Teams 브릿지 (Bot Framework)
npx @mulmobridge/line-works@latest   # LINE Works 브릿지 (엔터프라이즈 LINE)
npx @mulmobridge/nostr@latest        # Nostr 암호화 DM 브릿지
npx @mulmobridge/viber@latest        # Viber 브릿지

# 범용 / 연결
npx @mulmobridge/webhook@latest      # 일반 HTTP 웹훅 (개발용 연결)
npx @mulmobridge/twilio-sms@latest   # Twilio를 통한 SMS
npx @mulmobridge/email@latest        # 이메일 브릿지 (IMAP + SMTP)
```

모든 브릿지는 **실시간 텍스트 스트리밍**을 지원합니다 (에이전트가 작성하는 대로 타이핑 업데이트). CLI와 Telegram은 **파일 첨부** (이미지, PDF, DOCX, XLSX, PPTX)도 지원합니다. 전체 플랫폼 목록과 설정 방법은 [`docs/mulmobridge-guide.md`](docs/mulmobridge-guide.md) 를 참고하세요.

### Gemini API 키가 왜 필요한가요?

MulmoClaude는 이미지 생성 및 편집을 위해 Google의 **Gemini 3.1 Flash Image (nano banana 2)** 모델을 사용합니다. 다음 기능을 제공합니다:

- `generateImage` — 텍스트 설명으로부터 이미지 생성
- `editImage` — 기존 이미지를 변환하거나 수정 (예: "Ghibli 스타일로 변환")
- 문서에 임베드된 인라인 이미지 (Recipe Guide, Trip Planner 등)

Gemini API 키가 없으면 이미지 생성을 사용하는 역할은 UI에서 비활성화됩니다.

### Gemini API 키 얻기

1. [Google AI Studio](https://aistudio.google.com/apikey) 로 이동
2. Google 계정으로 로그인
3. **Create API key** 클릭
4. 키를 복사하여 `.env` 파일에 `GEMINI_API_KEY=...` 로 붙여넣기

Gemini API에는 개인 사용에 충분한 무료 티어가 있습니다.

<a id="security"></a>
## 보안

MulmoClaude는 AI 백엔드로 Claude Code를 사용하며, Bash를 포함한 도구에 접근할 수 있습니다 — 즉, 여러분의 머신에서 파일을 읽고 쓸 수 있습니다.

**Docker 없이 실행하면**, Claude는 사용자 계정이 접근할 수 있는 모든 파일(워크스페이스 외부에 저장된 SSH 키와 자격 증명 포함)에 접근할 수 있습니다. 개인 로컬 사용에는 허용되지만 알아두는 것이 좋습니다.

**Docker Desktop이 설치되어 있으면**, MulmoClaude는 Claude를 자동으로 샌드박스 컨테이너 내부에서 실행합니다. 워크스페이스와 Claude의 자체 설정(`~/.claude`)만 마운트되며 — 파일시스템의 나머지는 Claude에게 보이지 않습니다. 설정은 필요 없습니다: 앱이 시작 시 Docker를 감지하여 자동으로 샌드박스를 활성화합니다.

**Bearer 토큰 인증**: 모든 `/api/*` 엔드포인트는 `Authorization: Bearer <token>` 헤더를 요구합니다. 토큰은 서버 시작 시 자동 생성되고 `<meta>` 태그를 통해 브라우저에 주입됩니다 — 수동 설정 불필요. 유일한 예외는 `/api/files/*` 입니다 (렌더링된 문서의 `<img>` 태그가 헤더를 첨부할 수 없기 때문에 면제). 자세한 내용은 [`docs/developer.md`](docs/developer.md#auth-bearer-token-on-api) 를 참고하세요.

**샌드박스 자격 증명 전달** (선택적): 기본적으로 샌드박스는 호스트 자격 증명에 접근하지 않습니다. 두 개의 환경 변수를 통해 `git` / `gh` 에 필요한 것을 선택적으로 노출할 수 있습니다:

- `SANDBOX_SSH_AGENT_FORWARD=1` — 호스트의 SSH 에이전트 소켓을 전달합니다. 개인 키는 호스트에 유지됩니다.
- `SANDBOX_MOUNT_CONFIGS=gh,gitconfig` — `~/.config/gh` 와 `~/.gitconfig` 를 읽기 전용으로 마운트합니다.

전체 계약 및 보안 참고사항: [`docs/sandbox-credentials.md`](docs/sandbox-credentials.md).

### Docker Desktop 설치

1. [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) 에서 Docker Desktop 다운로드
2. **macOS**: `.dmg` 파일을 열고 Docker를 Applications 로 드래그한 다음 Applications에서 실행
3. **Windows**: 설치 프로그램을 실행하고 안내를 따르세요 (필요 시 WSL2가 자동으로 설정됩니다)
4. **Linux**: [Linux 설치 가이드](https://docs.docker.com/desktop/install/linux/) 를 따르세요
5. Docker Desktop이 시작을 마칠 때까지 기다리세요 — 메뉴 바 / 시스템 트레이의 고래 아이콘이 고정(애니메이션 없음)되어야 합니다
6. MulmoClaude를 재시작하세요 — Docker를 감지하고 첫 실행 시 샌드박스 이미지를 빌드합니다 (일회성, 약 1분 소요)

macOS에서 Docker 샌드박스가 활성화된 경우 자격 증명은 자동으로 관리됩니다 — 앱이 시작 시 시스템 Keychain에서 OAuth 토큰을 추출하고 401 에러 발생 시 갱신하므로 수동 단계가 필요 없습니다.

Docker가 설치되어 있지 않으면 앱이 경고 배너를 표시하고 샌드박싱 없이 계속 작동합니다.

> **디버그 모드**: Docker가 설치되어 있어도 샌드박스 없이 실행하려면 서버를 시작하기 전에 `DISABLE_SANDBOX=1` 을 설정하거나 CLI 플래그 `--disable-sandbox`(`yarn dev --disable-sandbox` / `npx mulmoclaude --disable-sandbox`, Windows PowerShell에서도 동작)를 전달하세요.
>
> **툴 호출 히스토리**: `PERSIST_TOOL_CALLS=1` 을 설정하면 `tool_result` 와 함께 `tool_call` 이벤트(`args` 포함)도 세션 jsonl 에 기록됩니다. `args` 는 크기가 클 수 있고 디스크에 남기고 싶지 않은 페이로드 바이트(이미지 base64, MulmoScript JSON 등)를 포함할 수 있어 기본값은 off 입니다. 페이지 새로고침이나 서버 재시작 후의 디버깅에 유용합니다. [issue #1096](https://github.com/receptron/mulmoclaude/issues/1096) 참고.

## 로깅

서버는 콘솔에 읽기 쉬운 텍스트를 기록하고
`server/system/logs/` 아래의 회전 일별 파일에 전체 충실도의 JSON을
기록합니다. 모든 것은 `LOG_LEVEL`, `LOG_*_FORMAT`, `LOG_FILE_DIR` 등을
통해 설정 가능합니다.

전체 참조, 형식 예시, 회전 동작, 레시피는 [docs/logging.md](docs/logging.md) 를
참고하세요.

## 역할

각 역할은 Claude에게 다른 페르소나, 도구 팔레트, 집중 영역을 부여합니다:

| 역할                | 기능                                                         |
| ------------------- | ------------------------------------------------------------ |
| **General**         | 범용 어시스턴트 — 할 일, 스케줄러, 위키, 문서, 마인드맵      |
| **Office**          | 문서, 스프레드시트, 폼, 프레젠테이션, 데이터 대시보드        |
| **Guide & Planner** | 풍부한 시각적 출력이 포함된 여행 가이드, 요리책, 여행 플래너 |
| **Artist**          | 이미지 생성, 이미지 편집, p5.js를 이용한 생성 예술           |
| **Tutor**           | 적응형 교육 — 설명하기 전에 수준을 평가합니다                |
| **Storyteller**     | 이미지와 HTML 장면이 포함된 인터랙티브 일러스트 이야기       |

역할을 전환하면 Claude의 컨텍스트가 재설정되고 해당 역할에 필요한 도구만 교체되어 — 응답이 빠르고 집중된 상태로 유지됩니다.

## Skills — MulmoClaude에서 Claude Code Skills 실행하기

MulmoClaude는 이미 가지고 있는 **Claude Code skills** 을 나열하고 실행할 수 있습니다. skill 은 YAML 프런트매터 `description` 과 지시사항이 담긴 마크다운 본문이 포함된 `SKILL.md` 파일을 포함한 `~/.claude/skills/<name>/` 아래의 모든 폴더입니다. skill 작성에 대한 자세한 내용은 [Claude Code Skills 문서](https://docs.claude.com/en/docs/claude-code/skills) 를 참고하세요.

### 사용 방법

1. MulmoClaude를 열고 skill 지원 역할 중 하나에 머무르세요: **General**, **Office**, 또는 **Tutor**.
2. Claude에게 skills 를 보여달라고 요청하세요 — 예: _"show my skills"_ 또는 _"list skills"_.
3. Claude가 `manageSkills` 도구를 호출하고, 캔버스에 분할 창 **Skills** 뷰가 열립니다:
   - **왼쪽**: 머신에서 발견된 모든 skill 과 설명 및 스코프 뱃지 (`USER` / `PROJECT`).
   - **오른쪽**: 선택한 skill 의 전체 `SKILL.md` 내용.
4. skill 에서 **Run** 을 클릭하세요. MulmoClaude는 `/<skill-name>` 을 일반 채팅 메시지로 Claude에 전송하며; Claude Code의 슬래시 명령 메커니즘이 `~/.claude/skills/` 를 기준으로 이를 해결하고 동일한 채팅 세션 내에서 skill 의 지시사항을 인라인으로 실행합니다.

추가 입력이나 SKILL.md 본문 복사 붙여넣기가 필요 없습니다 — Run 버튼은 `/skill-name` 의 원클릭 래퍼입니다.

### Skill 발견 — 두 가지 스코프

| 스코프      | 위치                                   | 의미                                                                                            |
| ----------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **User**    | `~/.claude/skills/<name>/SKILL.md`     | 개인 skills, Claude CLI로 여는 모든 프로젝트에서 공유됩니다.                                    |
| **Project** | `~/mulmoclaude/.claude/skills/<name>/` | MulmoClaude-워크스페이스 스코프 skills. 이름이 user와 충돌하면 Project 스코프가 **우선**합니다. |

두 스코프 모두 phase 0에서는 읽기 전용입니다 — 편집은 파일 시스템에서 이루어집니다. 향후 릴리스에서는 MulmoClaude 자체가 project 스코프 skills 를 생성 / 편집할 수 있게 됩니다.

### Docker 샌드박스 vs 비-Docker

MulmoClaude의 기본 **Docker 샌드박스 모드**는 안전성을 위해 Claude Code를 컨테이너에 격리합니다 ([보안](#security) 참고). Skill 동작은 두 모드 간에 다릅니다:

| 모드                                | User skills (`~/.claude/skills/`) | Project skills (`~/mulmoclaude/.claude/skills/`) | 내장 CLI skills (`/simplify`, `/update-config`, …) |
| ----------------------------------- | --------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| **비-Docker** (`DISABLE_SANDBOX=1`) | ✅ 모두 작동                      | ✅                                               | ✅                                                 |
| **Docker 샌드박스** (기본)          | ⚠️ 아래 주의사항 참고             | ✅ 워크스페이스 볼륨을 통해 마운트됨             | ✅                                                 |

**Docker 주의사항 — user skills 가 샌드박스에서 때때로 작동하지 않는 이유:**

- **심볼릭 링크된 `~/.claude/skills/`** — `~/.claude/skills` (또는 하위 항목)가 `~/.claude/` 외부를 가리키는 심볼릭 링크인 경우 (예: `~/.claude/skills → ~/ss/dotfiles/claude/skills`), 심볼릭 링크의 타겟은 컨테이너 내부에 존재하지 않습니다. 링크가 **깨진 상태**로 나타나고 Claude Code는 내장 skills 로만 폴백합니다.
- **샌드박스 이미지 내부의 오래된 Claude CLI** — `Dockerfile.sandbox` 는 이미지 빌드 시점에 CLI 버전을 고정합니다. 해당 버전이 호스트 CLI보다 뒤처져 있다면 (예: 이미지의 2.1.96 vs 호스트의 2.1.105), user-skill 발견이 다르게 동작할 수 있습니다.

**샌드박스와 잘 작동하지 않는 skill 중심 설정에 대한 해결 방법:**

1. **이 세션에 대해 샌드박스 비활성화**:

   ```bash
   # env-var form (any shell supporting VAR=value)
   DISABLE_SANDBOX=1 yarn dev

   # or the equivalent --disable-sandbox CLI flag (Windows PowerShell / npx / IDE run configs)
   yarn dev --disable-sandbox
   npx mulmoclaude --disable-sandbox
   ```

   Claude CLI가 실제 `~/.claude/` 로 실행되어 모든 것이 네이티브로 해결됩니다. 전송하려는 프롬프트를 신뢰할 때 사용하세요 — 신뢰할 수 없는 / 탐색적인 작업에는 여전히 샌드박스가 권장 기본값입니다.

2. **Skills 를 project 스코프로 이동** — 원하는 특정 skills 를 `~/mulmoclaude/.claude/skills/` 에 복사하세요 (이 경로는 샌드박스 내부에서 워크스페이스 볼륨으로 마운트되므로 심볼릭 링크 문제가 없습니다). 어쨌든 MulmoClaude 워크플로우에 특정적인 skills 에 적합합니다.

3. **심볼릭 링크 평탄화** — 심볼릭 링크를 통해 skill 라이브러리를 유지 관리하는 경우 (예: dotfiles 저장소에서), 최상위 `~/.claude/skills` 심볼릭 링크를 실제 디렉토리로 대체하는 것이 가장 간단한 해결책입니다.

### Skill 이 실제로 받는 것

**Run** 을 누르면 MulmoClaude는 슬래시 명령 문자열이 포함된 일반 사용자 턴을 전송합니다:

```text
/my-skill-name
```

이것이 전체 페이로드입니다 — MulmoClaude는 `SKILL.md` 본문이나 추가 컨텍스트를 인라인으로 **포함하지 않습니다**. 본문은 CLI가 슬래시 명령을 해결할 때 Claude Code가 읽는 것입니다. 이렇게 하면 채팅 입력이 작게 유지되고 긴 skills (다수의 킬로바이트 `SKILL.md`)를 프롬프트 컨텍스트를 폭발시키지 않고 안전하게 실행할 수 있습니다.

### 대화를 새 skill 로 저장

생산적인 채팅 이후, MulmoClaude에게 워크플로우를 캡처하도록 요청할 수 있습니다:

```text
"이 대화를 fix-ci 라는 skill 로 만들어 줘"
"publish-flow 라는 skill 로 저장해 줘"
"skill 로 만들어 줘"   ← Claude가 slug를 자동으로 선택
```

Claude가 현재 채팅 전사본을 읽고, 사용한 단계를 정제한 뒤, 새로운 `SKILL.md` 를 `~/mulmoclaude/.claude/skills/<slug>/` 에 작성합니다. skill 은 Skills 뷰에 즉시 나타나며 이후 모든 세션에서 `/<slug>` 로 호출할 수 있습니다.

저장에 관한 참고사항:

- **Project 스코프만** — 저장은 `~/mulmoclaude/.claude/skills/` 로만 이루어지며, 절대 `~/.claude/skills/` 로 이루어지지 않습니다. user 스코프는 MulmoClaude에서 읽기 전용으로 유지됩니다.
- **덮어쓰기 없음** — 동일한 이름의 skill 이 이미 존재하는 경우 (두 스코프 중 하나에서) 저장이 실패하고 Claude가 다른 이름을 요청합니다.
- **Slug 규칙** — 소문자, 숫자, 하이픈; 1–64 자; 선두/말미 또는 연속 하이픈 없음. Claude가 자동으로 선택하며; 특정 이름을 원하면 요청에서 언급하세요.

### 저장된 skill 삭제

Project 스코프 skills 는 Skills 뷰에서 Run 버튼 옆에 **Delete** 버튼이 표시됩니다 (user 스코프 skills 는 읽기 전용 — Delete 버튼이 표시되지 않습니다). 대화 상자를 확인하면 `~/mulmoclaude/.claude/skills/<slug>/SKILL.md` 가 제거됩니다. 해당 폴더에 추가 파일을 수동으로 넣었다면 그대로 남으며; SKILL.md만 제거됩니다.

이름으로 Claude에게 삭제를 요청할 수도 있습니다:

```text
"fix-ci skill 삭제해 줘"
```

## Wiki — Claude Code 를 위한 장기 기억

MulmoClaude는 [Andrej Karpathy의 LLM Knowledge Bases 아이디어](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 에서 영감을 받은 **개인 지식 베이스**를 포함합니다. Claude Code에게 진정한 장기 기억을 제공합니다 — 단순한 짧은 `memory.md` 가 아니라 Claude가 직접 구축하고 유지 관리하는 성장하는 상호 연결된 위키입니다.

**General** 역할은 위키 지원이 내장되어 있습니다. 다음을 시도해 보세요:

- `"Ingest this article: <URL>"` — Claude가 페이지를 가져와 주요 지식을 추출하고 위키 페이지를 생성/업데이트하며 활동을 로그에 기록합니다
- `"What does my wiki say about transformers?"` — Claude가 인덱스를 검색하고 관련 페이지를 읽고 근거가 있는 답변을 종합합니다
- `"Lint my wiki"` — 고아 페이지, 깨진 링크, 누락된 인덱스 항목에 대한 상태 검사
- `"Show me the wiki index"` — 전체 페이지 카탈로그를 캔버스에 렌더링합니다

### 작동 방식

위키는 전적으로 워크스페이스의 평문 마크다운 파일로 존재합니다:

```
<workspace>/data/wiki/
  index.md          ← 모든 페이지 카탈로그 (제목, 설명, 마지막 업데이트)
  log.md            ← 추가 전용 활동 로그
  pages/<slug>.md   ← 엔티티, 개념, 주제당 한 페이지
  sources/<slug>.md ← 원시 수집된 소스
```

Claude는 위키를 탐색하고 유지 관리하기 위해 내장 파일 도구 (`read`, `write`, `glob`, `grep`) 를 사용합니다 — 특별한 데이터베이스나 인덱싱이 필요 없습니다. 상호 참조는 `[[wiki link]]` 구문을 사용하며, 캔버스 UI가 이를 클릭 가능한 내비게이션으로 렌더링합니다.

시간이 지남에 따라 위키는 어떤 역할에서든 참조할 수 있는 개인 지식 베이스로 성장하여, 사용할수록 Claude가 점점 더 유용해집니다.

## Charts (ECharts)

`presentChart` 플러그인은 캔버스에 [Apache ECharts](https://echarts.apache.org/) 시각화를 렌더링합니다. 라인, 바, 캔들스틱, 산키, 히트맵, 네트워크/그래프를 요청하세요 — Claude가 ECharts 옵션 객체를 작성하고 플러그인이 마운트합니다. 모든 차트에는 원클릭 내보내기를 위한 **[↓ PNG]** 버튼이 있습니다.

**General**, **Office**, **Guide & Planner**, **Tutor** 역할에서 사용 가능합니다. 다음을 시도해 보세요:

```text
Chart last quarter's revenue by region as a bar chart
Plot AAPL's daily closes for the last 30 days as a candlestick
Show a sankey of energy flow: coal/gas/solar → electricity → home/industry/transport
```

### 저장

각 `presentChart` 호출은 `<workspace>/artifacts/charts/` 아래에 파일 하나를 작성합니다:

```text
<workspace>/artifacts/charts/
  sales-overview-1776135210389.chart.json
  apple-stock-1776135300000.chart.json
```

단일 문서는 원하는 만큼 차트를 포함할 수 있으며 캔버스에 수직으로 쌓여 렌더링됩니다:

```json
{
  "title": "Apple Stock Analysis",
  "charts": [
    {
      "title": "Daily close",
      "type": "line",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "line", "data": [180, 195, 210] }]
      }
    },
    {
      "title": "Volume",
      "type": "bar",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "bar", "data": [1000000, 1200000, 950000] }]
      }
    }
  ]
}
```

`option` 필드는 ECharts의 [`setOption`](https://echarts.apache.org/en/api.html#echartsInstance.setOption) 에 그대로 전달됩니다 — 이 파일들을 수동 편집할 때 전체 [ECharts 옵션 참조](https://echarts.apache.org/en/option.html) 를 참조할 수 있습니다. 편집 내용은 캔버스에서 문서를 다시 열 때 반영됩니다.

## 선택사항: X (Twitter) MCP 도구

MulmoClaude는 공식 X API v2를 통해 X (Twitter)의 게시물을 읽고 검색하기 위한 선택적 MCP 도구를 포함합니다.

| 도구        | 기능                                    |
| ----------- | --------------------------------------- |
| `readXPost` | URL 또는 트윗 ID로 단일 게시물 가져오기 |
| `searchX`   | 키워드 또는 쿼리로 최근 게시물 검색     |

이 도구들은 **기본적으로 비활성화** 되어 있으며 활성화하려면 X API Bearer Token이 필요합니다.

### 설정

1. [console.x.com](https://console.x.com) 으로 이동하여 X 계정으로 로그인
2. 새 앱을 생성 — Bearer Token이 자동으로 생성됩니다
3. Bearer Token을 복사하여 `.env` 에 추가:
   ```
   X_BEARER_TOKEN=your_bearer_token_here
   ```
4. [console.x.com](https://console.x.com) 에서 계정에 크레딧 추가 (API 호출에 필요)
5. 개발 서버를 재시작하세요 — 도구가 자동으로 활성화됩니다

### 사용

이 도구들은 **커스텀 역할에서만 사용 가능** 합니다. 내장 역할은 기본적으로 포함하지 않습니다 (General 제외). 자체 역할에서 사용하려면:

1. `~/mulmoclaude/roles/<id>.json`에 커스텀 역할 JSON 파일을 생성하거나 편집
2. 해당 `availablePlugins` 목록에 `readXPost` 및/또는 `searchX` 추가

구성되면 `x.com` 또는 `twitter.com` URL을 채팅에 붙여넣으면 Claude가 자동으로 가져와 읽습니다.

## 추가 도구 구성 (웹 설정)

사이드바의 기어 아이콘은 코드 편집 없이 Claude의 도구 세트를 확장할 수 있는 설정 모달을 엽니다. 변경 사항은 다음 메시지에 적용됩니다 (서버 재시작 필요 없음).

### Allowed Tools 탭

한 줄에 하나씩 도구 이름을 붙여넣으세요. 일회성 OAuth 핸드셰이크 후 Claude Code의 내장 MCP 서버 (Gmail, Google Calendar) 에 유용합니다:

```text
mcp__claude_ai_Gmail
mcp__claude_ai_Google_Calendar
```

먼저 터미널에서 `claude mcp` 를 한 번 실행하고 각 서비스에 대한 OAuth 흐름을 완료하세요 — 자격 증명은 `~/.claude/` 아래에 유지됩니다.

### MCP Servers 탭

JSON을 수동 편집하지 않고 외부 MCP 서버를 추가하세요. 두 가지 유형이 지원됩니다:

- **HTTP** — 원격 서버 (예: `https://example.com/mcp`). 모든 모드에서 작동합니다; Docker에서는 `localhost` / `127.0.0.1` URL이 자동으로 `host.docker.internal` 로 재작성됩니다.
- **Stdio** — 로컬 서브프로세스 (예: `npx` MCP), 안전성을 위해 `npx` / `node` / `tsx` 로 제한됩니다. Docker 샌드박스가 **꺼져 있을** 때는 호스트에서 실행됩니다. **켜져 있을** 때는 stdio 항목이 **기본적으로 삭제됩니다** (최소 구성의 샌드박스 이미지는 임의의 런타임을 호스팅할 수 없기 때문) — 대신 `"hostExecInDocker": true` 를 설정하면 해당 서버를 호스트에서 `stdio ↔ HTTP` 게이트웨이 뒤로 실행할 수 있습니다. [docs/mcp-sandbox.md](docs/mcp-sandbox.md) 참조.

stdio 서버에 자격 증명은 **`env`** 맵으로 전달합니다 (`"env": { "IMAP_PASS": "…" }`). 값은 리터럴이며 `mcp.json` 에 저장됩니다 (모드 `0600` 이지만 **평문** — 볼트가 아니라 파일 권한 보호). `hostExecInDocker` 옵트인과 `env` 가 프로세스에 전달되는 방식 등 자세한 내용은 [docs/mcp-sandbox.md](docs/mcp-sandbox.md) 에 있습니다.

구성은 `<workspace>/config/` 아래에 있습니다:

```text
<workspace>/config/
  settings.json    ← 추가 허용 도구 이름
  mcp.json         ← Claude CLI --mcp-config 호환
```

MCP 파일은 Claude CLI의 표준 형식을 사용하므로 머신 간에 복사하거나 `claude` CLI에서 직접 사용할 수도 있습니다.

### 구성 파일 직접 편집

두 파일 모두 평문 JSON입니다 — 설정 UI 대신 어떤 텍스트 편집기로도 편집할 수 있습니다. 서버는 매 메시지마다 파일을 다시 읽으므로:

- 파일 편집 후 서버 재시작이 필요 없습니다.
- 변경 사항은 설정 UI에서도 감지됩니다 — 모달을 닫고 다시 열면 됩니다.
- UI와 파일은 항상 동기화됩니다: UI에서 저장하면 파일을 덮어쓰고, 수동 편집은 다음 열 때 UI에 표시됩니다.

다음과 같은 경우에 편리합니다:

- 다른 워크스테이션에서 MCP 서버를 일괄 임포트 (`mcp.json` 을 복사).
- dotfiles 저장소에서 설정을 버전 관리.
- `"enabled": false` 로 서버를 임시로 주석 처리.

**예시 `mcp.json`** — 원격 HTTP 서버 하나 (공개, 인증 없음)와 로컬 stdio 서버 하나:

```json
{
  "mcpServers": {
    "deepwiki": {
      "type": "http",
      "url": "https://mcp.deepwiki.com/mcp",
      "enabled": true
    },
    "everything": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "enabled": true
    }
  }
}
```

파일을 로드할 때 서버가 강제하는 제약 조건:

- `mcpServers` 키 (서버 id) 는 `^[a-z][a-z0-9_-]{0,63}$` 와 일치해야 합니다.
- HTTP `url` 은 `http:` 또는 `https:` 로 파싱되어야 합니다.
- Stdio `command` 는 `npx`, `node`, 또는 `tsx` 로 제한됩니다.
- 유효성 검사에 실패한 항목은 로드 시 자동으로 삭제됩니다 (경고가 로그됨); 파일의 나머지 부분은 계속 적용됩니다.

**예시** — 자격 증명을 가지며 Docker 샌드박스에서도 실행되는 stdio 서버 (예: IMAP MCP):

```json
{
  "mcpServers": {
    "imap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-imap-mcp"],
      "env": { "IMAP_HOST": "imap.example.com", "IMAP_USER": "me", "IMAP_PASS": "secret" },
      "hostExecInDocker": true,
      "enabled": true
    }
  }
}
```

`hostExecInDocker` 는 해당 서버를 호스트(샌드박스 외부)에서 실행합니다. 서버 단위 플래그이므로 필요한 만큼 여러 서버에 설정할 수 있지만, 신뢰하는 서버에만 사용하세요. 샌드박스가 꺼져 있으면 무시됩니다 (서버는 이미 호스트에서 실행됨).

**예시 `settings.json`**:

```json
{
  "extraAllowedTools": ["mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar"]
}
```

`mcp.json` 에 정의된 서버에 대해 `mcp__<id>` 항목을 나열할 필요가 없습니다 — 모든 에이전트 실행에서 자동으로 허용됩니다. `extraAllowedTools` 는 자체 `mcpServers` 를 통해 도달할 수 없는 도구, 일반적으로 `claude mcp` 를 실행하고 OAuth를 완료한 후 Claude Code의 내장 `mcp__claude_ai_*` 브릿지를 위한 것입니다.

## 채팅 첨부

채팅 입력에 파일을 붙여넣거나 (Ctrl+V / Cmd+V) 드래그 앤 드롭하여 메시지와 함께 Claude에 전송하세요.

| 파일 유형                                           | Claude가 보는 것            | 의존성                        |
| --------------------------------------------------- | --------------------------- | ----------------------------- |
| 이미지 (PNG, JPEG, GIF, WebP, …)                    | 비전 콘텐츠 블록 (네이티브) | 없음                          |
| PDF                                                 | 문서 콘텐츠 블록 (네이티브) | 없음                          |
| 텍스트 (.txt, .csv, .json, .md, .xml, .html, .yaml) | 디코드된 UTF-8 텍스트       | 없음                          |
| DOCX                                                | 추출된 평문 텍스트          | `mammoth` (npm)               |
| XLSX                                                | 시트당 CSV                  | `xlsx` (npm)                  |
| PPTX                                                | PDF로 변환                  | LibreOffice (Docker 샌드박스) |

PPTX 변환은 Docker 샌드박스 이미지 (`libreoffice --headless`) 내부에서 실행됩니다. Docker 없이는 PDF 또는 이미지로 내보내도록 제안하는 메시지가 표시됩니다. 최대 첨부 크기는 30 MB입니다.

## 캔버스 뷰 모드

캔버스 (오른쪽 패널) 는 런처 툴바, URL 쿼리 파라미터 또는 키보드 단축키를 통해 전환 가능한 8가지 뷰 모드를 지원합니다:

| 단축키       | 뷰        | URL 파라미터      | 설명                                |
| ------------ | --------- | ----------------- | ----------------------------------- |
| `Cmd/Ctrl+1` | Single    | (기본)            | 선택한 도구 결과 표시               |
| `Cmd/Ctrl+2` | Stack     | `?view=stack`     | 모든 결과를 수직으로 쌓음           |
| `Cmd/Ctrl+3` | Files     | `?view=files`     | 워크스페이스 파일 탐색기            |
| `Cmd/Ctrl+5` | Scheduler | `?view=scheduler` | 예약된 작업 캘린더                  |
| `Cmd/Ctrl+6` | Wiki      | `?view=wiki`      | 위키 페이지 인덱스                  |
| `Cmd/Ctrl+7` | Skills    | `?view=skills`    | Skills 목록 및 편집기               |
| `Cmd/Ctrl+8` | Roles     | `?view=roles`     | 역할 관리                           |

모든 뷰 모드는 URL 기반입니다: 런처 버튼을 클릭하면 `?view=` 가 업데이트되고 `?view=wiki` (예를 들어)가 포함된 URL로 접속하면 해당 뷰가 복원됩니다. 뷰 모드 목록은 `src/utils/canvas/viewMode.ts` 에서 한 번 정의됩니다 — 새 모드를 추가하는 것은 배열에 항목 하나를 추가하는 것입니다.

## 원격 접속

실행 중인 MulmoClaude에 스마트폰(또는 임의의 브라우저)에서 접속하여 컬렉션, 피드, 커스텀 뷰를 둘러보고 어디서든 채팅을 시작할 수 있습니다. 별도의 계정이나 서버를 설정할 필요가 없습니다. **양쪽 모두 같은 Google 계정으로 로그인**하기만 하면 접속이 활성화됩니다.

**연결 방법**

1. 데스크톱에서 헤더의 **phonelink** 아이콘을 클릭해 _원격 호스트_ 팝오버를 열고 **Google로 로그인**을 선택합니다. MulmoClaude가 해당 Google 사용자로 로그인하고 Firebase(공유 공개 프로젝트 [`mulmoserver`](https://mulmoserver.web.app))를 통해 명령 채널을 엽니다. 호스트가 온라인인 동안 아이콘이 초록색으로 표시됩니다.
2. 스마트폰에서 **[https://mulmoserver.web.app](https://mulmoserver.web.app)** 를 열고 **같은 Google 계정**으로 로그인합니다. 웹 앱이 온라인 상태인 호스트를 찾아 연결합니다.

양쪽이 동일한 Firebase 사용자로 인증되므로 스마트폰과 데스크톱은 오직 자신의 사용자 공간 안에서만 만납니다. 제3자는 호스트에 접근할 수 없습니다.

**Firebase와 Firestore는 오직 전송(transport) 용도로만 사용됩니다** — 스마트폰과 데스크톱 사이에서 명령과 응답을 전달하는 중계 역할입니다. 사용자의 데이터는 어느 쪽에도 **저장되거나 보관되지 않습니다**. 호스트에는 로컬 워크스페이스 파일만 존재하며, 채널을 통과해야 하는 것(예: Firebase Storage를 경유하는 첨부 파일)은 목적지에 도착하는 즉시 삭제됩니다.

**스마트폰에서 할 수 있는 것**

- **컬렉션**과 **피드**를 둘러보고 페이지를 넘깁니다.
- **커스텀 원격 뷰**(custom remote view)를 엽니다 — Claude가 만들어 주는 모바일 친화적인 페이지입니다. 일반 커스텀 뷰가 아니라 _custom remote view_ 를 만들어 달라고 Claude에게 요청하세요. 읽기 전용 또는 쓰기 가능하게 만들 수 있습니다.
- 호스트에서 **채팅을 시작**하고 스마트폰에서 **사진, 동영상, PDF**를 첨부합니다. 첨부 파일의 바이트는 명령 채널에 담기에 너무 크므로 Firebase Storage를 경유합니다. 호스트는 각 파일을 워크스페이스(`data/attachments/`)로 내려받고, 중계용 사본을 삭제한 뒤, 메시지와 함께 파일을 Claude에게 전달합니다.

이 채널은 명령 기반이며 호스트 주도로 동작합니다. 스마트폰이 요청을 보내면 데스크톱의 MulmoClaude가 응답합니다. 호스트를 오프라인으로 전환하려면 팝오버에서 **연결 해제**를 사용하거나 MulmoClaude를 종료하세요.

## 워크스페이스

모든 데이터는 워크스페이스 디렉토리의 평문 파일로 저장되며, 네 가지 의미적 버킷으로 그룹화됩니다 (#284):

```
~/mulmoclaude/
  config/              ← settings.json, mcp.json, roles/, helps/
  conversations/       ← chat/, memory.md, summaries/, searches/
  data/                ← wiki/, todos/, calendar/, contacts/, scheduler/,
                         sources/, transports/
  artifacts/           ← charts/, documents/, html/, html-scratch/,
                         images/, news/, spreadsheets/, stories/
```

전체 참조는 [`docs/developer.md`](docs/developer.md#workspace-layout-mulmoclaude) 를 참고하세요.

### 할 일 목록

할 일 목록은 전용 뷰가 아니라 스키마 기반 **컬렉션(collection)** 으로 만듭니다. Claude 에게 "할 일 목록을 만들어줘" 라고 요청하면 `config/helps/todo-collection.md` 를 따라 `todos` 컬렉션을 작성합니다 — 상태 enum (`Backlog / Todo / In Progress / Done`), `done` 토글, 선택적 우선순위 / 마감 날짜 필드를 가지며 스키마에 따라 kanban / 테이블 / 캘린더 뷰가 자동으로 선택됩니다.

### 스케줄러 및 skill 스케줄링

스케줄러 (`Cmd/Ctrl+5` 또는 `?view=scheduler`) 는 `data/scheduler/items.json` 에 저장된 반복 작업을 관리합니다. 스케줄러 코어 (`@receptron/task-scheduler`) 는 놓친 실행에 대한 따라잡기 로직을 처리하며 `interval`, `daily`, `cron` 스케줄을 지원합니다.

SKILL.md 프런트매터에 `schedule` 필드를 추가하여 skills 를 자동으로 실행하도록 예약할 수 있습니다:

```yaml
---
description: Morning news digest
schedule: daily 08:00
---
```

Claude가 skill 을 스케줄러에 등록하고 지정된 스케줄에 따라 자동으로 실행됩니다.

### 메모리 추출

Claude는 채팅 대화에서 지속적인 사용자 사실을 자동으로 추출하여 `conversations/memory.md` 에 추가합니다. 이는 저널 일일 패스의 일부로 실행됩니다 — 음식 선호도, 작업 습관, 도구 선호도와 같은 사실이 사용자 개입 없이 최근 채팅에서 추출됩니다. 메모리 파일은 항상 에이전트 컨텍스트에 로드되어 Claude가 응답을 개인화할 수 있습니다.

## Monorepo 패키지

공유 코드는 `packages/` 아래의 게시 가능한 npm 패키지로 추출됩니다:

| 패키지                      | 설명                                     | 링크                                                                                                    |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@mulmobridge/protocol`     | 공유 타입 및 상수                        | [npm](https://www.npmjs.com/package/@mulmobridge/protocol) / [source](packages/protocol/)               |
| `@mulmobridge/client`       | Socket.io 클라이언트 라이브러리          | [npm](https://www.npmjs.com/package/@mulmobridge/client) / [source](packages/client/)                   |
| `@mulmobridge/chat-service` | 서버측 채팅 서비스 (DI 팩토리)           | [npm](https://www.npmjs.com/package/@mulmobridge/chat-service) / [source](packages/chat-service/)       |
| `@mulmobridge/cli`          | 터미널 브릿지                            | [npm](https://www.npmjs.com/package/@mulmobridge/cli) / [source](packages/bridges/cli/)                 |
| `@mulmobridge/telegram`     | Telegram 봇 브릿지                       | [npm](https://www.npmjs.com/package/@mulmobridge/telegram) / [source](packages/bridges/telegram/)       |
| `@mulmobridge/slack`        | Slack 봇 브릿지                          | [npm](https://www.npmjs.com/package/@mulmobridge/slack) / [source](packages/bridges/slack/)             |
| `@mulmobridge/discord`      | Discord 봇 브릿지                        | [npm](https://www.npmjs.com/package/@mulmobridge/discord) / [source](packages/bridges/discord/)         |
| `@mulmobridge/line`         | LINE 봇 브릿지                           | [npm](https://www.npmjs.com/package/@mulmobridge/line) / [source](packages/bridges/line/)               |
| `@mulmobridge/whatsapp`     | WhatsApp 브릿지                          | [npm](https://www.npmjs.com/package/@mulmobridge/whatsapp) / [source](packages/bridges/whatsapp/)       |
| `@mulmobridge/matrix`       | Matrix 브릿지                            | [npm](https://www.npmjs.com/package/@mulmobridge/matrix) / [source](packages/bridges/matrix/)           |
| `@mulmobridge/irc`          | IRC 브릿지                               | [npm](https://www.npmjs.com/package/@mulmobridge/irc) / [source](packages/bridges/irc/)                 |
| `@mulmobridge/mattermost`   | Mattermost 브릿지                        | [npm](https://www.npmjs.com/package/@mulmobridge/mattermost) / [source](packages/bridges/mattermost/)   |
| `@mulmobridge/zulip`        | Zulip 브릿지                             | [npm](https://www.npmjs.com/package/@mulmobridge/zulip) / [source](packages/bridges/zulip/)             |
| `@mulmobridge/messenger`    | Facebook Messenger 브릿지                | [npm](https://www.npmjs.com/package/@mulmobridge/messenger) / [source](packages/bridges/messenger/)     |
| `@mulmobridge/google-chat`  | Google Chat 브릿지                       | [npm](https://www.npmjs.com/package/@mulmobridge/google-chat) / [source](packages/bridges/google-chat/) |
| `@mulmobridge/mastodon`     | Mastodon 브릿지                          | [npm](https://www.npmjs.com/package/@mulmobridge/mastodon) / [source](packages/bridges/mastodon/)       |
| `@mulmobridge/bluesky`      | Bluesky 브릿지                           | [npm](https://www.npmjs.com/package/@mulmobridge/bluesky) / [source](packages/bridges/bluesky/)         |
| `@mulmobridge/chatwork`     | Chatwork 브릿지 (일본 비즈니스 채팅)     | [npm](https://www.npmjs.com/package/@mulmobridge/chatwork) / [source](packages/bridges/chatwork/)       |
| `@mulmobridge/xmpp`         | XMPP / Jabber 브릿지                     | [npm](https://www.npmjs.com/package/@mulmobridge/xmpp) / [source](packages/bridges/xmpp/)               |
| `@mulmobridge/rocketchat`   | Rocket.Chat 브릿지                       | [npm](https://www.npmjs.com/package/@mulmobridge/rocketchat) / [source](packages/bridges/rocketchat/)   |
| `@mulmobridge/signal`       | Signal 브릿지 (signal-cli-rest-api 경유) | [npm](https://www.npmjs.com/package/@mulmobridge/signal) / [source](packages/bridges/signal/)           |
| `@mulmobridge/teams`        | Microsoft Teams 브릿지 (Bot Framework)   | [npm](https://www.npmjs.com/package/@mulmobridge/teams) / [source](packages/bridges/teams/)             |
| `@mulmobridge/line-works`   | LINE Works 브릿지 (엔터프라이즈 LINE)    | [npm](https://www.npmjs.com/package/@mulmobridge/line-works) / [source](packages/bridges/line-works/)   |
| `@mulmobridge/nostr`        | Nostr 암호화 DM 브릿지                   | [npm](https://www.npmjs.com/package/@mulmobridge/nostr) / [source](packages/bridges/nostr/)             |
| `@mulmobridge/viber`        | Viber 브릿지                             | [npm](https://www.npmjs.com/package/@mulmobridge/viber) / [source](packages/bridges/viber/)             |
| `@mulmobridge/webhook`      | 일반 HTTP 웹훅 브릿지 (개발자 연결)      | [npm](https://www.npmjs.com/package/@mulmobridge/webhook) / [source](packages/bridges/webhook/)         |
| `@mulmobridge/twilio-sms`   | Twilio를 통한 SMS                        | [npm](https://www.npmjs.com/package/@mulmobridge/twilio-sms) / [source](packages/bridges/twilio-sms/)   |
| `@mulmobridge/email`        | 이메일 브릿지 (IMAP + SMTP)              | [npm](https://www.npmjs.com/package/@mulmobridge/email) / [source](packages/bridges/email/)             |
| `@mulmobridge/mock-server`  | 테스트용 모의 서버                       | [npm](https://www.npmjs.com/package/@mulmobridge/mock-server) / [source](packages/mock-server/)         |
| `@receptron/task-scheduler` | 영속적 작업 스케줄러                     | [npm](https://www.npmjs.com/package/@receptron/task-scheduler) / [source](packages/scheduler/)          |

누구나 어떤 언어로든 브릿지를 작성할 수 있습니다 — [`docs/bridge-protocol.md`](docs/bridge-protocol.md) 에 문서화된 socket.io 프로토콜을 따르기만 하면 됩니다.

## 문서

전체 문서는 [`docs/`](docs/README.md) 에 있습니다. 주요 진입점은 다음과 같습니다:

### 사용자용

| 가이드                                                                                                    | 설명                                                 |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [MulmoBridge 가이드](docs/mulmobridge-guide.en.md) / [日本語](docs/mulmobridge-guide.md)                  | 메시징 앱 (Telegram, Slack, LINE 등) 을 홈 PC에 연결 |
| [스케줄러 가이드](docs/scheduler-guide.en.md) / [日本語](docs/scheduler-guide.md)                         | 반복 자동 작업                                       |
| [Obsidian 통합](docs/tips/obsidian.en.md) / [日本語](docs/tips/obsidian.md)                               | Obsidian을 사용하여 MulmoClaude의 위키 및 문서 탐색  |
| [Telegram 설정](docs/message_apps/telegram/README.md) / [日本語](docs/message_apps/telegram/README.ja.md) | 단계별 Telegram Bot 설정                             |
| [LINE 설정](docs/message_apps/line/README.md) / [日本語](docs/message_apps/line/README.ja.md)             | 단계별 LINE Bot 설정                                 |

### 개발자용

| 가이드                                            | 설명                                             |
| ------------------------------------------------- | ------------------------------------------------ |
| [개발자 가이드](docs/developer.md)                | 환경 변수, 스크립트, 워크스페이스 구조, CI       |
| [Bridge 프로토콜](docs/bridge-protocol.md)        | 새 메시징 브릿지 작성을 위한 와이어 레벨 스펙    |
| [샌드박스 자격 증명](docs/sandbox-credentials.md) | Docker 샌드박스 자격 증명 전달 (SSH, GitHub CLI) |
| [로깅](docs/logging.md)                           | 로그 레벨, 형식, 파일 회전                       |
| [문제 해결](docs/troubleshooting.md)              | 설치 문제 — UI 깨짐, `dist/*` 404, Windows/OneDrive, 재시작 후 `401`, 부팅 경고 |
| [CHANGELOG](docs/CHANGELOG.md)                    | 릴리스 이력                                      |

## 라이선스

MIT — [LICENSE](LICENSE) 를 참고하세요.
