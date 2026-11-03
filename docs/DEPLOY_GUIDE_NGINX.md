# Nginx 배포 가이드 (JENNIFER Extension Labo 공통)

PTA·PD를 하나의 Vite 앱으로 빌드한 `dist/` 를 Nginx 에 배포하고, JENNIFER OpenAPI 프록시를 **안전하게** 구성하는 절차입니다.
이 문서가 배포 절차의 **기준 문서(단일 출처)** 입니다. 도구별 문서는 이 문서를 가리킵니다.

- [PTA 배포 가이드](./pta/DEPLOY_GUIDE_NGINX.md) — PTA 고유 설정
- [PD 배포 가이드](./pd/DEPLOY_GUIDE_NGINX.md) — PD 고유 설정, 데이터서버 부하 주의

---

## 1. 왜 보안 설정이 필요한가

이 앱의 API 프록시는 **서버가 보관한 JENNIFER OpenAPI 토큰을 요청에 자동으로 붙여** 업스트림에 전달합니다.
프록시 앞에 아무 제한이 없으면, 이 서버에 접근할 수 있는 누구나 토큰 권한으로 JENNIFER 데이터를 조회할 수 있습니다
(토큰이 사실상 공개된 것과 같습니다). 아래 설정은 이 위험을 다음과 같이 줄입니다.

| 위험 | 대책 | 설정 위치 |
|---|---|---|
| 누구나 프록시를 통해 데이터 조회 | 서버 전체에 **Basic 인증** (필요 시 IP 제한 병행) | `auth_basic` |
| 인증 정보·데이터가 평문으로 오감 | **HTTPS 강제** (80 → 443 리다이렉트) | `listen 443 ssl` |
| 앱이 쓰지 않는 API 까지 토큰으로 호출됨 | **허용 경로 화이트리스트** + **GET 전용** | `location ~ ^/api/(...)$` |
| 사용자의 Basic 인증 정보가 JENNIFER 서버로 전달됨 | `Authorization`·`Cookie` 헤더 제거 | `proxy_set_header ... ""` |
| 토큰이 설정 파일·저장소에 남음 | 토큰을 **별도 파일(권한 600)** 로 분리 | `labo_secrets.conf` |
| 백엔드 MITM (인증서 검증 끔) | 백엔드 인증서 **검증 + 고정(pinning)** | `proxy_ssl_verify on` |
| 데이터서버 과부하 (X-View 단건 조회) | `transaction/time` 에만 **레이트 리밋** | `limit_req` |

> **Basic 인증을 서버 전체에 거는 이유**: `/api/` 에만 걸면 화면은 열리고 API 호출만 401 이 되는데,
> 앱은 이를 "서버 API 토큰 오류(401)" 로 안내하므로 원인 파악이 어려워집니다. 서버 전체에 걸면
> 페이지 접속 시점에 인증 창이 뜨고, 이후 같은 출처의 API 요청에는 브라우저가 자격 증명을 자동으로 붙입니다.

---

## 2. 런타임 설정 (`config.js`)

앱별 설정은 `dist/pta/config.js`, `dist/pd/config.js` 에서 관리하며 배포 후에도 직접 수정할 수 있습니다.
**토큰은 이 파일에 넣지 않습니다** (브라우저에 그대로 노출되는 정적 파일입니다).
Nginx 프록시를 사용할 때는 `API_DOMAIN` 을 비워 둡니다. 항목의 의미는 각 도구의 문서를 참고하세요.

---

## 3. 빌드

```bash
npm ci
npm run build
```

`dist/` 가 생성됩니다 (`fix-paths.js` 자동 실행).

```
dist/
├── index.html          # 랜딩
├── pta/                # index.html, help.html, config.js, vite.svg, asserts/
├── pd/                 # index.html, help.html, config.js, vite.svg, asserts/
└── shared/asserts/     # PTA·PD 공용 청크 (chart.js 등) — 반드시 함께 배포
```

---

## 4. 서버 준비

### 4-1. 앱이 사용하는 API (화이트리스트 근거)

| 경로 | 사용처 |
|---|---|
| `/api/domain`, `/api/instance`, `/api/business` | PTA, PD (대상 선택) |
| `/api/dbmetrics/domain`, `/api/dbmetrics/instance`, `/api/dbmetrics/business` | PTA (집계 시계열) |
| `/api/transaction/time` | PD (X-View 단건 조회, **데이터서버 부하**) |

앱이 새 API 를 사용하도록 바뀌면 5번 설정의 `location ~ ^/api/(...)$` 정규식에 경로를 추가해야 합니다
(추가하지 않으면 403 이 됩니다).

### 4-2. 접속 계정 (Basic 인증)

```bash
sudo apt-get install -y apache2-utils          # htpasswd 명령
sudo htpasswd -c /etc/nginx/labo.htpasswd alice   # 최초 1회 (-c: 파일 생성)
sudo htpasswd    /etc/nginx/labo.htpasswd bob     # 계정 추가
sudo chmod 640 /etc/nginx/labo.htpasswd
sudo chown root:www-data /etc/nginx/labo.htpasswd  # 워커 프로세스 그룹에 맞게 조정
```

### 4-3. API 토큰 파일

토큰은 메인 설정과 분리해 별도 파일에 둡니다. 이 파일은 **버전 관리에 포함하지 않습니다.**

```bash
sudo install -m 600 -o root -g root /dev/null /etc/nginx/labo_secrets.conf
sudo vi /etc/nginx/labo_secrets.conf
```

`/etc/nginx/labo_secrets.conf`:

```nginx
# http 컨텍스트에서 include 됩니다. 토큰 값만 이 파일에 둡니다.
map $server_name $labo_api_token {
    default "<your_jennifer_api_token>";
}
```

토큰 교체: 이 파일만 수정한 뒤 `sudo nginx -t && sudo systemctl reload nginx`.

### 4-4. 백엔드(JENNIFER 서버) 인증서 고정

`proxy_ssl_verify off` 대신, 백엔드 인증서를 **신뢰 목록에 직접 등록**해 검증합니다.
자가 서명 인증서는 그 인증서 자체를, 사내 CA 서명이라면 CA 인증서를 저장합니다.

```bash
sudo mkdir -p /etc/nginx/ssl
echo | openssl s_client -connect <jennifer_server_host>:443 -servername <jennifer_server_host> 2>/dev/null \
  | openssl x509 | sudo tee /etc/nginx/ssl/jennifer-ca.pem >/dev/null
openssl x509 -in /etc/nginx/ssl/jennifer-ca.pem -noout -subject -issuer -dates -ext subjectAltName
```

- 접속할 호스트 이름이 인증서의 CN/SAN 에 포함되어야 합니다 (5번 설정의 `proxy_ssl_name`).
- 인증서가 갱신되면 이 파일도 갱신해야 합니다. 갱신을 놓치면 502 가 발생합니다 (문제 해결 참고).

### 4-5. 프런트 서버 인증서 (HTTPS)

인증서 발급 방식(사내 CA, Let's Encrypt 등)은 환경마다 다릅니다. 5번 설정은 아래 경로를 사용합니다.

- `/etc/letsencrypt/live/your-domain.com/fullchain.pem`
- `/etc/letsencrypt/live/your-domain.com/privkey.pem`

Let's Encrypt(certbot)를 쓰는 경우, 인증서가 아직 없을 때는 `nginx -t` 가 실패하므로
**먼저 5번 설정의 `listen 443` 서버 블록을 주석 처리하고 80 포트 블록만 적용**한 뒤 발급하세요.

```bash
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d your-domain.com \
  --deploy-hook "systemctl reload nginx"
```

발급 후 주석을 풀어 적용합니다. 갱신은 certbot 의 자동 갱신(타이머)에 맡깁니다.

---

## 5. Nginx 설정

`/etc/nginx/conf.d/jennifer_labo.conf` 에 작성합니다 (`conf.d` 는 `http` 컨텍스트에서 include 됩니다).

```nginx
# 토큰은 별도 파일에서 읽습니다 (4-3).
include /etc/nginx/labo_secrets.conf;

# 클라이언트가 보낸 쿼리 뒤에 서버 측 토큰을 덧붙입니다.
# 쿼리가 비어 있어도 '&token=...' 으로 시작하지 않도록 map 으로 분기합니다.
map $args $labo_api_args {
    ""      "token=$labo_api_token";
    default "$args&token=$labo_api_token";
}

# X-View 단건 조회(transaction/time)에만 레이트 리밋을 적용합니다.
# 키가 빈 문자열이면 제한되지 않으므로 다른 API(PTA 는 첫 화면에서 약 100건 동시 요청)는 영향이 없습니다.
map $uri $labo_xview_key {
    default                  "";
    "/api/transaction/time"  $binary_remote_addr;
}
limit_req_zone $labo_xview_key zone=labo_xview:10m rate=20r/s;
limit_req_status 429;

upstream jennifer_backend {
    server <jennifer_server_host>:443;
    keepalive 16;   # 청크를 순차로 다수 호출하므로 업스트림 커넥션을 재사용합니다.
}

# HTTP → HTTPS 강제 리다이렉트 (Basic 인증 정보가 평문으로 오가지 않도록)
server {
    listen 80;
    server_name your-domain.com;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }   # certbot 사용 시
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # [접근 제어] 서버 전체에 Basic 인증
    auth_basic           "JENNIFER Extension Labo";
    auth_basic_user_file /etc/nginx/labo.htpasswd;

    # 사내망 IP 로도 제한하려면 아래를 사용합니다 (인증 AND IP 모두 만족해야 접근).
    # satisfy all;
    # allow 10.0.0.0/8;
    # deny  all;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy        "same-origin" always;
    # HTTPS 운영이 확정된 뒤에 활성화하세요.
    # add_header Strict-Transport-Security "max-age=31536000" always;

    # [1] 정적 파일 (dist 내용을 복사한 경로)
    root  /var/www/jennifer-labo;
    index index.html;

    location / {
        # 없는 파일에 index.html 을 200 으로 돌려주지 않습니다 (자산 누락을 404 로 드러냄).
        try_files $uri $uri/ =404;
    }

    # 배포 후 수정하는 설정 파일은 캐시하지 않습니다.
    location ~ ^/(pta|pd)/config\.js$ { expires -1; }

    # 해시가 붙은 번들은 장기 캐시합니다.
    location ~ ^/(pta|pd|shared)/asserts/ { expires 1y; }

    # [2] API 프록시: 허용된 경로만, GET 만, 토큰은 서버 측에서 주입
    location ~ ^/api/(domain|instance|business|dbmetrics/(domain|instance|business)|transaction/time)$ {
        limit_except GET { deny all; }              # GET(HEAD 포함) 외에는 403
        limit_req zone=labo_xview burst=40 nodelay; # transaction/time 에만 실질 적용

        set $args $labo_api_args;
        # 정규식 location 에서는 proxy_pass 에 URI 를 붙일 수 없고, URI 없이 쓰면 원본 쿼리가
        # 그대로 전달되어 위에서 붙인 토큰이 사라집니다. 그래서 $uri/$args 를 명시합니다.
        proxy_pass https://jennifer_backend$uri$is_args$args;

        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Basic 인증 정보·쿠키를 JENNIFER 서버로 전달하지 않습니다.
        proxy_set_header Authorization "";
        proxy_set_header Cookie        "";

        # 백엔드 인증서를 검증합니다 (4-4). 접속 호스트 이름이 인증서와 일치해야 합니다.
        proxy_ssl_server_name on;
        proxy_ssl_name        <jennifer_server_host>;
        proxy_ssl_verify      on;
        proxy_ssl_verify_depth 2;
        proxy_ssl_trusted_certificate /etc/nginx/ssl/jennifer-ca.pem;

        # X-View 단건 조회는 집계 API 보다 응답이 느릴 수 있습니다.
        proxy_connect_timeout 60s;
        proxy_send_timeout    120s;
        proxy_read_timeout    120s;
    }

    # 위 화이트리스트에 없는 /api/ 경로는 모두 거부
    location /api/ { return 403; }
}
```

> 설정 값(`<...>`, `your-domain.com`)과 경로는 환경에 맞게 바꾸세요.
> 접근 로그(`$request`)에는 클라이언트가 보낸 원본 요청만 기록되며 토큰은 남지 않습니다.
> `log_format` 에 `$args`·`$upstream_*` 를 넣어 변경된 쿼리를 기록하는 설정은 피하세요.

### 서버 디렉터리 구성

```
/var/www/jennifer-labo/
├── index.html      # 랜딩
├── pta/            # dist/pta
├── pd/             # dist/pd
└── shared/         # dist/shared (두 앱 공용 청크 — 반드시 함께 배포)
```

---

## 6. 적용 및 확인

```bash
# 파일 복사 (dist 전체: PTA·PD 함께)
scp -r ./dist/* user@your-server:/var/www/jennifer-labo/

# 설정 검증 및 반영
sudo nginx -t
sudo systemctl reload nginx
```

보안 설정이 의도대로 동작하는지 `curl` 로 확인합니다 (`-k` 는 자가 서명 인증서 환경에서만 사용).

| 확인 | 명령 | 기대 결과 |
|---|---|---|
| HTTP → HTTPS | `curl -sI http://your-domain.com/` | `301` |
| 인증 없이 접근 | `curl -s -o /dev/null -w "%{http_code}\n" https://your-domain.com/pd/` | `401` |
| 인증 후 화면 | `curl -s -u USER:PASS -o /dev/null -w "%{http_code}\n" https://your-domain.com/pd/` | `200` |
| 허용 API | `curl -s -u USER:PASS -o /dev/null -w "%{http_code}\n" https://your-domain.com/api/domain` | `200` |
| 비허용 경로 | `curl -s -u USER:PASS -o /dev/null -w "%{http_code}\n" https://your-domain.com/api/other` | `403` |
| GET 이외 메서드 | `curl -s -u USER:PASS -X POST -o /dev/null -w "%{http_code}\n" https://your-domain.com/api/domain` | `403` |
| 없는 자산 | `curl -s -u USER:PASS -o /dev/null -w "%{http_code}\n" https://your-domain.com/pd/asserts/none.js` | `404` |

브라우저에서는 `https://your-domain.com/pd/`, `/pta/` 에 접속해 다음을 확인합니다.

1. 인증 창이 뜨고 로그인 후 도메인 브레드크럼에 실제 도메인 목록이 표시되는가 (→ `/api/domain` 프록시 정상)
2. 화면 상단에 「認証に失敗しました (401)」 경고가 뜨지 않는가 (→ 토큰 주입 정상)
3. PD 에서 `直近5分` 조회 시 진행률이 올라가고 히스토그램이 그려지는가

---

## 7. 운영상의 주의

- **데이터서버 부하 (PD)**: X-View 트랜잭션 조회는 JENNIFER 데이터서버에 부하를 줍니다 (매뉴얼 부록 5.9.4.5).
  앱은 동시 실행 수 1 의 순차 호출로 완화하며, 5번 설정은 `transaction/time` 을 IP 당 20 req/s(burst 40)로 제한합니다.
  제한을 넘은 요청은 429 가 되고, 앱은 해당 청크를 재시도한 뒤 건너뜁니다(경고 표시). 환경에 맞게 `rate`·`burst` 를 조정하세요.
  추가로 `config.js` 의 `CHUNK_WAIT_MS`(100~500), `MAX_POINTS` 로 1회 조회량을 줄일 수 있습니다.
- **계정 관리**: 퇴사·이동 시 `htpasswd -D /etc/nginx/labo.htpasswd USER` 로 계정을 삭제합니다.
  토큰은 모든 사용자가 공유하는 권한이므로, 조회 전용 권한의 토큰을 사용하세요.
- **토큰·인증서 갱신**: 토큰은 `labo_secrets.conf`, 백엔드 인증서는 `jennifer-ca.pem` 을 갱신하고 reload 합니다.
- **로컬 개발 (`npm run dev`)**: Nginx 대신 `vite.config.js` 의 dev 서버 프록시가 같은 역할을 합니다.
  `.env.example` 을 복사해 `.env` 를 만들고 `DEV_API_TOKEN` 을 채우세요 (`.env` 는 커밋되지 않습니다).
  개발 서버 주소는 `http://localhost:5177/` 입니다.

---

## 8. 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| 접속 시 계속 인증 창이 뜸 | 계정/비밀번호 불일치, `labo.htpasswd` 읽기 권한 없음 | 에러 로그 확인 (`/var/log/nginx/error.log`), 파일 권한·그룹 확인 |
| API 가 `502` | 백엔드 인증서 검증 실패 / 백엔드 접속 불가 | 에러 로그의 `upstream SSL certificate verify error` 확인 → `jennifer-ca.pem` 갱신, `proxy_ssl_name` 이 인증서 CN/SAN 과 일치하는지 확인 |
| 화면에 「認証に失敗しました (401)」 | 토큰이 틀렸거나 만료 (백엔드가 401 반환) | `labo_secrets.conf` 의 토큰 확인 후 reload |
| API 가 `403` | 화이트리스트에 없는 경로 / GET 이외 메서드 | 4-1 의 경로 표와 5번의 정규식 비교 |
| PD 에서 일부 청크 건너뜀 경고 | `transaction/time` 레이트 리밋(429) 또는 백엔드 지연 | `rate`/`burst` 조정, `CHUNK_WAIT_MS` 조정 |
| 설정 변경 후에도 화면이 그대로 | `config.js` 외 파일은 브라우저 캐시 | 강력 새로고침. 새 빌드는 해시가 바뀌어 자동 반영됨 |
| 발급 전 `nginx -t` 실패 | 아직 없는 인증서 경로 참조 | 4-5 의 순서(80 포트 블록만 먼저 적용) |

---

## 참고

- Nginx `auth_basic`: <https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html>
- Nginx `proxy_pass` / `proxy_ssl_*`: <https://nginx.org/en/docs/http/ngx_http_proxy_module.html>
- Nginx `limit_req`: <https://nginx.org/en/docs/http/ngx_http_limit_req_module.html>
- Nginx `limit_except`: <https://nginx.org/en/docs/http/ngx_http_core_module.html#limit_except>
- Nginx `map`: <https://nginx.org/en/docs/http/ngx_http_map_module.html>
- JENNIFER5 매뉴얼 부록 5.9 (OpenAPI)
