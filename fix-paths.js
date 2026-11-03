import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 각 앱 페이지의 절대/상위 경로를 상대 경로(./)로 보정
const apps = ['pta', 'pd'];
const files = apps.flatMap(app => [
    { app, file: join(__dirname, `dist/${app}/index.html`) },
    { app, file: join(__dirname, `dist/${app}/help.html`) }
]);

files.forEach(({ app, file }) => {
    if (!fs.existsSync(file)) {
        console.warn(`File not found: ${file}`);
        return;
    }
    let content = fs.readFileSync(file, 'utf8');
    // "../<app>/asserts/" -> "./asserts/", "../<app>/vite.svg" -> "./vite.svg"
    content = content.replace(new RegExp(`\\.\\./${app}/asserts/`, 'g'), './asserts/');
    content = content.replace(new RegExp(`\\.\\./${app}/vite\\.svg`, 'g'), './vite.svg');
    fs.writeFileSync(file, content);
    console.log(`Successfully fixed paths in: ${file}`);
});
