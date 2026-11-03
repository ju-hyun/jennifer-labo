import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    // DEV_API_TOKEN은 .env(gitignore 대상)에서 로드. 클라이언트 번들에는 절대 포함되지 않음.
    const env = loadEnv(mode, process.cwd(), '');

    // 개발 서버의 /api 프록시는 DEV_API_TOKEN 을 자동으로 붙이므로, 서버에 접근할 수 있는 누구나
    // 토큰 권한으로 JENNIFER API 를 호출할 수 있다. 기본은 localhost 로만 연다.
    // VM/컨테이너 등에서 외부 접속이 필요하면 .env 에 DEV_HOST=0.0.0.0 을 명시한다.
    const devHost = env.DEV_HOST || 'localhost';
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(devHost);
    if (!isLoopback && env.DEV_API_TOKEN) {
        console.warn(
            `[jennifer-labo] 경고: 개발 서버가 ${devHost} 에 열려 있고 /api 프록시가 DEV_API_TOKEN 을 주입합니다. ` +
            '신뢰할 수 있는 네트워크에서만 사용하세요.'
        );
    }
    // 업스트림 TLS 인증서는 기본으로 검증한다. 자가 서명 인증서 서버를 쓸 때만 DEV_INSECURE_TLS=1 로 끈다.
    const verifyUpstreamTls = env.DEV_INSECURE_TLS !== '1';
    // 開発プロキシの接続先 (JENNIFER サーバ)。未指定ならデモサーバ。
    const apiTarget = env.DEV_API_TARGET || 'https://demo.jennifersoft.co.jp/';

    return {
        base: './', // 빌드 시 상대 경로 사용
        server: {
            host: devHost,
            port: 5177, // 통합 앱 단일 포트
            strictPort: true,
            proxy: {
                '/api': {
                    target: apiTarget,
                    changeOrigin: true,
                    secure: verifyUpstreamTls,
                    configure: (proxy) => {
                        // 운영 nginx의 토큰 주입(set $args)과 동일한 역할: 클라이언트는 토큰을 모르고,
                        // 개발 서버 프록시가 업스트림으로 전달하기 직전에 토큰을 붙여준다.
                        proxy.on('proxyReq', (proxyReq) => {
                            if (!env.DEV_API_TOKEN) return;
                            const sep = proxyReq.path.includes('?') ? '&' : '?';
                            proxyReq.path += `${sep}token=${env.DEV_API_TOKEN}`;
                        });
                        proxy.on('proxyRes', (proxyRes) => {
                            proxyRes.headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
                        });
                        // 업스트림 인증서 검증에 실패했을 때, 원인과 해결 방법을 한 번만 안내한다.
                        // (PTA 는 한 화면에서 약 100건을 동시에 요청하므로 같은 오류가 대량으로 나온다)
                        let certHintShown = false;
                        proxy.on('error', (err) => {
                            const isCertError = /SELF.SIGNED|UNABLE_TO_(GET_ISSUER|VERIFY)|CERT_|certificate/i
                                .test(`${err.code ?? ''} ${err.message ?? ''}`);
                            if (!isCertError || certHintShown) return;
                            certHintShown = true;
                            console.error(
                                '\n[jennifer-labo] 업스트림(' + apiTarget + ')의 TLS 인증서를 검증하지 못했습니다.\n' +
                                '  자가 서명 인증서이거나, 사내 보안 장비(TLS 검사)의 CA 가 Node 에 등록되어 있지 않은 경우입니다.\n' +
                                '  해결 방법 (둘 중 하나):\n' +
                                '   1) [간단] .env 에 DEV_INSECURE_TLS=1 을 추가하고 개발 서버를 다시 시작\n' +
                                '      (인증서 검증을 끄므로 신뢰할 수 있는 네트워크의 개발 PC 에서만 사용)\n' +
                                '   2) [권장] 해당 CA/서버 인증서를 PEM 으로 저장해 NODE_EXTRA_CA_CERTS=/경로/ca.pem npm run dev\n' +
                                '      (검증을 유지한 채 그 인증서만 신뢰)\n'
                            );
                        });
                    }
                }
            },
            headers: {
                'Content-Security-Policy': "frame-ancestors 'self' * file://*",
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'Cross-Origin-Embedder-Policy': 'credentialless',
                'Cross-Origin-Opener-Policy': 'same-origin'
            }
        },
        build: {
            assetsDir: 'asserts',
            rollupOptions: {
                input: {
                    main: 'index.html',
                    pta: 'pta/index.html',
                    'pta-help': 'pta/help.html',
                    pd: 'pd/index.html',
                    'pd-help': 'pd/help.html'
                },
                output: {
                    // 앱별로 asserts 폴더를 분리: pta/asserts, pd/asserts
                    entryFileNames: (chunk) => `${chunk.name.startsWith('pd') ? 'pd' : 'pta'}/asserts/[name]-[hash].js`,
                    chunkFileNames: 'shared/asserts/[name]-[hash].js',
                    assetFileNames: (asset) => {
                        const n = asset.name || '';
                        const app = n.startsWith('pd') ? 'pd' : n.startsWith('pta') ? 'pta' : 'shared';
                        return `${app}/asserts/[name]-[hash].[ext]`;
                    }
                }
            }
        }
    };
});
