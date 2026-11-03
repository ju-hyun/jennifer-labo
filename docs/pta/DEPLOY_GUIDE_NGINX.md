# Nginx 배포 가이드 (Performance Trend Analysis)

이 문서는 Vite로 빌드된 정적 웹 애플리케이션을 Nginx 환경에 배포하고, API 프록시를 설정하는 절차를 안내합니다.

## 1. 사전 준비 및 환경 설정

이제 `.env` 파일 대신 `public/config.js`를 사용하여 설정을 관리합니다. 이 방식은 빌드 후에도 서버에서 직접 설정값을 수정할 수 있게 해줍니다.

### 설정 수정
`public/config.js` 파일을 열어 필요한 값을 입력합니다.

```javascript
window.PTA_CONFIG = {
  BASE_URL: '<your_jennifer_server_ip>',
  API_DOMAIN: '' // Nginx 프록시 사용 시 비워둠
};
```

> **주의**: JENNIFER OpenAPI 인증 토큰은 이 파일(브라우저에 그대로 노출되는 정적 파일)에 넣지 않습니다.
> 토큰은 아래 3번의 Nginx 설정에서 서버 측으로만 주입합니다.

---

## 2. 프로젝트 빌드

로컬 환경 또는 CI/CD 환경에서 다음 명령어를 실행하여 배포용 파일을 생성합니다.

```bash
# 의존성 설치 (필요시)
npm install

# 프로젝트 빌드
npm run build
```

빌드가 완료되면 프로젝트 루트에 `dist` 폴더가 생성됩니다. 이 폴더 내의 모든 파일을 서버로 복사합니다.

---

## 3. Nginx 설정

서버에 Nginx가 설치되어 있다면, 새로운 설정 파일(예: `/etc/nginx/conf.d/perf_analysis.conf`)을 생성하고 아래 내용을 작성합니다.

```nginx
server {
    listen 80;
    server_name your-domain.com; # 도메인 또는 서버 IP를 입력하세요.

    # [1] 정적 파일 서비스 설정
    location / {
        root /var/www/performance-trend; # dist 파일들이 위치한 실제 경로
        index analysis_perf_trend.html;
        try_files $uri $uri/ /analysis_perf_trend.html;
    }

    # [2] API 프록시 설정 (CORS 문제 해결 + 토큰 서버 측 주입)
    # 앱에서 호출하는 /api/... 요청을 실제 API 서버로 전달합니다.
    # 클라이언트(JS)는 token 파라미터를 전혀 보내지 않으며, 여기서 서버 측 토큰을 붙여줍니다.
    location /api/ {
        # 클라이언트가 보낸 쿼리 뒤에 서버 측 토큰을 추가로 붙여 업스트림에 전달
        set $args "${args}&token=<your_jennifer_api_token>";

        proxy_pass https://<your_jennifer_server_ip>/api/; # 실제 JENNIFER OpenAPI 서버 주소
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 백엔드 서버가 자가 서명 인증서를 사용하는 경우 필요할 수 있습니다.
        proxy_ssl_verify off; 
        
        # 타임아웃 설정 (필요시 조정)
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # 오류 페이지 설정 (선택 사항)
    error_page 404 /analysis_perf_trend.html;
}
```

> 토큰 값은 가급적 이 파일에 직접 쓰지 말고, 별도 include 파일(예: `/etc/nginx/conf.d/pta_secrets.conf`, 권한 `600`, root 소유)로
> 분리해 `include /etc/nginx/conf.d/pta_secrets.conf;`로 불러오는 것을 권장합니다. 이 include 파일은 버전관리에 포함하지 않습니다.
> 토큰을 교체(rotate)할 때는 이 nginx 설정만 갱신 후 `nginx -t && systemctl reload nginx`를 실행하면 됩니다.

### 로컬 개발 환경 (`npm run dev`)

로컬에서는 Nginx 대신 `vite.config.js`의 dev 서버 프록시가 동일한 역할을 합니다. 프로젝트 루트에 `.env.example`을 복사해 `.env`를 만들고
`DEV_API_TOKEN`에 로컬 테스트용 토큰을 채워 넣으세요 (`.env`는 git에 커밋되지 않습니다).

---

## 4. 서버 적용 및 확인

### 파일 복사
생성된 `dist` 폴더의 모든 내용을 서버의 `/var/www/performance-trend` 경로로 복사합니다.
```bash
# 예시: scp 사용 시
scp -r ./dist/* user@your-server:/var/www/performance-trend/
```

### 설정 반영
```bash
# Nginx 설정 문법 확인
sudo nginx -t

# Nginx 설정 재로드
sudo systemctl reload nginx
```

### 브라우저 확인
설정한 `server_name` 주소로 접속하여 페이지가 정상적으로 로드되는지, 차트 데이터가 API로부터 잘 넘어오는지 확인합니다.

---

## HTTPS 적용
보안을 위해 HTTPS를 적용하려면 `certbot`을 사용하는 것이 가장 간단합니다.
```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```
