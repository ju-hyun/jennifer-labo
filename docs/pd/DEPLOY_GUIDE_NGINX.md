# Nginx 배포 가이드 (Percentile Distribution)

Vite 로 빌드된 정적 웹 애플리케이션을 Nginx 환경에 배포하고 API 프록시를 설정하는 절차입니다.
본 프로젝트(jennifer-labo)는 PTA와 PD를 하나의 앱으로 빌드하므로, `dist/` 전체(랜딩 + `pta/` + `pd/` + `shared/`)를 **한 번에** 배포합니다. PD 접속 경로는 `/pd/` 입니다. PTA 관련 내용은 [PTA 배포 가이드](../pta/DEPLOY_GUIDE_NGINX.md)를 참고하세요.

## 1. 런타임 설정

`public/pd/config.js` 를 사용해 설정을 관리합니다. 빌드 후에도 `dist/pd/config.js` 를 직접 수정하면 반영됩니다.

```javascript
window.PD_CONFIG = {
  BASE_URL: '<your_jennifer_server>',
  API_DOMAIN: '',      // Nginx 프록시 사용 시 비워둠

  CHUNK_WAIT_MS: 0,    // 1분 청크 간 웨이트(ms). 데이터서버 부하가 우려되면 100~500 권장
  MAX_POINTS: 300000   // 누적 트랜잭션 건수의 안전 상한
};
```

> **주의**: JENNIFER OpenAPI 인증 토큰은 이 파일(브라우저에 그대로 노출되는 정적 파일)에 넣지 않습니다.
> 토큰은 아래 3번의 Nginx 설정에서 서버 측으로만 주입합니다.

---

## 2. 빌드

```bash
npm install
npm run build
```

`dist/` 폴더가 생성됩니다 (`fix-paths.js` 자동 실행). 구조는 다음과 같습니다.

```
dist/
├── index.html          # 랜딩 (JENNIFER Extension Labo)
├── pta/                # PTA (index.html, help.html, config.js, vite.svg, asserts/)
├── pd/
│   ├── index.html      # 대시보드
│   ├── help.html       # 분석 가이드
│   ├── config.js       # 런타임 설정 (배포 후 수정 가능)
│   ├── vite.svg
│   └── asserts/        # PD JS / CSS 번들
└── shared/asserts/     # PTA·PD 공용 청크 (chart.js 등)
```

---

## 3. Nginx 설정

`/etc/nginx/conf.d/jennifer_labo.conf` 등에 작성합니다.

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # [1] 정적 파일 서비스
    #     dist 전체를 root 아래에 두면 /pta/, /pd/ 가 함께 서비스됩니다.
    location / {
        root /var/www/jennifer-labo;   # dist 내용을 복사한 경로
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # [2] API 프록시 (CORS 해결 + 토큰 서버 측 주입)
    #     클라이언트(JS)는 token 파라미터를 전혀 보내지 않으며, 여기서 서버 측 토큰을 붙입니다.
    #     PTA·PD 가 이 location 하나를 공유합니다.
    location /api/ {
        set $args "${args}&token=<your_jennifer_api_token>";

        proxy_pass https://<your_jennifer_server_ip>/api/;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 백엔드가 자가 서명 인증서를 사용하는 경우
        proxy_ssl_verify off;

        # X-View 단건 조회는 집계 API 보다 응답이 느릴 수 있어 타임아웃을 넉넉히 잡습니다.
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;

        # 청크를 순차로 다수 호출하므로 업스트림 커넥션을 재사용합니다.
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

> 토큰 값은 가급적 이 파일에 직접 쓰지 말고, 별도 include 파일(예: `/etc/nginx/conf.d/labo_secrets.conf`,
> 권한 `600`, root 소유)로 분리해 `include` 로 불러오는 것을 권장합니다. 이 include 파일은 버전관리에 포함하지 않습니다.
> 토큰 교체 시에는 nginx 설정만 갱신 후 `nginx -t && systemctl reload nginx` 를 실행하면 됩니다.

### 서버 디렉터리 구성

`dist/` 의 내용을 그대로 root 에 복사하면 됩니다. `/api/` 프록시는 PTA·PD 가 공유합니다.

```
/var/www/jennifer-labo/
├── index.html      # 두 도구를 안내하는 랜딩
├── pta/            # dist/pta
├── pd/             # dist/pd
└── shared/         # dist/shared (두 앱 공용 청크 — 반드시 함께 배포)
```

### 로컬 개발 환경 (`npm run dev`)

로컬에서는 Nginx 대신 `vite.config.js` 의 dev 서버 프록시가 동일한 역할을 합니다.
`.env.example` 을 복사해 `.env` 를 만들고 `DEV_API_TOKEN` 에 토큰을 채워 넣으세요 (`.env` 는 git 에 커밋되지 않습니다).

개발 서버는 PTA·PD 공용 포트 **5177** 하나로 동작합니다 (`http://localhost:5177/pd/`).

---

## 4. 서버 적용 및 확인

```bash
# 파일 복사 (dist 전체: PTA·PD 함께)
scp -r ./dist/* user@your-server:/var/www/jennifer-labo/

# 설정 반영
sudo nginx -t
sudo systemctl reload nginx
```

브라우저에서 `http://your-domain.com/pd/` 로 접속해 다음을 확인합니다.

1. 도메인 브레드크럼에 실제 도메인 목록이 표시되는가 (→ `/api/domain` 프록시 정상)
2. `直近5分` 프리셋으로 조회 시 진행률이 올라가고 히스토그램이 그려지는가
3. 화면 상단에 「認証に失敗しました (401)」 경고가 뜨지 않는가 (→ 토큰 주입 정상)

> 401 경고가 뜨면서 모크 데이터가 표시된다면 nginx 의 `set $args` 토큰 주입을 확인하세요.

---

## 5. 운영상의 주의

X-View 트랜잭션 조회는 **JENNIFER 데이터서버에 부하를 줍니다** (매뉴얼 부록 5.9.4.5 명시).
본 시스템은 동시 실행 수 1 의 순차 호출로 이를 완화하고 있으나, 다수 사용자가 동시에 장기간을 조회하면
데이터서버에 영향이 있을 수 있습니다. 필요 시 다음을 검토하세요.

- `config.js` 의 `CHUNK_WAIT_MS` 를 100~500 으로 설정해 호출 간격을 늘린다
- `MAX_POINTS` 를 낮춰 1회 조회량을 제한한다
- nginx 의 `limit_req` 로 `/api/transaction/` 경로에 레이트 리밋을 건다

---

## HTTPS 적용

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```
