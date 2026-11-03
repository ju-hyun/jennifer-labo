import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    // DEV_API_TOKEN은 .env(gitignore 대상)에서 로드. 클라이언트 번들에는 절대 포함되지 않음.
    const env = loadEnv(mode, process.cwd(), '');

    return {
        base: './', // 빌드 시 상대 경로 사용
        server: {
            host: '0.0.0.0',
            port: 5177, // 통합 앱 단일 포트
            strictPort: true,
            proxy: {
                '/api': {
                    target: 'https://demo.jennifersoft.co.jp/',
                    changeOrigin: true,
                    secure: false,
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
