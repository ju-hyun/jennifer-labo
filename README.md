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

- **Vite 4** (빌드 / 개발 서버 / API 프록시)
- **Chart.js 4** (차트, npm 의존성 — PTA·PD가 번들 청크를 공유)
- **D3.js / d3-hexbin** (PTA 히트맵, CDN 로드)
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
│   ├── pta/                  # PTA 소스 (main.js, style.css)
│   └── pd/                   # PD 소스 (main, api, chart, panel, stats, style.css)
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
└── shared/asserts/           # PTA·PD 공용 청크 (chart.js 등) 및 CSS
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
window.PTA_CONFIG = { BASE_URL: 'https://your-jennifer-server/', API_DOMAIN: '' };

// public/pd/config.js
window.PD_CONFIG = {
  BASE_URL: 'https://your-jennifer-server/',
  API_DOMAIN: '',
  CHUNK_WAIT_MS: 0,     // 1분 청크 간 웨이트(ms). 데이터서버 부하가 우려되면 100~500 권장
  MAX_POINTS: 300000    // 누적 트랜잭션 건수의 안전 상한
};
```

| 변수명 | 대상 | 설명 |
|---|---|---|
| `BASE_URL` | PTA, PD | API 프록시 대상 주소 |
| `API_DOMAIN` | PTA, PD | 프록시 없이 API 서버에 직접 요청할 때 사용 (Nginx 배포 시 비워둠) |
| `CHUNK_WAIT_MS` | PD | 트랜잭션 수집 시 1분 청크 간 대기 시간 |
| `MAX_POINTS` | PD | 누적 트랜잭션 건수 상한 |

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

개발 서버의 `/api` 요청은 `https://demo.jennifersoft.co.jp/` 로 프록시됩니다 (`vite.config.js`).

---

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
HTTPS 설정 등 상세 절차는 각 도구의 배포 가이드를 참고하세요.

- [PTA 배포 가이드](./docs/pta/DEPLOY_GUIDE_NGINX.md)
- [PD 배포 가이드](./docs/pd/DEPLOY_GUIDE_NGINX.md)

---

## 문서

| 도구 | 문서 |
| :--- | :--- |
| PTA | [README](./docs/pta/README.md) · [시스템 사양서](./docs/pta/system_specification.md) · [OpenAPI 명세](./docs/pta/openapi_specification.md) · 도움말 [ko](./docs/pta/help_ko.md) / [ja](./docs/pta/help_ja.md) |
| PD | [README](./docs/pd/README.md) · [설계서](./docs/pd/design_specification.md) · [OpenAPI 명세](./docs/pd/openapi_specification.md) · 도움말 [ko](./docs/pd/help_ko.md) / [ja](./docs/pd/help_ja.md) |

