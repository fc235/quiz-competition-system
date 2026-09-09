const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8123);
const HOST = '0.0.0.0';
const MAIN_FILE = '竞赛抽题系统.html';
const HOST_TOKEN = crypto.randomBytes(24).toString('hex');
const revisions = new Map();
let activeSession = null;
let lastResetSession = null;
const PUBLIC_FILES = new Set([MAIN_FILE, 'answer.html', path.join('js', 'xlsx.full.min.js')]);

let state = emptyState();

function emptyState() {
    return {
        isLive: false,
        round: 'r1',
        roundName: '第一轮：必答题',
        usedCount: 0,
        hasQuestion: false,
        hasShowAns: true,
        question: null,
        teams: [],
        updatedAt: null
    };
}

function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('请求内容过大'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function mimeType(file) {
    const ext = path.extname(file).toLowerCase();
    return {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml; charset=utf-8'
    }[ext] || 'application/octet-stream';
}

function safePath(urlPath) {
    const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
    const relativePath = cleanPath === '/' ? MAIN_FILE : cleanPath.replace(/^\/+/, '');
    const target = path.resolve(ROOT, relativePath);
    const rel = path.relative(ROOT, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!PUBLIC_FILES.has(rel)) return null;
    return target;
}

function localIps() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const items of Object.values(nets)) {
        for (const item of items || []) {
            if (item.family === 'IPv4' && !item.internal) ips.push(item.address);
        }
    }
    return ips;
}

async function handleApi(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/host') {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const hostname = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
        if (!local || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
            sendJson(res, 403, {ok: false, error: '请使用服务启动时显示的主控完整链接'});
        } else {
            sendJson(res, 200, {token: HOST_TOKEN});
        }
        return true;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, state);
        return true;
    }

    if (req.method === 'GET' && pathname === '/api/info') {
        sendJson(res, 200, {
            port: PORT,
            mainUrls: localIps().map(ip => `http://${ip}:${PORT}/${encodeURIComponent(MAIN_FILE)}`),
            answerUrls: localIps().map(ip => `http://${ip}:${PORT}/answer.html`)
        });
        return true;
    }

    if (req.method === 'POST' && pathname === '/api/state') {
        if (!authorizeHost(req, res)) return true;
        try {
            const body = await readBody(req);
            const next = JSON.parse(body || '{}');
            if (!validState(next)) throw new Error('竞赛状态格式无效');
            if (next.syncSession !== activeSession && revisions.has(next.syncSession)) {
                sendJson(res, 409, {ok: false, code: 'HOST_REPLACED', error: '另一主控已接管或比赛已清空'});
                return true;
            }
            if (next.syncRevision <= (revisions.get(next.syncSession) || 0)) {
                sendJson(res, 409, {ok: false, error: '已忽略过期状态'});
                return true;
            }
            revisions.set(next.syncSession, next.syncRevision);
            activeSession = next.syncSession;
            state = {
                ...emptyState(),
                isLive: next.isLive === true,
                round: next.round || 'r1',
                roundName: next.roundName || '第一轮：必答题',
                usedCount: next.usedCount || 0,
                hasQuestion: next.hasQuestion === true,
                hasShowAns: next.hasShowAns !== false,
                question: next.question || null,
                teams: next.teams,
                updatedAt: new Date().toISOString()
            };
            sendJson(res, 200, {ok: true});
        } catch (err) {
            sendJson(res, 400, {ok: false, error: err.message});
        }
        return true;
    }

    if (req.method === 'POST' && pathname === '/api/reset') {
        if (!authorizeHost(req, res)) return true;
        const session = req.headers['x-host-session'];
        if (session && session === lastResetSession && activeSession === null) {
            sendJson(res, 200, {ok: true});
            return true;
        }
        if (!session || (session !== activeSession && (activeSession !== null || revisions.has(session)))) {
            sendJson(res, 409, {ok: false, code: 'HOST_REPLACED', error: '当前页面不是主控，请使用最新主控页面清空'});
            return true;
        }
        state = emptyState();
        revisions.set(session, revisions.get(session) || 0);
        activeSession = null;
        lastResetSession = session;
        sendJson(res, 200, {ok: true});
        return true;
    }

    return false;
}

function authorizeHost(req, res) {
    if (req.headers['x-host-token'] === HOST_TOKEN) return true;
    sendJson(res, 403, {ok: false, error: '主控验证失败，请重新打开服务启动时显示的主控链接'});
    return false;
}

function validState(next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    if (typeof next.syncSession !== 'string' || !next.syncSession.length || next.syncSession.length > 100) return false;
    if (!Number.isSafeInteger(next.syncRevision) || next.syncRevision < 1) return false;
    if (!Array.isArray(next.teams) || !next.teams.every(t => t && Number.isInteger(t.id) && typeof t.name === 'string' && Number.isFinite(t.score))) return false;
    if (next.hasQuestion && !next.question) return false;
    if (next.question) {
        const q = next.question;
        if (typeof q !== 'object' || typeof q.stem !== 'string' || typeof q.answer !== 'string') return false;
        if (!Array.isArray(q.options) || !q.options.every(o => o && typeof o.key === 'string' && typeof o.text === 'string')) return false;
        if (!Number.isFinite(q.value)) return false;
    }
    return true;
}

function serveFile(req, res, file) {
    fs.stat(file, (statErr, stat) => {
        if (statErr || !stat.isFile()) {
            res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
            res.end('未找到文件');
            return;
        }
        const stream = fs.createReadStream(file);
        stream.on('error', () => {
            if (!res.headersSent) res.writeHead(500);
            res.end('文件读取失败');
        });
        res.writeHead(200, {
            'Content-Type': mimeType(file),
            'Cache-Control': file.endsWith('.html') ? 'no-store' : 'public, max-age=3600'
        });
        if (req.method === 'HEAD') { stream.destroy(); res.end(); return; }
        res.on('close', () => stream.destroy());
        stream.pipe(res);
    });
}

const server = http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (await handleApi(req, res, url.pathname)) return;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('Method Not Allowed');
        return;
    }

    const file = safePath(url.pathname);
    if (!file) {
        res.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('禁止访问');
        return;
    }
    serveFile(req, res, file);
    } catch (err) {
        if (!res.headersSent) sendJson(res, err instanceof URIError || err instanceof TypeError ? 400 : 500, {ok: false, error: '请求无效'});
        else res.end();
    }
});

server.listen(PORT, HOST, () => {
    console.log(`竞赛系统服务已启动：http://127.0.0.1:${PORT}/${encodeURIComponent(MAIN_FILE)}`);
    const ips = localIps();
    if (ips.length) {
        console.log('局域网访问地址：');
        ips.forEach(ip => {
            console.log(`  主竞赛页：http://${ip}:${PORT}/${encodeURIComponent(MAIN_FILE)}#host=${HOST_TOKEN}`);
            console.log(`  手机答案端：http://${ip}:${PORT}/answer.html`);
        });
    } else {
        console.log('未检测到局域网 IPv4 地址，请检查网络连接。');
    }
});
