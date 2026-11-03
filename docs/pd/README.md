# Percentile Distribution (応答時間パーセンタイル分布分析)

JENNIFER5 OpenAPI 의 **X-View 트랜잭션 점 데이터**를 수집해 응답시간 분포와 백분위(P50/P90/P99)를
시각화하는 분석 도구입니다. 평균값에 가려지는 **테일 레이턴시(Tail Latency)** 를 정량화합니다.

**JENNIFER Extension Labo**(jennifer-labo) 에서 [PTA](../pta/README.md) 와 하나의 Vite 멀티페이지 앱으로
통합되어 함께 빌드·배포되는 도구입니다. 전체 구조는 [루트 README](../../README.md) 를 참고하세요.

| | PTA | PD (본 도구) |
| :--- | :--- | :--- |
| 데이터 | `/api/dbmetrics/*` (집계 시계열) | `/api/transaction/time` (트랜잭션 단건) |
| 질문 | 시간에 따라 어떻게 변해왔나 | 지금 이 사용자들은 어떤 경험을 하나 |
| 개발 포트 | 5177 (PTA·PD 공용 단일 포트) | 5177 (동일) |
| 배포 경로 | `/pta/` | **`/pd/`** |

---

## 기술 스택

- **Vite 8** (빌드 / 개발 서버 / API 프록시)
- **Chart.js 4** (히스토그램·CDF·랭킹, npm 의존성)
- **Pretendard JP** (웹 폰트, CDN)

백분위 기준선은 외부 annotation 플러그인 없이 자체 Chart.js 플러그인으로 캔버스에 직접 그립니다.

---

## 프로젝트 구조

```
jennifer-labo/                # PTA·PD 통합 Vite 멀티페이지 앱 (패키지명: jennifer-labo)
├── index.html                # 랜딩 페이지 (JENNIFER Extension Labo)
├── pta/                      # PTA 페이지 (docs/pta/ 참고)
├── pd/
│   ├── index.html            # 대시보드 (메인 앱)
│   └── help.html             # 분석 가이드 (팝업 헬프)
├── src/
│   ├── pta/                  # PTA 소스
│   └── pd/
│       ├── main.js           # 엔트리 (초기화만 담당)
│       ├── config.js         # window.PD_CONFIG 참조, MOCK_ALLOWED, CONFIRM_CHUNKS
│       ├── state.js          # 화면 전체가 공유하는 상태와 차트 인스턴스
│       ├── dom.js            # DOM 요소 참조
│       ├── notice.js         # 알림 바
│       ├── range.js          # 조회 기간(시작/종료·프리셋)과 청크 수 표시
│       ├── targets.js        # 도메인 브레드크럼, 인스턴스/비즈니스 목록
│       ├── collect.js        # X-View 수집(照会 버튼)과 실패 시 처리
│       ├── view.js           # 필터·재계산, 요약/차트/상세 패널 렌더링
│       ├── events.js         # DOM 이벤트 바인딩
│       ├── csv.js            # CSV 내보내기
│       ├── help.js           # 도움말 창
│       ├── api.js            # OpenAPI 호출 · 1분 청크 순차 수집
│       ├── stats.js          # TxStore(SoA) · 백분위 · 히스토그램 빈
│       ├── chart.js          # Chart.js 구성 + 백분위 오버레이 플러그인
│       ├── panel.js          # 상세 슬라이드 패널
│       └── style.css         # 스타일시트
├── public/pd/
│   ├── config.js             # 런타임 설정 (window.PD_CONFIG, 빌드 후에도 수정 가능)
│   └── vite.svg
├── docs/pd/                  # 본 문서 디렉터리
│   ├── README.md
│   ├── design_specification.md   # 설계서
│   ├── openapi_specification.md  # OpenAPI 연동 명세서
│   ├── DEPLOY_GUIDE_NGINX.md     # Nginx 배포 가이드
│   └── help_ja.md / help_ko.md   # 도움말 원본
├── vite.config.js            # 5개 엔트리 빌드 · dev 프록시 (토큰 서버 측 주입)
├── fix-paths.js              # 빌드 후 pta/pd HTML 에셋 경로 보정
├── .env.example              # DEV_API_TOKEN 템플릿
└── package.json
```

---

## 빠른 시작

```bash
npm install
cp .env.example .env      # DEV_API_TOKEN 에 로컬 테스트용 토큰 입력
npm run dev               # http://localhost:5177/pd/  (PTA·PD 공용 포트)
```

대상 JENNIFER 서버는 `.env` 의 `DEV_API_TARGET` 으로 지정합니다 (기본값 `https://demo.jennifersoft.co.jp/`).
런타임 `config.js` 의 `BASE_URL` 은 더 이상 사용되지 않습니다.

서버에 접속할 수 없으면 **개발 서버(`npm run dev`)에서만** 모크 데이터로 화면이 그려지며, 상단에 「実データではありません」
경고가 표시됩니다. 운영 빌드에서는 모크를 표시하지 않고 오류 안내만 표시합니다
(필요하면 `config.js` 에 `ALLOW_MOCK: true` 를 명시. 실데이터로 오인될 수 있어 권장하지 않습니다).

```bash
npm run build             # dist/ 생성 (dist/pta, dist/pd, dist/shared — fix-paths.js 자동 실행)
npm run preview
```

---

## 핵심 동작: 1분 청크 순차 수집

JENNIFER OpenAPI 의 X-View 조회(`/api/transaction/time`)는 **1회 최대 1분**이라는 제약이 있습니다
(매뉴얼 부록 5.9.4.5). 따라서 조회 기간을 1분 단위로 분할해 **순차(동시 실행 수 1)** 로 수집합니다.

```
조회 기간  10:00:00 ─────────────────────────► 10:05:00
청크       [10:00-01][10:01-02][10:02-03][10:03-04][10:04-05]
              ①순차     ②순차     ③순차     ④순차     ⑤순차
```

병렬화하지 않는 것은 의도적입니다 — 매뉴얼이 「X-View 조회는 데이터서버 성능에 영향을 준다」고
명시하고 있습니다.

- 진행률 표시 + **중단 버튼** (그 시점까지의 데이터로 확정)
- 청크별 최대 2회 재시도(지수 백오프) 후 실패 시 **해당 청크만 건너뛰고 계속**
- 응답시간은 `Float64Array` 에, 문자열은 인터닝해 `Int32Array` 로 보관 (30만 건 대응)
- 누적 `MAX_POINTS`(기본 30만) 도달 시 수집 중단

---

## 주요 기능

- **히스토그램** — 자동 등간격 / 로그 빈 / 수동 빈. 상한 초과분은 오버플로 빈(주황)으로 합산
- **백분위 오버레이** — P50/P75/P90/P95/P99/P99.9 개별 토글, 선형 보간에 의한 정확 산출
- **CDF(백분위 곡선)** — 테일 확대 모드로 P99 이후의 「절벽」 판별
- **애플리케이션별 P99 TOP10** — 클릭 시 해당 앱으로 드릴다운
- **상세 슬라이드 패널** — 막대 클릭 시 해당 구간 트랜잭션 최대 200건
- **클라이언트 필터** — 비즈니스 / 에러 / 앱 이름. **재조회 없이 즉시 재계산**
  - 비즈니스 필터가 클라이언트 측인 이유: API 에 `business_id` 파라미터가 없기 때문
- **CSV 내보내기** — 백분위 요약 + 빈별 집계

---

## 관련 문서

- [design_specification.md](./design_specification.md) — 설계서 (아키텍처·알고리즘·리스크)
- [openapi_specification.md](./openapi_specification.md) — OpenAPI 연동 명세와 제약사항 대응표
- [DEPLOY_GUIDE_NGINX.md](./DEPLOY_GUIDE_NGINX.md) — Nginx 배포 가이드
