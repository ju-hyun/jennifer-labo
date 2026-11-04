# JENNIFER OpenAPI 연동 명세서 (Percentile Distribution)

응답시간 백분위 분포 분석 시스템([design_specification.md](./design_specification.md))이 사용하는
JENNIFER5 OpenAPI 의 엔드포인트, 파라미터, 응답 스키마 및 제약사항을 정리한 문서입니다.

- **근거 문서**: `JENNIFER5マニュアル.pdf` 부록 5.9 「URIを利用したJENNIFERデータの運用(OpenAPI)」
- **실제 호출부**: [src/pd/api.js](../../src/pd/api.js)

> **인증 방식**: 각 API 는 `token` 쿼리파라미터를 요구하지만, **프론트엔드 코드는 `token` 을 직접 전송하지 않습니다.**
> `/api/` 요청이 리버스 프록시를 거쳐 업스트림(JENNIFER 뷰서버)으로 전달되는 시점에,
> 운영 환경은 nginx 가, 로컬 개발 환경은 Vite dev 서버 프록시가 서버 측에서 토큰을 주입합니다.

---

## 1. 호출 요약

| 구분 | 엔드포인트 | 부록 절 | 용도 | 구현 |
| :--- | :--- | :---: | :--- | :--- |
| 도메인 목록 | `/api/domain` | 5.9.1.1 | 도메인 트리(브레드크럼) 구성 | `fetchDomains()` |
| 비즈니스 목록 | `/api/business` | 5.9.1.2 | 비즈니스 셀렉터 | `fetchBusinesses()` |
| 인스턴스 목록 | `/api/instance` | 5.9.1.3 | 인스턴스 셀렉터 | `fetchInstances()` |
| **X-View 트랜잭션** | **`/api/transaction/time`** | **5.9.4.5** | **분포 분석의 원본 데이터** | `fetchTransactionChunk()` |

---

## 2. X-View 트랜잭션 조회 (`/api/transaction/time`)

본 시스템의 핵심 엔드포인트입니다.

### 2.1 요청

```http
GET /api/transaction/time
    ?domain_id={domainId}
    &instance_id={id1,id2,...}
    &start_time=20260910100000
    &end_time=20260910100100
    &time_pattern=yyyyMMddHHmmss
    &token={TOKEN}
Accept: application/json
```

| 파라미터 | 타입 | 필수 | 설명 |
| :--- | :---: | :---: | :--- |
| `token` | String | 필수 | 인증 토큰. **리버스 프록시가 주입** (브라우저는 전송하지 않음) |
| `domain_id` | int | 필수 | 대상 도메인 ID |
| `instance_id` | array | 선택 | **쉼표 구분 배열**. 미지정 시 도메인 내 전체 인스턴스 |
| `start_time` | String | 필수 | 조회 시작 시각 |
| `end_time` | String | 필수 | 조회 종료 시각. 시작보다 작으면 에러 |
| `time_pattern` | String | 선택 | 시간 형식. **본 시스템은 항상 `yyyyMMddHHmmss` 를 명시 전송** (§3-C7) |

### 2.2 응답

```jsonc
{
  "result": [
    {
      "domainId": 7908, "domainName": "ENV-TEST",
      "instanceId": 30004, "instanceOid": 95540, "instanceName": "IBM8-T8",
      "business": [57, 54], "businessId": [57, 54], "businessName": ["B2", "T1"],
      "txid": "2936735539299047426", "guid": "",
      "clientIp": "172.17.0.1", "clientId": "-2216399679652572688", "userId": "",
      "networkTime": 0, "frontendTime": 0,
      "startTime": "20190424095930",   // time_pattern と同じ書式で返る
      "endTime": "20190424100002",
      "responseTime": 15900,           // ms — 히스토그램의 유일한 필수 필드
      "cpuTime": 2, "sqlTime": 1896, "fetchTime": 344, "externalcallTime": 0,
      "errorType": "",                 // "" = 정상
      "applicationName": "/simula.jsp"
    }
  ]
}
```

### 2.3 필드 사용처

| 필드 | 사용처 |
| :--- | :--- |
| `responseTime` | 히스토그램 / 백분위 / CDF / 요약 카드 — **필수** |
| `applicationName` | 애플리케이션별 P99 랭킹, 부분일치 필터, 상세 패널 |
| `errorType` | 에러율 카드, 에러 필터, 상세 패널의 에러 강조 |
| `businessId[]` | **비즈니스 클라이언트 필터** (API 에 해당 파라미터가 없음 — §3-C3) |
| `instanceName` | 상세 패널 |
| `startTime` | 상세 패널의 시각 표시 |
| `cpuTime`, `sqlTime`, `fetchTime`, `externalcallTime` | 상세 패널의 응답시간 분해 |
| `txid` | 상세 패널의 식별자, **청크 경계의 중복 제거**(C8) |
| `guid`, `clientIp`, `userId` | 향후 확장용 |

---

## 3. 제약사항과 구현상의 대응

부록 5.9.4.5 의 명시적 제약이 본 시스템 설계를 직접 규정합니다.

| # | 명세 원문의 제약 | 구현상의 대응 |
| :-- | :--- | :--- |
| **C1** | 「照会時間範囲は最大1分まです」 | **1분 단위 청크 분할이 필수**. `buildChunks()` 가 조회 기간을 60초 단위로 분할하며(인접한 청크는 경계 시각을 공유 — C8), 끝의 자투리 구간은 실제 종료 시각을 사용 |
| **C2** | 「X-View基本データの照会はデータサーバに負荷を与えます」 | **병렬화하지 않고 동시 실행 수 1 의 순차 루프**로 수집. 청크 간 웨이트(`CHUNK_WAIT_MS`) 설정 가능 |
| **C3** | `business_id` 파라미터가 존재하지 않음 | 비즈니스 필터는 수집 후 `businessId[]` 배열에 대해 **클라이언트 측에서** 적용 |
| **C4** | `instance_id` 는 쉼표 구분 배열 | 다중 인스턴스 선택으로 확장 가능한 형태(`instanceIds.join(',')`)로 구현 |
| **C5** | 반환 건수 상한·페이징 파라미터 없음 | 1분당 반환 건수는 서버에 위임하고, **클라이언트 측 누적 상한**(`MAX_POINTS`, 기본 30만)으로 브라우저를 보호 |
| **C6** | 공식 예제에서 `start=1000, end=1001` 요청에 `startTime=0959` 인 레코드가 포함됨 | 이 API 는 **해당 구간에 "종료"한 트랜잭션**을 반환한다. 구간을 걸친 장시간 트랜잭션도 누락 없이 포착되므로, 테일 분석에는 오히려 바람직한 동작 |
| **C7** | `time_pattern` 미지정 시 기본값이 원문에서 모순 (표는 `yyyyMMddHHmmssSSS`, 비고는 「unix ms」) | **항상 `time_pattern=yyyyMMddHHmmss` 를 명시 전송**하여 모호성을 제거. 응답 파서는 `yyyyMMddHHmm`·`yyyyMMddHHmmss`·`yyyyMMddHHmmssSSS`·unix ms 를 모두 허용 |
| **C8** | `start_time` / `end_time` 이 **경계 시각을 포함하는지 명시되어 있지 않음** (공식 온라인 레퍼런스는 확인하지 못함) | 청크 `i` 의 `end_time` 과 `i+1` 의 `start_time` 이 같은 시각이므로, API 가 양쪽을 포함하면 경계에서 종료한 트랜잭션이 2번 반환될 수 있다. **직전 청크와 `txid` 가 같은 행을 제외**한다(`dropBoundaryDuplicates()`). 경계가 배타적이면 중복이 생기지 않고, 양쪽을 포함해도 이중 집계되지 않는다. 제외한 건수는 화면에 알린다 |

### 3.1 실패 처리

- 각 청크는 최대 **2회 재시도**(지수 백오프 300ms → 900ms) 후, 계속 실패하면 **해당 청크만 건너뛰고 진행**합니다.
- 완료 시 `N/M 청크 취득 실패` 를 화면에 경고 표시합니다.
- **401(인증 실패)** 은 재시도하지 않고 즉시 중단합니다 (토큰 설정 문제이므로 재시도가 무의미).

---

## 4. 대상 리스트 API

### 4.1 `/api/domain` (부록 5.9.1.1)
파라미터는 `token` 뿐입니다. `groupHierarchy` 배열을 트리로 변환해 브레드크럼 셀렉터를 구성합니다.

```jsonc
{ "result": [ { "domainId": 2000, "name": "BATCH", "groupHierarchy": ["TEST"], ... } ] }
```

### 4.2 `/api/instance` (부록 5.9.1.3)
`domain_id` 필수. `instanceId` / `name` / `status` 등을 반환합니다.

### 4.3 `/api/business` (부록 5.9.1.2)
`domain_id` 필수. `businessIndex` 가 `"0.0.2"` 형태의 계층 인덱스이므로,
점(`.`)의 개수만큼 셀렉터에 들여쓰기를 적용합니다.

```jsonc
{ "result": [ { "businessId": 5, "name": "営業2", "businessIndex": "0.0.0", ... } ] }
```

---

## 5. 참고

- 온라인 레퍼런스: https://jennifersoft.github.io/jennifer-developer-guide/#/openapi.html
- 토큰 발급: `[設定 > JENNIFERサーバ > 認証トークン管理]` 에서 **Open API** 타입으로 생성
- 접근 IP 제한: 뷰서버 `server_view.conf` 의 `openapi_permission_ip`
