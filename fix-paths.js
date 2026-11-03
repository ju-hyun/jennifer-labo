import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, normalize, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, 'dist');

// 각 앱 페이지의 절대/상위 경로를 상대 경로(./)로 보정
const apps = ['pta', 'pd'];
const pages = apps.flatMap(app => [
    { app, file: join(dist, app, 'index.html') },
    { app, file: join(dist, app, 'help.html') }
]);

const errors = [];

pages.forEach(({ app, file }) => {
    if (!fs.existsSync(file)) {
        // 파일이 없으면 보정할 수 없고, 배포물이 깨진 상태이므로 빌드를 실패시킨다.
        errors.push(`File not found: ${file}`);
        return;
    }
    let content = fs.readFileSync(file, 'utf8');
    // "../<app>/asserts/" -> "./asserts/", "../<app>/vite.svg" -> "./vite.svg"
    content = content.replace(new RegExp(`\\.\\./${app}/asserts/`, 'g'), './asserts/');
    content = content.replace(new RegExp(`\\.\\./${app}/vite\\.svg`, 'g'), './vite.svg');
    fs.writeFileSync(file, content);
    console.log(`Successfully fixed paths in: ${file}`);
});

// 배포 전 무결성 검사: 모든 HTML 이 참조하는 로컬 파일이 dist 안에 실제로 존재하는지 확인한다.
// (경로 보정이 어긋난 빌드가 조용히 배포되는 것을 막기 위함)
const htmlFiles = [join(dist, 'index.html'), ...pages.map(p => p.file)].filter(f => fs.existsSync(f));
const REF = /\b(?:src|href)="([^"]+)"/g;

htmlFiles.forEach((file) => {
    const html = fs.readFileSync(file, 'utf8');
    for (const [, ref] of html.matchAll(REF)) {
        // 외부 URL, 앵커, mailto 등은 대상 외
        if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
        const target = resolve(dirname(file), ref.split(/[?#]/)[0]);
        // dist 바깥을 가리키면 오류
        if (!normalize(target).startsWith(normalize(dist))) {
            errors.push(`${file}: reference escapes dist/: ${ref}`);
            continue;
        }
        if (!fs.existsSync(target)) errors.push(`${file}: missing referenced file: ${ref}`);
    }
});

if (errors.length > 0) {
    console.error('\nBuild verification FAILED:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
}
console.log(`Build verification passed (${htmlFiles.length} HTML files, all local references exist).`);
