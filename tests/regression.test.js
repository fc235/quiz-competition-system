const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = [...fs.readFileSync(path.join(root, '竞赛抽题系统.html'), 'utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).join('\n');

function page(saved = {}) {
    const elements = {}, alerts = [], posts = [], timers = [];
    const get = id => elements[id] ||= {
        style: {}, value: id === 'teamCount' ? '12' : '0', disabled: id === 'btnStart', innerHTML: '',
        classList: {add() {}, remove() {}, toggle() {}},
        addEventListener(type, fn) { this[type] = fn; },
        setAttribute() {}
    };
    class FileReader { readAsArrayBuffer() { this.onload({target: {result: new ArrayBuffer(0)}}); } }
    const context = vm.createContext({
        console, document: {getElementById: get, querySelectorAll: () => [], querySelector: () => null, body: {classList: {toggle() {}}}, documentElement: {style: {setProperty() {}}}, addEventListener() {}},
        localStorage: {getItem: k => saved[k] ?? null, setItem: (k,v) => saved[k] = v, removeItem: k => delete saved[k]},
        sessionStorage: {getItem: () => null, setItem() {}},
        location: {protocol: 'http:', hostname: '127.0.0.1', hash: '', pathname: '/', search: '', reload() {}},
        history: {replaceState() {}}, crypto: require('node:crypto').webcrypto,
        alert: x => alerts.push(x), confirm: () => true, prompt: () => '1',
        fetch: async (u,o) => { posts.push({u,o}); return {ok: true, status: 200, json: async () => ({token: 'test-token'})}; },
        setTimeout: fn => {timers.push(fn); return timers.length;}, clearTimeout() {},
        window: {open() {}, addEventListener() {}}, navigator: {}, Blob, FileReader, URLSearchParams, AbortController
    });
    vm.runInContext(source, context);
    return {context, get, saved, alerts, posts, timers, run: s => vm.runInContext(s, context)};
}

test('failed import preserves previous bank and start state', () => {
    const p = page();
    p.context.XLSX = {read: () => ({Sheets: {}}), utils: {sheet_to_json: () => []}};
    p.run("DB.danxuan=[{题干:'旧题',答案:'A'}];document.getElementById('btnStart').disabled=false;");
    p.get('excelFile').change({target: {files: [{}]}});
    assert.equal(p.run('DB.danxuan.length'), 1);
    assert.equal(p.get('btnStart').disabled, false);
});

test('bank-only saved state enables Start', () => {
    const p = page({quizDB_v2: JSON.stringify({danxuan: [{题干: '题'}], panduan: [], duoxuan: [], jianda: []})});
    assert.equal(p.get('btnStart').disabled, false);
});

test('partial import failure preserves all previous sheets', () => {
    const p = page();
    p.context.XLSX = {read: () => ({Sheets: {'单选': 'ok', '判断': 'bad'}}), utils: {sheet_to_json: s => {
        if (s === 'bad') throw new Error('invalid sheet');
        return [{题干: '新题'}];
    }}};
    p.run("DB.danxuan=[{题干:'旧题'}];DB.panduan=[{题干:'旧判断'}];");
    p.get('excelFile').change({target: {files: [{}]}});
    assert.equal(p.run('DB.danxuan[0].题干'), '旧题');
    assert.equal(p.run('DB.panduan[0].题干'), '旧判断');
});

test('storage failure produces one visible warning', () => {
    const p = page();
    p.context.localStorage.setItem = () => {throw new Error('quota');};
    p.run('saveDB();saveState();saveState();');
    assert.equal(p.alerts.length, 1);
    assert.match(p.alerts[0], /本地保存失败/);
});

test('sync serializes requests and coalesces intermediate scores', async () => {
    const p = page();
    const sent = []; let release;
    p.context.fetch = async (u,o) => {
        if (u === '/api/host') return {ok: true, json: async () => ({token: 'test'})};
        sent.push(JSON.parse(o.body));
        if (sent.length === 1) await new Promise(resolve => release = resolve);
        return {ok: true};
    };
    p.run("isHostSession=true;TEAMS=[{id:0,name:'A',score:100}];syncServerState();");
    for (let i=0;i<12;i++) await Promise.resolve();
    p.run('TEAMS[0].score=110;syncServerState();TEAMS[0].score=120;syncServerState();');
    assert.equal(sent.length, 1);
    release();
    await p.run('syncPromise');
    assert.deepEqual(sent.map(s => s.teams[0].score), [100, 120]);
});

test('reset waits for in-flight sync and stops queued writes', async () => {
    const p = page(); let release; const sent = [];
    p.context.fetch = async (u,o) => {
        if (u === '/api/host') return {ok: true, json: async () => ({token: 'test'})};
        sent.push(u);
        if (u === '/api/state') await new Promise(resolve => release = resolve);
        return {ok: true};
    };
    p.run('isHostSession=true;syncServerState();');
    for (let i=0;i<12;i++) await Promise.resolve();
    const reset = p.run('resetServerState()');
    assert.deepEqual(sent, ['/api/state']);
    release(); await reset;
    assert.deepEqual(sent, ['/api/state', '/api/reset']);
    assert.equal(p.run('resettingServer'), true);
});

test('local host obtains fresh credentials after server restart', async () => {
    const p = page(); let hostRequests = 0; let stateRequests = 0;
    p.context.fetch = async (u,o) => {
        if (u === '/api/host') return {ok: true, json: async () => ({token: 'token-' + (++hostRequests)})};
        stateRequests++;
        return stateRequests === 1 ? {ok: false, status: 403} : {ok: true, status: 200};
    };
    p.run('isHostSession=true;syncServerState();');
    await p.run('syncPromise');
    p.run('syncServerState();');
    await p.run('syncPromise');
    assert.equal(hostRequests, 2);
    assert.equal(stateRequests, 2);
    assert.equal(p.get('syncStatus').textContent, '已同步');
});

test('all rounds retain original scoring and penalties', () => {
    for (const round of ['r1', 'r2', 'r3', 'r4']) {
        for (const correct of [true, false]) {
            const p = page();
            p.run(`curR='${round}';TEAMS=[{id:0,name:'A',score:100}];curQ={_val:${round === 'r3' ? 30 : 10}};hasShowAns=true;selectedTeamId=0;judge(${correct});`);
            assert.equal(p.run('TEAMS[0].score'), correct ? (round === 'r3' ? 130 : 110) : (['r2', 'r4'].includes(round) ? 90 : 100));
        }
    }
});

test('restored host actively synchronizes', async () => {
    const p = page({quizDB_v2: JSON.stringify({danxuan: [], panduan: [], duoxuan: [], jianda: []}), quizState_v2: JSON.stringify({version: 2, isLive: true, TEAMS: [{id: 0, name: '队1', score: 120}], curR: 'r1'})});
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.ok(p.posts.some(x => x.u === '/api/state' && x.o?.method === 'POST'));
});

test('requested original failed-pick scoring behavior remains unchanged', () => {
    const p = page();
    p.run("DB.jianda=[{题干:'20分测试',答案:'答案',分值:'20'}];curR='r3';TEAMS=[{id:0,name:'队1',score:100}];pickR3(20);showAns();pickR3(30);selectedTeamId=0;judge(true);");
    assert.equal(p.run('TEAMS[0].score'), 130);
});

test('judgment credits selected team without prompt or alert and clears selection', () => {
    const p = page();
    p.context.prompt = () => {throw new Error('prompt must not open');};
    p.run("TEAMS=[{id:0,name:'A',score:100},{id:1,name:'B',score:100}];curR='r3';curQ={_val:20};hasShowAns=true;selectTeam(1);judge(true);");
    assert.equal(p.run('TEAMS[0].score'), 100);
    assert.equal(p.run('TEAMS[1].score'), 120);
    assert.equal(p.run('selectedTeamId'), null);
    assert.equal(p.run('curQ'), null);
    assert.equal(p.alerts.length, 0);
    p.run('judge(true)');
    assert.equal(p.run('TEAMS[1].score'), 120, 'double click cannot score twice');
});

test('non-penalty wrong answers finish immediately without selecting a team', () => {
    for (const round of ['r1', 'r3']) {
        const p = page();
        p.context.prompt = () => {throw new Error('prompt must not open');};
        p.run(`TEAMS=[{id:0,name:'A',score:100}];curR='${round}';curQ={_val:30};hasShowAns=true;judge(false);`);
        assert.equal(p.run('TEAMS[0].score'), 100);
        assert.equal(p.run('curQ'), null);
        assert.equal(p.alerts.length, 0);
    }
});

test('scoring requires selection, penalties stay at ten, round switch clears selection', () => {
    const p = page();
    p.context.prompt = () => {throw new Error('prompt must not open');};
    p.run("TEAMS=[{id:0,name:'A',score:100},{id:1,name:'B',score:100}];curR='r2';curQ={_val:30};hasShowAns=true;judge(false);");
    assert.ok(p.run('curQ'));
    assert.equal(p.run('TEAMS[0].score'), 100);
    assert.match(p.get('actionNotice').textContent, /请先点击/);
    p.run('selectTeam(1);judge(false)');
    assert.equal(p.run('TEAMS[1].score'), 90);
    p.run("selectTeam(0);switchR('r4')");
    assert.equal(p.run('selectedTeamId'), null);
});

test('award ties preserve existing quota rules', () => {
    const p = page();
    p.run("TEAMS=[{id:0,name:'A',score:130},{id:1,name:'B',score:120},{id:2,name:'C',score:120}];AWARDS={first:1,second:2,third:0,excellent:0};");
    assert.equal(p.run('analyzeAwards().needsOvertime'), false);
    p.run('AWARDS.second=1');
    assert.equal(p.run('analyzeAwards().needsOvertime'), true);
});

async function startServer(t) {
    const boot = `const http=require('http');const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(p,h,cb){return listen.call(this,0,'127.0.0.1',()=>{console.log('TEST_PORT='+this.address().port);});};require('./server.js');`;
    const child = spawn(process.execPath, ['-e', boot], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    t.after(() => child.kill());
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {child.kill(); reject(new Error('server startup timeout'));}, 5000);
        child.once('exit', code => { clearTimeout(timeout); reject(new Error('early exit ' + code)); });
        child.stdout.on('data', b => { const m = b.toString().match(/TEST_PORT=(\d+)/); if (m) {clearTimeout(timeout);resolve(m[1]);} });
    });
    return 'http://127.0.0.1:' + port;
}

test('malformed URL returns 400 and server remains alive', async t => {
    const base = await startServer(t);
    const result = await fetch(base + '/%E0%A4%A').catch(() => null);
    assert.equal(result?.status, 400);
    assert.equal((await fetch(base + '/api/state')).status, 200);
});

test('state writes and reset require host credentials', async t => {
    const base = await startServer(t);
    assert.equal((await fetch(base + '/api/state', {method: 'POST', body: '{}'})).status, 403);
    assert.equal((await fetch(base + '/api/reset', {method: 'POST'})).status, 403);
    assert.equal((await fetch(base + '/server.js')).status, 403);
    assert.equal((await fetch(base + '/tests/regression.test.js')).status, 403);
    assert.equal((await fetch(base + '/answer.html')).status, 200);
    assert.equal((await fetch(base + '/js/xlsx.full.min.js', {method: 'HEAD'})).status, 200);
    const customHostStatus = await new Promise((resolve, reject) => {
        require('node:http').get(base + '/api/host', {headers: {Host: 'untrusted.example'}}, res => {
            res.resume(); resolve(res.statusCode);
        }).on('error', reject);
    });
    assert.equal(customHostStatus, 403);
});

test('authorized state rejects stale revisions and malformed shape', async t => {
    const base = await startServer(t);
    const auth = await fetch(base + '/api/host');
    assert.equal(auth.status, 200);
    const {token} = await auth.json();
    const headers = {'Content-Type': 'application/json', 'X-Host-Token': token, 'X-Host-Session': 'test'};
    const state = {isLive: true, teams: [{id: 0, name: '测试', score: 130}], syncSession: 'test', syncRevision: 2};
    assert.equal((await fetch(base + '/api/state', {method: 'POST', headers, body: JSON.stringify(state)})).status, 200);
    assert.equal((await fetch(base + '/api/state', {method: 'POST', headers, body: JSON.stringify({...state, syncRevision: 1, teams: []})})).status, 409);
    assert.equal((await (await fetch(base + '/api/state')).json()).teams[0].score, 130);
    assert.equal((await fetch(base + '/api/state', {method: 'POST', headers, body: JSON.stringify({...state, syncRevision: 3, hasQuestion: true, question: null})})).status, 400);
    assert.equal((await fetch(base + '/api/reset', {method: 'POST', headers})).status, 200);
    assert.equal((await (await fetch(base + '/api/state')).json()).isLive, false);
});

test('new host supersedes old tabs and reset prevents state resurrection', async t => {
    const base = await startServer(t);
    const {token} = await (await fetch(base + '/api/host')).json();
    const headers = {'Content-Type': 'application/json', 'X-Host-Token': token};
    const post = (session, revision, score) => fetch(base + '/api/state', {method: 'POST', headers, body: JSON.stringify({isLive: true, teams: [{id: 0, name: 'A', score}], syncSession: session, syncRevision: revision})});
    assert.equal((await post('old-tab', 1, 100)).status, 200);
    assert.equal((await post('new-tab', 1, 120)).status, 200);
    const rejected = await post('old-tab', 2, 100);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, 'HOST_REPLACED');
    assert.equal((await (await fetch(base + '/api/state')).json()).teams[0].score, 120);
    assert.equal((await fetch(base + '/api/reset', {method: 'POST', headers: {...headers, 'X-Host-Session': 'old-tab'}})).status, 409);
    assert.equal((await fetch(base + '/api/reset', {method: 'POST', headers: {...headers, 'X-Host-Session': 'new-tab'}})).status, 200);
    assert.equal((await fetch(base + '/api/reset', {method: 'POST', headers: {...headers, 'X-Host-Session': 'new-tab'}})).status, 200, 'reset retry is idempotent');
    assert.equal((await post('old-tab', 3, 100)).status, 409);
    assert.equal((await post('new-tab', 2, 120)).status, 409);
    assert.equal((await (await fetch(base + '/api/state')).json()).isLive, false);
    assert.equal((await post('fresh-tab', 1, 100)).status, 200);
});

test('superseded page stops sync retries', async () => {
    const p = page(); let writes = 0;
    p.context.fetch = async (u,o) => {
        if (u === '/api/host') return {ok: true, json: async () => ({token: 'test'})};
        writes++;
        return {ok: false, status: 409, json: async () => ({code: 'HOST_REPLACED'})};
    };
    p.run('isHostSession=true;syncServerState();');
    await p.run('syncPromise');
    p.run('syncServerState();');
    await p.run('syncPromise');
    assert.equal(writes, 1);
    assert.match(p.get('syncStatus').textContent, /已接管/);
});

test('uncertain reset can be retried without republishing old state', async () => {
    const p = page(); let resets = 0, writes = 0;
    p.context.fetch = async (u,o) => {
        if (u === '/api/host') return {ok: true, json: async () => ({token: 'test'})};
        if (u === '/api/reset') {
            if (++resets === 1) throw new Error('response lost after reset');
            return {ok: true};
        }
        writes++; return {ok: true};
    };
    p.run('isHostSession=true;');
    await assert.rejects(p.run('resetServerState()'), /response lost/);
    for (let i=0;i<12;i++) await Promise.resolve();
    assert.equal(writes, 0, 'must not republish after uncertain reset');
    await p.run('resetServerState()');
    assert.equal(resets, 2);
});
