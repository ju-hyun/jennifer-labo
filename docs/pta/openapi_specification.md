# JENNIFER OpenAPI 연동 명세서

성능 트렌드 분석 시스템([system_specification.md](./system_specification.md))에서 데이터를 수집하기 위해 연동한 JENNIFER OpenAPI의 종류, 파라미터, 호출 방법 및 관련 세부 로직을 정리한 명세입니다.

실제 호출부 코드는 [main.js](../../src/pta/main.js)에 구현되어 있습니다.

> **인증 방식 변경 안내**: 아래 각 API는 JENNIFER OpenAPI 자체의 요구사항으로 `token` 쿼리파라미터를 필요로 합니다.
> 다만 본 시스템의 **프론트엔드 코드는 더 이상 `token`을 직접 전송하지 않습니다.** `/api/` 요청이 리버스 프록시를 거쳐
> 업스트림(JENNIFER 서버)으로 전달되는 시점에, 운영 환경은 nginx가, 로컬 개발 환경은 Vite dev 서버 프록시가
> 서버 측에서 토큰을 주입합니다. 자세한 내용은 [system_specification.md §3.2, §5.2](./system_specification.md)와
> [DEPLOY_GUIDE_NGINX.md](./DEPLOY_GUIDE_NGINX.md)를 참고하세요.

---

## 1. OpenAPI 호출 요약

| API 구분 | 엔드포인트 (Endpoint) | HTTP Method | 주요 용도 | 관련 소스 코드 |
| :--- | :--- | :---: | :--- | :--- |
| **도메인 목록 조회** | `/api/domain` | `GET` | 모니터링 대상 도메인 트리 구성 | [main.js: L291-299](https://github.com/ju-hyun/jennifer-labo/blob/main/src/pta/main.js#L291-L299) |
| **인스턴스 목록 조회** | `/api/instance` | `GET` | 선택된 도메인의 에이전트 인스턴스 목록 조회 | [main.js: L550-564](https://github.com/ju-hyun/jennifer-labo/blob/main/src/pta/main.js#L550-L564) |
| **비즈니스 목록 조회** | `/api/business` | `GET` | 선택된 도메인의 업무(서비스 그룹) 목록 조회 | [main.js: L609-619](https://github.com/ju-hyun/jennifer-labo/blob/main/src/pta/main.js#L609-L619) |
| **성능 메트릭 조회** | `/api/dbmetrics/{target}` | `GET` | 도메인/인스턴스/비즈니스별 시계열 데이터 조회 | [main.js: L764-801](https://github.com/ju-hyun/jennifer-labo/blob/main/src/pta/main.js#L764-L801) |

---

## 2. API별 상세 명세

### 2.1. 도메인 목록 조회 API (`/api/domain`)
* **설명**: 프로젝트에 등록된 최상위 도메인 및 그룹 구조를 트리 형태로 조회하여 셀렉터 UI를 구성합니다.
* **호출 방법** (리버스 프록시가 업스트림으로 전달하는 최종 요청 형태):
  ```http
  GET /api/domain?token={TOKEN} HTTP/1.1
  Accept: application/json
  ```
* **요청 파라미터**:
  * `token` *(String, 필수)*: JENNIFER OpenAPI 인증용 보안 토큰. 브라우저는 이 값을 보내지 않으며, 리버스 프록시가 주입한다.

---

### 2.2. 인스턴스 목록 조회 API (`/api/instance`)
* **설명**: 선택된 도메인에 속한 개별 애플리케이션 서버(인스턴스) 목록을 조회합니다.
* **호출 방법** (리버스 프록시가 업스트림으로 전달하는 최종 요청 형태):
  ```http
  GET /api/instance?token={TOKEN}&domain_id={domainId} HTTP/1.1
  Accept: application/json
  ```
* **요청 파라미터**:
  * `token` *(String, 필수)*: 인증 토큰. 리버스 프록시가 주입 (브라우저는 전송하지 않음)
  * `domain_id` *(Integer, 필수)*: 대상 도메인 ID

---

### 2.3. 비즈니스(업무) 목록 조회 API (`/api/business`)
* **설명**: 선택된 도메인에 정의된 비즈니스 트랜잭션 그룹 목록을 계층 구조로 조회합니다.
* **호출 방법** (리버스 프록시가 업스트림으로 전달하는 최종 요청 형태):
  ```http
  GET /api/business?token={TOKEN}&domain_id={domainId} HTTP/1.1
  Accept: application/json
  ```
* **요청 파라미터**:
  * `token` *(String, 필수)*: 인증 토큰. 리버스 프록시가 주입 (브라우저는 전송하지 않음)
  * `domain_id` *(Integer, 필수)*: 대상 도메인 ID

---

### 2.4. 성능 메트릭 조회 API (`/api/dbmetrics/{target}`)
* **설명**: 모니터링 대상에 대하여 일정 기간 동안의 성능 통계 지표를 분 단위로 집계하여 가져옵니다.
* **대상 경로 `{target}` 결정**:
  * 도메인 전체 대상 조회 시: `/api/dbmetrics/domain`
  * 인스턴스 개별 조회 시: `/api/dbmetrics/instance`
  * 비즈니스 개별 조회 시: `/api/dbmetrics/business`
* **호출 방법** (리버스 프록시가 업스트림으로 전달하는 최종 요청 형태):
  ```http
  GET /api/dbmetrics/{target}?token={TOKEN}&domain_id={domainId}&... HTTP/1.1
  Accept: application/json
  ```
* **요청 파라미터**:

| 파라미터명 | 타입 | 필수 여부 | 설명 및 예시 |
| :--- | :---: | :---: | :--- |
| `token` | String | 필수 | OpenAPI 인증용 보안 토큰. 리버스 프록시가 주입 (브라우저는 전송하지 않음) |
| `domain_id` | Integer | 필수 | 모니터링 대상 도메인 ID |
| `instance_id` | Integer | 조건부 필수 | `{target}`이 `instance`일 때 필수 지정 |
| `business_id` | Integer | 조건부 필수 | `{target}`이 `business`일 때 필수 지정 |
| `time_pattern` | String | 필수 | 시간 형식 정의 (시스템 고정값: `yyyyMMddHH`) |
| `start_time` | String | 필수 | 조회 시작 시간 (예: `2026070100` -> 2026년 7월 1일 00시) |
| `end_time` | String | 필수 | 조회 종료 시간 (예: `2026080100` -> 2026년 8월 1일 00시 - Exclusive) |
| `interval_minute`| Integer | 필수 | 집계 간격 (분 단위) <br> - **1440**: 일일 데이터 (메인 트렌드 조회 시 사용) <br> - **60**: 1시간 데이터 (히트맵 분석 시 사용) |
| `metrics` | String | 필수 | 수집 대상 메트릭 식별자 (아래 표 참조) |

* **지원 성능 메트릭 (`metrics` 파라미터값)**:

| 메트릭 식별자 | 명칭 (한국어/日本語) | 표기 단위 | 용도 및 비고 |
| :--- | :--- | :---: | :--- |
| `service_time` | 평균 응답시간 / 応答時間 | `ms` | 트랜잭션당 평균 소요 시간 |
| `service_rate` | TPS / TPS | `TPS` | 초당 트랜잭션 처리량 |
| `concurrent_user`| 동시 사용자 / 同時ユーザ数 | `人` | 액티브 세션 사용자 수 |
| `service_count` | 호출 건수 / Hit数 | `Hits` | 총 트랜잭션 요청 건수 |
| `service_err_count`| 에러 건수 / エラー数 | `개` | 에러가 발생한 트랜잭션 수 |
| `sys_cpu` | 시스템 CPU 사용률 / 시스템CPU | `%` | **인스턴스 전용** (평균 CPU) |
| `max_sys_cpu` | 최대 CPU 사용률 / 최대 CPU | `%` | **인스턴스 전용** (피크 CPU) |
| `heap_usage` | JVM 힙 메모리 사용률 / 힙 메모리 | `%` | **인스턴스 전용** |

---

## 3. 데이터 처리 특징 및 보정 로직

* **조회 기간 제약 우회 (Chunking)**:
  * JENNIFER OpenAPI는 단일 호출 시 **최대 31일**의 연속 조회 제한이 있습니다.
  * 대시보드는 1년 장기 분석을 위해 **1개월 또는 30일 단위의 청크(Chunk)로 기간을 분할하여 병렬 API 요청**을 보낸 후, 클라이언트단에서 데이터를 병합, 정렬 및 중복을 제거하여 최종 시계열 데이터를 완성합니다.
* **에러율 (`err_rate`) 산출**:
  * 에러율 데이터는 OpenAPI에서 직접 제공하지 않으므로 아래의 방식으로 프론트엔드에서 자체 연산하여 화면에 제공합니다.
  * 계산 공식: `에러율 (%) = (service_err_count / service_count) * 100`
