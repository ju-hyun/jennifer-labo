# Nginx 배포 가이드 (Percentile Distribution)

> **배포 절차와 Nginx 설정은 공통 문서로 통합되었습니다 → [Nginx 배포 가이드 (공통)](../DEPLOY_GUIDE_NGINX.md)**
>
> PTA 와 PD 는 하나의 앱(`dist/`)으로 빌드·배포되고 `/api/` 프록시를 공유하므로, 보안 설정(HTTPS, Basic 인증,
> API 화이트리스트, 토큰 분리, 백엔드 인증서 검증, 레이트 리밋)이 어긋나지 않도록 설정을 한 곳에서만 관리합니다.
> 이 문서에는 PD 고유 내용만 남깁니다.

PD 접속 경로는 `/pd/` 입니다. PTA 관련 내용은 [PTA 배포 가이드](../pta/DEPLOY_GUIDE_NGINX.md)를 참고하세요.

## 런타임 설정 (`config.js`)

`public/pd/config.js` 로 관리하며, 빌드 후에도 `dist/pd/config.js` 를 직접 수정하면 반영됩니다.

```javascript
window.PD_CONFIG = {
  API_DOMAIN: '',      // Nginx 프록시 사용 시 비워둠

  CHUNK_WAIT_MS: 0,    // 1분 청크 간 웨이트(ms). 데이터서버 부하가 우려되면 100~500 권장
  MAX_POINTS: 300000,  // 누적 트랜잭션 건수의 안전 상한
  CONFIRM_CHUNKS: 120  // 이 횟수(=분)를 넘는 조회는 실행 전에 확인창 표시
};
```

> **주의**: JENNIFER OpenAPI 인증 토큰은 이 파일(브라우저에 그대로 노출되는 정적 파일)에 넣지 않습니다.
> 토큰은 공통 가이드의 Nginx 설정(`labo_secrets.conf`)에서 서버 측으로만 주입합니다.

## PD 가 사용하는 API (프록시 화이트리스트 대상)

- `/api/domain`, `/api/instance`, `/api/business`
- `/api/transaction/time` (X-View 단건 조회)

## 운영상의 주의 (데이터서버 부하)

X-View 트랜잭션 조회는 **JENNIFER 데이터서버에 부하를 줍니다** (매뉴얼 부록 5.9.4.5 명시).
본 시스템은 동시 실행 수 1 의 순차 호출로 이를 완화하고 있으나, 다수 사용자가 동시에 장기간을 조회하면
데이터서버에 영향이 있을 수 있습니다. 필요 시 다음을 검토하세요.

- `config.js` 의 `CHUNK_WAIT_MS` 를 100~500 으로 설정해 호출 간격을 늘린다
- `MAX_POINTS` 를 낮춰 1회 조회량을 제한한다
- 공통 가이드의 `limit_req`(`transaction/time` 에 IP 당 20 req/s, burst 40) 값을 환경에 맞게 조정한다.
  제한을 넘은 요청은 429 가 되며, 앱은 해당 청크를 2회 재시도한 뒤 건너뛰고 경고를 표시한다.

## 확인 방법

공통 가이드 6번의 `curl` 점검 후, 브라우저에서 `https://your-domain.com/pd/` 에 접속해 다음을 확인합니다.

1. 도메인 브레드크럼에 실제 도메인 목록이 표시되는가 (→ `/api/domain` 프록시 정상)
2. `直近5分` 프리셋으로 조회 시 진행률이 올라가고 히스토그램이 그려지는가
3. 화면 상단에 「認証に失敗しました (401)」 경고가 뜨지 않는가 (→ 토큰 주입 정상)

> 401 경고가 뜨면서 모크 데이터가 표시된다면 nginx 의 토큰 주입(`labo_secrets.conf`, `map $args $labo_api_args`)을 확인하세요.
