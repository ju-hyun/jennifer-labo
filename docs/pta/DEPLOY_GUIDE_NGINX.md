# Nginx 배포 가이드 (Performance Trend Analysis)

> **배포 절차와 Nginx 설정은 공통 문서로 통합되었습니다 → [Nginx 배포 가이드 (공통)](../DEPLOY_GUIDE_NGINX.md)**
>
> PTA 와 PD 는 하나의 앱(`dist/`)으로 빌드·배포되고 `/api/` 프록시를 공유하므로, 보안 설정(HTTPS, Basic 인증,
> API 화이트리스트, 토큰 분리, 백엔드 인증서 검증)이 어긋나지 않도록 설정을 한 곳에서만 관리합니다.
> 이 문서에는 PTA 고유 내용만 남깁니다.

PTA 접속 경로는 `/pta/` 입니다. PD 관련 내용은 [PD 배포 가이드](../pd/DEPLOY_GUIDE_NGINX.md)를 참고하세요.

## 런타임 설정 (`config.js`)

`public/pta/config.js` 로 관리하며, 빌드 후에도 서버의 `dist/pta/config.js` 를 직접 수정하면 반영됩니다.

```javascript
window.PTA_CONFIG = {
  API_DOMAIN: '' // Nginx 프록시 사용 시 비워둠
};
```

> **주의**: JENNIFER OpenAPI 인증 토큰은 이 파일(브라우저에 그대로 노출되는 정적 파일)에 넣지 않습니다.
> 토큰은 공통 가이드의 Nginx 설정(`labo_secrets.conf`)에서 서버 측으로만 주입합니다.

## PTA 가 사용하는 API (프록시 화이트리스트 대상)

- `/api/domain`, `/api/instance`, `/api/business`
- `/api/dbmetrics/domain`, `/api/dbmetrics/instance`, `/api/dbmetrics/business`

PTA 는 첫 화면에서 월별·지표별로 **약 100건의 API 를 동시에** 요청합니다. 공통 가이드의 레이트 리밋은
`transaction/time`(PD 전용)에만 적용되므로 PTA 에는 영향이 없습니다. 프록시 앞단에 별도의 전역 레이트 리밋을 추가한다면
이 동시 요청 수를 고려하세요.

## 확인 방법

공통 가이드 6번의 `curl` 점검 후, 브라우저에서 `https://your-domain.com/pta/` 에 접속해
도메인 목록이 표시되고 차트 데이터가 API 로부터 정상적으로 넘어오는지 확인합니다.
