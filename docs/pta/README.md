# Performance Trend Analysis

JENNIFER5 OpenAPI를 활용한 성능 추이 분석 도구입니다.
장기 성능 데이터를 시각화하고 시계열·히트맵 분석을 통해 용량 계획(Capacity Planning)을 지원합니다.

---

## 기술 스택

- **Vite** (빌드 도구 / 개발 서버)
- **Chart.js** (메인 시계열 차트, npm 의존성)
- **D3.js / d3-hexbin** (Overall 히트맵, 요일×시간대 히트맵, CDN 로드)
- **Pretendard JP** (웹 폰트, CDN 로드)

---

## 프로젝트 구조

```
performance-trend-analysis/
├── index.html              # 랜딩 페이지 (JENNIFER Extension Labo)
├── pta/
│   ├── index.html          # PTA 대시보드 (메인 앱)
│   └── help.html           # 분석 가이드 (팝업 헬프)
├── src/
│   ├── main.js             # 핵심 로직 (API, 차트, 히트맵, 인터랙션) — window.PTA_CONFIG를 직접 참조
│   └── style.css           # 전체 스타일시트
├── public/pta/
│   ├── config.js           # 런타임 설정 파일 (BASE_URL, API_DOMAIN — 빌드 후에도 수정 가능)
│   └── vite.svg            # 파비콘
├── vite.config.js          # Vite 빌드 및 프록시 설정 (로컬 개발용 API 토큰 서버측 주입 포함)
├── fix-paths.js            # 빌드 후 경로 보정 스크립트
├── .env.example            # 로컬 개발용 DEV_API_TOKEN 템플릿 (.env로 복사해서 사용, git 제외)
├── help_ko.md              # 도움말 원본 (한국어)
├── help_ja.md              # 도움말 원본 (일본어)
├── openapi_specification.md # JENNIFER OpenAPI 연동 명세서
├── system_specification.md # 시스템 상세 사양서
├── DEPLOY_GUIDE_NGINX.md   # Nginx 배포 가이드
└── package.json
```

---

## 빠른 시작 (Quick Start)

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경 설정 (Runtime Configuration)

빌드 전·후 모두 설정을 변경할 수 있도록 `public/pta/config.js` 파일을 사용합니다. **API 인증 토큰은 이 파일에 두지 않습니다** — 브라우저에 그대로 노출되는 정적 파일이기 때문입니다.

```javascript
window.PTA_CONFIG = {
  BASE_URL: 'https://your-jennifer-server/',
  API_DOMAIN: ''
};
```

| 변수명 | 설명 |
|---|---|
| `BASE_URL` | Vite 개발 서버의 API 프록시 대상 주소 |
| `API_DOMAIN` | 프록시 없이 API 서버에 직접 요청할 때 사용 (Nginx 배포 시 비워둠) |

> [!NOTE]
> `dist/pta/config.js`를 수정한 후 브라우저를 새로고침하면 변경사항이 즉시 반영됩니다. 다시 빌드할 필요가 없습니다.

### 3. API 토큰 설정 (로컬 개발)

클라이언트 코드는 JENNIFER OpenAPI 토큰을 전혀 알지 못합니다. 대신 요청이 업스트림으로 전달되는 시점에 서버 측(운영: nginx / 로컬: Vite dev 프록시)에서 토큰을 주입합니다.

```bash
cp .env.example .env
# .env 파일을 열어 DEV_API_TOKEN=<로컬 테스트용 토큰> 입력
```
`.env`는 `.gitignore`에 포함되어 있어 커밋되지 않습니다. 운영 환경의 토큰 설정 방법은 [DEPLOY_GUIDE_NGINX.md](./DEPLOY_GUIDE_NGINX.md)를 참고하세요.

### 4. 개발 서버 실행
```bash
npm run dev
```
- 랜딩 페이지: `http://localhost:5177/`
- PTA 대시보드: `http://localhost:5177/pta/`

---

## 주요 기능

- **7종 메트릭 분석**: 응답시간, TPS, Hit수, 동시사용자, 에러율, CPU, 힙메모리
- **비지니스 / 인스턴스 전환**: 도메인 내에서 비지니스 단위 또는 인스턴스 단위로 분석 대상 전환
- **계층형 도메인 셀렉터**: 브레드크럼 방식의 도메인 그룹 탐색
- **이동평균선 (7일/30일)**: 장기 트렌드 분석
- **드래그 기간 선택 및 키보드 탐색**: 방향키로 구간 이동, Shift+방향키로 범위 확장/축소
- **Overall 히트맵**: D3 Hexbin 기반의 부하 vs 성능 상관 분석
- **요일×시간대 히트맵**: IQR 통계 기반의 자동 이상치 감지
- **상세 슬라이드 패널**: 히트맵 셀 클릭 시 인라인 바 차트로 상세 데이터 확인
- **팝업 도움말**: 섹션별 문맥 연동 분석 가이드
- **Mock 데이터 폴백**: API 장애 시 자동 샘플 데이터 생성

---

## 배포 (Production Deployment)

### 빌드
```bash
npm run build
```
빌드 결과물은 `dist/` 폴더에 생성됩니다. `fix-paths.js`가 자동 실행되어 `pta/` 하위 HTML의 에셋 경로를 보정합니다.

> [!IMPORTANT]
> `BASE_URL`/`API_DOMAIN` 설정은 `public/pta/config.js`에서 관리하며, 빌드 후에도 `dist/pta/config.js`를 수정하여 즉시 반영할 수 있습니다.
> API 토큰은 이 파일이 아닌 **nginx 설정**에서 관리합니다 (아래 참고).

### Nginx 배포
Nginx 환경에서의 상세한 배포 절차(API 프록시 및 토큰 서버측 주입, HTTPS 적용 등)는 [DEPLOY_GUIDE_NGINX.md](./DEPLOY_GUIDE_NGINX.md)를 참고하세요.
