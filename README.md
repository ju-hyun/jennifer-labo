# JENNIFER Extension Labo

JENNIFER5 OpenAPI를 활용한 분석 도구 모음입니다. 하나의 Vite 멀티페이지 앱으로 구성되어 있으며,
같은 빌드·배포 흐름으로 두 개의 도구를 함께 제공합니다.

| 도구 | 경로 | 설명 | 사용 API |
| :--- | :--- | :--- | :--- |
| **PTA** (Performance Trend Analysis) | `/pta/` | 장기 성능 추이 분석. 시계열·히트맵으로 용량 계획(Capacity Planning)을 지원 | `/api/dbmetrics/*` (집계 시계열) |
| **PD** (Percentile Distribution) | `/pd/` | X-View 트랜잭션 단건 데이터로 응답시간 분포와 백분위(P50/P90/P99)를 시각화, 테일 레이턴시를 정량화 | `/api/transaction/time` (트랜잭션 단건) |

랜딩 페이지(`/`)에서 두 도구로 이동할 수 있습니다.

---

## 기술 스택

- **Vite 8** (빌드 / 개발 서버 / API 프록시) — Node.js `^20.19.0` 또는 `>=22.12.0` 필요
- **Chart.js 4** (차트, npm 의존성 — PTA·PD가 번들 청크를 공유)
- **d3-selection / d3-scale / d3-array / d3-hexbin** (PTA 히트맵, npm 의존성으로 번들 — 외부망 없이도 동작)
- **Pretendard JP** (웹 폰트, CDN 로드)

---

## 프로젝트 구조

```
JenniferLabo/
├── index.html                # 랜딩 페이지 (PTA·PD 진입)
├── pta/                      # PTA 페이지
│   ├── index.html            #   대시보드
│   └── help.html             #   분석 가이드
├── pd/                       # PD 페이지
│   ├── index.html            #   대시보드
│   └── help.html             #   분석 가이드
├── src/
│   ├── pta/                  # PTA 소스 (main 진입점 + 역할별 모듈, lib/ 순수 계산, style.css)
│   ├── pd/                   # PD 소스 (main 진입점 + 역할별 모듈, api, stats, chart, panel, style.css)
│   └── shared/               # PTA·PD 공통 (http, domain-tree, html, percentile)
├── public/
│   ├── pta/config.js         # PTA 런타임 설정 (window.PTA_CONFIG)
│   └── pd/config.js          # PD 런타임 설정 (window.PD_CONFIG)
├── docs/
│   ├── pta/                  # PTA 문서 (README, 사양서, OpenAPI 명세, 도움말, 배포 가이드)
│   └── pd/                   # PD 문서 (README, 설계서, OpenAPI 명세, 도움말, 배포 가이드)
├── vite.config.js            # 5개 엔트리 빌드 + 개발 서버 API 프록시(토큰 서버측 주입)
├── fix-paths.js              # 빌드 후 pta/pd HTML의 에셋 경로 보정
├── deploy.sh                 # dist/ 를 EC2 nginx 로 rsync 배포 (git 제외)
├── .env.example              # 로컬 개발용 DEV_API_TOKEN 템플릿
└── package.json
```

빌드 결과(`dist/`)는 다음과 같이 나뉩니다.

```
dist/
├── index.html                # 랜딩
├── pta/  (index.html, help.html, config.js, asserts/)
├── pd/   (index.html, help.html, config.js, asserts/)
└── shared/asserts/           # PTA·PD 공용 청크 (chart.js 등). CSS 는 각 앱의 asserts/ 아래
```

---

## 빠른 시작 (Quick Start)

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경 설정 (Runtime Configuration)

앱별 설정은 `public/<app>/config.js` 에서 관리하며, 빌드 후에도 `dist/<app>/config.js` 를 직접 수정하면 즉시 반영됩니다.
**API 인증 토큰은 이 파일에 두지 않습니다** — 브라우저에 그대로 노출되는 정적 파일이기 때문입니다.

```javascript
// public/pta/config.js
window.PTA_CONFIG = { API_DOMAIN: '', TIMEZONE: 'Asia/Tokyo' };

// public/pd/config.js
window.PD_CONFIG = {
  API_DOMAIN: '',
  TIMEZONE: 'Asia/Tokyo',  // JENNIFER 서버의 시간대. 조회 기간을 서버 기준 시각으로 만든다
  CHUNK_WAIT_MS: 0,     // 1분 청크 간 웨이트(ms). 데이터서버 부하가 우려되면 100~500 권장
  MAX_POINTS: 300000,   // 누적 트랜잭션 건수의 안전 상한
  CONFIRM_CHUNKS: 120   // 이 횟수(=분)를 넘는 조회는 실행 전에 확인창을 표시
};
```

| 변수명 | 대상 | 설명 |
|---|---|---|
| `API_DOMAIN` | PTA, PD | 프록시 없이 API 서버에 직접 요청할 때 사용 (Nginx 배포 시 비워둠) |
| `TIMEZONE` | PTA, PD | JENNIFER 서버의 시간대(IANA 이름, 배포 기본값 `Asia/Tokyo`). 조회 기간(PTA의 월 경계, PD의 입력 시각)을 서버의 시각 기준으로 만듭니다. 브라우저와 시간대가 달라도 서버 기준으로 조회됩니다. 비우거나 항목을 지우면 브라우저의 로컬 시각을 씁니다(이전 동작) |
| `CHUNK_WAIT_MS` | PD | 트랜잭션 수집 시 1분 청크 간 대기 시간 |
| `MAX_POINTS` | PD | 누적 트랜잭션 건수 상한 |
| `CONFIRM_CHUNKS` | PD | 조회가 이 횟수(1분 = 1회)를 넘으면 실행 전에 확인창 표시 (기본 120) |
| `ALLOW_MOCK` | PTA, PD | 서버 접속 실패 시 **모크 데이터**를 표시할지 여부 (기본: 개발 서버에서만 허용). 운영에서는 지정하지 마세요 — 실데이터로 오인될 수 있습니다 |

> 이전 버전의 `BASE_URL` 은 사용되지 않습니다(남아 있어도 무시). 개발 서버 프록시 대상은 `.env` 의 `DEV_API_TARGET`
> (기본: 데모 서버), 운영은 nginx 설정으로 지정합니다.

### 3. API 토큰 설정 (로컬 개발)

클라이언트 코드는 토큰을 알지 못합니다. 요청이 업스트림으로 전달되는 시점에 서버 측
(운영: nginx / 로컬: Vite dev 프록시)에서 토큰을 주입합니다.

```bash
cp .env.example .env
# .env 파일을 열어 DEV_API_TOKEN=<로컬 테스트용 토큰> 입력
```
`.env`는 `.gitignore`에 포함되어 있어 커밋되지 않습니다.

### 4. 개발 서버 실행
```bash
npm run dev
```
개발 서버는 **포트 5177 하나**로 두 도구를 모두 제공합니다.

- 랜딩 페이지: `http://localhost:5177/`
- PTA 대시보드: `http://localhost:5177/pta/`
- PD 대시보드: `http://localhost:5177/pd/`

> 개발 서버는 기본으로 **본인 PC(localhost)에서만** 접속됩니다. 프록시가 `DEV_API_TOKEN`을 자동으로 붙이기 때문에
> 외부에 열면 같은 네트워크의 누구나 그 토큰으로 API를 호출할 수 있어서입니다. VM/컨테이너 밖에서 접속해야 하면
> `.env`에 `DEV_HOST=0.0.0.0`을 지정하세요. 업스트림 TLS 인증서는 기본으로 검증합니다.
> 터미널에 `http proxy error ... self-signed certificate` 가 나오면(자가 서명 인증서 서버나 사내 TLS 검사 환경),
> `.env`에 `DEV_INSECURE_TLS=1`을 추가하거나, 검증을 유지하려면 `NODE_EXTRA_CA_CERTS=/경로/ca.pem npm run dev`
> 로 해당 인증서만 신뢰하세요 (자세한 내용은 `.env.example`).

개발 서버의 `/api` 요청은 `https://demo.jennifersoft.co.jp/` 로 프록시됩니다 (`vite.config.js`).

---

## 테스트

```bash
npm run lint  # ESLint (미사용 변수, 미정의 이름, 누락된 import 등)
npm test      # Node 내장 테스트 러너 (node --test). 추가 의존성 없음
```

`tests/` 에는 다음의 회귀 테스트가 있습니다.

- PD: API 계층(청크 분할·재시도·중단), 통계 엔진(필터·히스토그램·퍼센타일)
- PTA: 순수 계산 로직(`src/pta/lib/` — 시계열 병합·에러율·월별 평균/전월 대비·요일×시간 집계·IQR 임계값)
- 공통(`src/shared/`): HTTP 호출·401 처리, 도메인 트리, 이스케이프, 퍼센타일

GitHub Actions(`.github/workflows/ci.yml`)가 push/PR 마다 린트·테스트·빌드·`npm audit`(운영 의존성)을 실행합니다.

> `package.json` 의 `overrides` 는 개발 도구(ESLint)가 의존하는 `minimatch` 의 알려진 취약점(DoS)을 패치된 버전으로
> 올리기 위한 것입니다. 운영 번들에는 포함되지 않습니다.

## 빌드 및 배포

### 빌드
```bash
npm run build
```
`vite build` 후 `fix-paths.js` 가 자동 실행되어 `pta/`, `pd/` 하위 HTML의 에셋 경로를 상대 경로로 보정합니다.

### 배포
```bash
./deploy.sh -b     # 빌드 후 배포
./deploy.sh -n     # dry-run (전송 없이 변경 사항만 확인)
./deploy.sh        # 현재 dist/ 를 그대로 배포
```
`deploy.sh` 는 서버·SSH 정보를 포함하므로 `.gitignore` 대상입니다. nginx 의 API 프록시 및 토큰 서버측 주입,
HTTPS 설정 등 상세 절차는 공통 배포 가이드를 참고하세요. 운영 배포에는 **HTTPS, Basic 인증, API 화이트리스트**
적용을 권장합니다 (프록시가 서버의 API 토큰을 자동으로 붙이므로, 접근 제한이 없으면 토큰이 공개된 것과 같습니다).

- [Nginx 배포 가이드 (공통)](./docs/DEPLOY_GUIDE_NGINX.md) — 기준 문서
- [PTA 배포 가이드](./docs/pta/DEPLOY_GUIDE_NGINX.md) · [PD 배포 가이드](./docs/pd/DEPLOY_GUIDE_NGINX.md) — 도구별 고유 내용

---

## 문서

| 도구 | 문서 |
| :--- | :--- |
| PTA | [README](./docs/pta/README.md) · [시스템 사양서](./docs/pta/system_specification.md) · [OpenAPI 명세](./docs/pta/openapi_specification.md) · 도움말 [ko](./docs/pta/help_ko.md) / [ja](./docs/pta/help_ja.md) |
| PD | [README](./docs/pd/README.md) · [설계서](./docs/pd/design_specification.md) · [OpenAPI 명세](./docs/pd/openapi_specification.md) · 도움말 [ko](./docs/pd/help_ko.md) / [ja](./docs/pd/help_ja.md) |

