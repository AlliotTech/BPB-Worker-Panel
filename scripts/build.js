import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { globSync } from 'glob';
import { minify as jsMinify } from 'terser';
import { minify as htmlMinify } from 'html-minifier';
import JSZip from "jszip";
import obfs from 'javascript-obfuscator';

const env = process.env.NODE_ENV || 'production';
const devMode = env !== 'production';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

const ASSET_PATH = join(__dirname, '../src/assets');
const DIST_PATH = join(__dirname, '../dist/');

async function processHtmlPages() {
    const indexFiles = globSync('**/index.html', { cwd: ASSET_PATH });
    const result = {};

    // 随机字符串生成函数
    function randomString(len = 8) {
        return Math.random().toString(36).substring(2, 2 + len);
    }

    for (const relativeIndexPath of indexFiles) {
        const dir = pathDirname(relativeIndexPath);
        const base = (file) => join(ASSET_PATH, dir, file);

        const indexHtml = readFileSync(base('index.html'), 'utf8');
        const styleCode = readFileSync(base('style.css'), 'utf8');
        const scriptCode = readFileSync(base('script.js'), 'utf8');

        const finalScriptCode = await jsMinify(scriptCode);

        // 1. 随机化 title
        let html = indexHtml.replace(/<title>.*?<\/title>/i, `<title>${randomString(10)}</title>`);
        // 2. 替换项目名等特征性字符串
        html = html.replace(/BPB-Worker-Panel/gi, randomString(12));
        html = html.replace(/BPB Panel/gi, randomString(10));
        html = html.replace(/v__PANEL_VERSION__/gi, randomString(6));
        html = html.replace(/v\d+\.\d+\.\d+/gi, randomString(6));
        // 3. 移除注释
        html = html.replace(/<!--[\s\S]*?-->/g, '');
        // 4. 移除或随机化 meta
        html = html.replace(/<meta[^>]+(generator|description|keywords)[^>]*>/gi, '');
        // 5. 插入随机不可见元素
        html = html.replace(/<body.*?>/, match => `${match}<div style="display:none">${randomString(16)}</div>`);

        const finalHtml = html
            .replace(/__STYLE__/g, `<style>${styleCode}</style>`)
            .replace(/__SCRIPT__/g, finalScriptCode.code);

        const minifiedHtml = htmlMinify(finalHtml, {
            collapseWhitespace: true,
            removeAttributeQuotes: true,
            minifyCSS: true
        });

        result[dir] = JSON.stringify(minifiedHtml);
    }

    console.log('✅ Assets bundled successfuly!');
    return result;
}

async function buildWorker() {

    const htmls = await processHtmlPages();
    const faviconBuffer = readFileSync('./src/assets/favicon.ico');
    const faviconBase64 = faviconBuffer.toString('base64');

    const code = await build({
        entryPoints: [join(__dirname, '../src/worker.js')],
        bundle: true,
        format: 'esm',
        write: false,
        external: ['cloudflare:sockets'],
        platform: 'browser',
        target: 'es2020',
        define: {
            __PANEL_HTML_CONTENT__: htmls['panel'] ?? '""',
            __LOGIN_HTML_CONTENT__: htmls['login'] ?? '""',
            __ERROR_HTML_CONTENT__: htmls['error'] ?? '""',
            __SECRETS_HTML_CONTENT__: htmls['secrets'] ?? '""',
            __ICON__: JSON.stringify(faviconBase64)
        }
    });
    
    console.log('✅ Worker built successfuly!');

    let finalCode;
    if (devMode) {
        finalCode = code.outputFiles[0].text;
    } else {
        const minifiedCode = await jsMinify(code.outputFiles[0].text, {
            module: true,
            output: {
                comments: false
            }
        });
    
        console.log('✅ Worker minified successfuly!');
    
        const obfuscationResult = obfs.obfuscate(minifiedCode.code, {
            stringArrayThreshold: 1,
            stringArrayEncoding: [
                "rc4"
            ],
            numbersToExpressions: true,
            transformObjectKeys: true,
            renameGlobals: true,
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.2,
            target: "browser"
        });
    
        console.log('✅ Worker obfuscated successfuly!');
        finalCode = obfuscationResult.getObfuscatedCode();
    }

    const worker = `// @ts-nocheck\n${finalCode}`;
    mkdirSync(DIST_PATH, { recursive: true });
    writeFileSync('./dist/worker.js', worker, 'utf8');

    const zip = new JSZip();
    zip.file('_worker.js', worker);
    zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE'
    }).then(nodebuffer => writeFileSync('./dist/worker.zip', nodebuffer));

    console.log('✅ Done!');
}

buildWorker().catch(err => {
    console.error('❌ Build failed:', err);
    process.exit(1);
});
