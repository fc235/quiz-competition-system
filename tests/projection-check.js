// Run with the bundled Playwright on NODE_PATH. Starts an isolated local server.
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
    const output = path.resolve(__dirname, '../test-results');
    fs.mkdirSync(output, {recursive: true});
    const boot = `const http=require('http');const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(){return listen.call(this,Number(process.env.TEST_PORT||0),'127.0.0.1',()=>console.log('TEST_PORT='+this.address().port));};require('./server.js');`;
    let child = spawn(process.execPath, ['-e', boot], {cwd: path.resolve(__dirname, '..'), windowsHide: true});
    let browser;
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('startup timeout')), 5000);
            child.stdout.on('data', b => {const m=b.toString().match(/TEST_PORT=(\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
        });
        browser = await chromium.launch({channel: 'chrome', headless: true});
        const page = await browser.newPage({viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1});
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('dialog', async dialog => {errors.push('unexpected dialog: ' + dialog.type());await dialog.dismiss();});
        const url = `http://127.0.0.1:${port}`;
        await page.goto(url);
        await page.screenshot({path: path.join(output, '1080p-setup.png'), animations: 'disabled'});
        // Exercise the real Excel parser and file input, not a mocked workbook.
        const xlsx = require('../js/xlsx.full.min.js');
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([{题干: '下列哪项是开展安全生产工作的基本要求？', A: '严格遵守操作规程', B: '凭经验随意操作', C: '省略必要检查', D: '忽视安全培训', 答案: 'A'}]), '单选');
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([{题干: '请简述应急处置的主要步骤。', 分值: '20', 答案: '及时报告，组织处置，保护人员安全。'}]), '简答');
        const workbookPath = path.join(output, '投影测试.xlsx');
        fs.writeFileSync(workbookPath, Buffer.from(xlsx.write(wb, {type: 'buffer', bookType: 'xlsx'})));
        await page.setInputFiles('#excelFile', workbookPath);
        await page.click('#btnStart');
        await page.click('.c-pick');
        await page.waitForFunction(() => document.getElementById('syncStatus').textContent === '已同步');
        assert.equal(await page.locator('#questionType').textContent(), '单选题');
        assert.equal(await page.locator('#questionValue').textContent(), '10 分');
        await page.locator('#scoreLeft .plus').first().click();
        assert.equal(await page.locator('#scoreLeft .team-card.score-changed').count(), 1);
        assert.equal(await page.locator('#scoreLeft .t-score').first().textContent(), '110');
        await page.locator('#scoreLeft .minus').first().click();
        const measure = async name => {
            const result = await page.evaluate(() => {
                const rect = sel => {const r=document.querySelector(sel).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
                const q = document.querySelector('.question-panel'), bar = document.querySelector('.ctrl-bar');
                return {main: rect('.main-grid'), top: rect('.top-bar'), controls: rect('.ctrl-bar'), questionScroll: q.scrollHeight > q.clientHeight + 1, controlsOverflow: bar.scrollWidth > bar.clientWidth + 1, sidebarScroll: [...document.querySelectorAll('.scoreboard')].map(e => e.scrollHeight > e.clientHeight + 1), teamFont: getComputedStyle(document.querySelector('.t-name')).fontSize};
            });
            assert.ok(result.top.x >= 47 && result.main.right <= 1873, name + ' safe horizontal area');
            assert.ok(result.controls.bottom <= 1033, name + ' safe bottom area');
            assert.equal(result.controlsOverflow, false, name + ' controls fit');
            await page.screenshot({path: path.join(output, name + '.png'), animations: 'disabled'});
            return {name, ...result};
        };
        const results = [await measure('1080p-question')];
        assert.deepEqual(results[0].sidebarScroll, [false, false], 'all 12 default teams visible');
        await page.click('#bAns');
        results.push(await measure('1080p-answer'));
        const phone = await browser.newPage({viewport: {width: 390, height: 844}});
        phone.on('pageerror', e => errors.push(e.message));
        await phone.goto(url + '/answer.html');
        await phone.waitForSelector('.answer .content');
        assert.equal(await phone.locator('.answer .content').textContent(), 'A');
        await phone.screenshot({path: path.join(output, 'phone-answer.png')});
        await phone.evaluate(() => document.querySelector('.answer').dataset.testMarker = 'preserved');
        await phone.waitForTimeout(1800);
        assert.equal(await phone.locator('.answer').getAttribute('data-test-marker'), 'preserved', 'unchanged polling preserves DOM');
        await page.reload();
        await page.waitForFunction(() => document.getElementById('syncStatus').textContent === '已同步');
        assert.equal(await page.locator('#ansContent').textContent(), 'A', 'refresh restores current answer');
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill(); await exited;
        child = spawn(process.execPath, ['-e', boot], {cwd: path.resolve(__dirname, '..'), windowsHide: true, env: {...process.env, TEST_PORT: String(port)}});
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('restart timeout')), 5000);
            child.stdout.on('data', b => {if(b.toString().includes('TEST_PORT=')){clearTimeout(timer);resolve();}});
        });
        await page.waitForFunction(async () => {
            const s = await (await fetch('/api/state')).json();
            return s.isLive && s.question?.answer === 'A';
        }, null, {timeout: 20000});
        console.log('PASS: real server restart restores current question without host interaction');
        await page.click('#nav-r3');
        results.push(await measure('1080p-round3'));
        await page.evaluate(() => pickR3(20));
        assert.equal(await page.locator('#questionType').textContent(), '简答题');
        assert.equal(await page.locator('#questionValue').textContent(), '20 分', 'metadata uses finalized point value');
        await page.click('#bAns');
        results.push(await measure('1080p-short-answer'));
        const answerLayout = await page.locator('#ansBox').evaluate(el => ({top: el.getBoundingClientRect().top, font: getComputedStyle(el.querySelector('.content')).fontSize}));
        assert.equal(answerLayout.font, '48px');
        assert.ok(answerLayout.top < 600, 'short-answer area starts higher on the screen');
        await page.evaluate(() => {
            curQ = {题干: '请结合以下现场情况，说明风险识别和处置措施。\n' + '现场作业涉及多工种协同，应明确职责、检查设备并确认安全条件。'.repeat(7), 答案: ('一、检查作业环境和设备状态，落实人员职责。\n二、发现异常立即报告并组织处置。\n').repeat(8), _t: 'jian', _val: 20};
            hasShowAns = false; renderQ(curQ);refreshControls();showAns();
        });
        await page.waitForFunction(() => { const box = document.getElementById('ansBox'); return box.scrollHeight <= box.clientHeight + 1; });
        assert.equal(await page.locator('#ansBox').evaluate(el => getComputedStyle(el).overflowY), 'hidden');
        results.push(await measure('1080p-long-answer'));
        await page.click('#themeToggle');
        results.push(await measure('1080p-light'));
        await page.evaluate(() => {TEAMS=Array.from({length:18},(_,i)=>({id:i,name:(i+1)+'号参赛队',score:i===17?-100:100+i*10}));renderRank();applyTheme('dark');});
        results.push(await measure('1080p-18-teams'));
        assert.deepEqual(results[results.length - 1].sidebarScroll, [false, false], 'all 18 team scores visible without scrolling');
        const clippedScores = await page.locator('.t-score').evaluateAll(scores => scores.filter(el => {
            const r=el.getBoundingClientRect(), card=el.closest('.team-card').getBoundingClientRect(), board=el.closest('.scoreboard').getBoundingClientRect();
            return el.scrollWidth > el.clientWidth + 1 || r.bottom > card.bottom + 1 || r.top < card.top - 1 || r.bottom > board.bottom + 1 || r.top < board.top - 1;
        }).length);
        assert.equal(clippedScores, 0, '18 scores are not clipped inside cards or sidebar');
        await page.locator('[data-team-id="17"] .t-name').click();
        assert.equal(await page.locator('.team-card.is-selected').count(), 1);
        assert.equal(await page.locator('#bOk').textContent(), '正确 +20');
        await page.screenshot({path: path.join(output, '1080p-team-selected.png'), animations: 'disabled'});
        await page.click('#bOk');
        assert.equal(await page.locator('[data-team-id="17"] .t-score').textContent(), '-80');
        assert.equal(await page.locator('.team-card.is-selected').count(), 0);
        assert.match(await page.locator('#actionNotice').textContent(), /\+20/);
        await page.locator('[data-team-id="0"] .plus').click();
        assert.equal(await page.locator('.team-card.is-selected').count(), 0, 'manual adjustment does not select a team');
        await page.evaluate(() => {switchR('r1');curQ={题干:'不扣分测试',答案:'A',_val:10};renderQ(curQ);showAns();});
        await page.click('#bNo');
        assert.equal(await page.evaluate(() => curQ), null, 'wrong answer without penalty needs no team');
        await page.evaluate(() => {switchR('r2');curQ={题干:'扣分测试',答案:'A',_val:10};renderQ(curQ);showAns();});
        await page.click('#bNo');
        assert.ok(await page.evaluate(() => curQ), 'missing selection retains question');
        await page.locator('[data-team-id="0"] .t-name').click();
        await page.click('#bNo');
        assert.equal(await page.locator('[data-team-id="0"] .t-score').textContent(), '100', 'manual +10 followed by penalty -10');
        await page.locator('[data-team-id="1"]').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-team-id="1"]').getAttribute('aria-current'), 'true');
        await page.keyboard.press('Space');
        assert.equal(await page.locator('.team-card.is-selected').count(), 0);
        for (const count of [6, 12, 13, 16, 18]) {
            await page.evaluate(n => {TEAMS=Array.from({length:n},(_,i)=>({id:i,name:'现场参赛单位名称较长测试'+(i+1),score:i%2 ? -100 : 1000}));renderRank();}, count);
            const hidden = await page.locator('.t-score').evaluateAll(scores => scores.filter(el => {
                const r=el.getBoundingClientRect(), board=el.closest('.scoreboard').getBoundingClientRect();
                return el.scrollWidth > el.clientWidth + 1 || r.bottom > board.bottom + 1 || r.top < board.top - 1;
            }).length);
            assert.equal(hidden, 0, count + ' teams: long names and negative/four-digit scores fit');
        }
        await page.evaluate(() => {TEAMS=Array.from({length:30},(_,i)=>({id:i,name:(i+1)+'号参赛队',score:100}));renderRank();});
        results.push(await measure('1080p-30-teams'));
        assert.deepEqual(results[results.length - 1].sidebarScroll, [false, false], 'all 30 team scores visible without scrolling');
        await page.evaluate(() => {TEAMS=Array.from({length:12},(_,i)=>({id:i,name:(i+1)+'号参赛队',score:220-i*10}));renderRank();});
        await page.evaluate(() => endCompetition(false));
        await page.screenshot({path: path.join(output, '1080p-results-light.png'), animations: 'disabled'});
        assert.equal(await page.locator('.all-ranks').getAttribute('open'), null);
        assert.equal(await page.locator('.award-team').count(), 12);
        await page.evaluate(() => applyTheme('dark'));
        await page.screenshot({path: path.join(output, '1080p-results.png'), animations: 'disabled'});
        await page.locator('.all-ranks summary').click();
        assert.equal(await page.locator('.rank-row').count(), 12);
        assert.ok(await page.locator('.rank-row').first().isVisible());
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(output, 'projection-metrics.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({passed: true, scenarios: results, browserErrors: errors}, null, 2));
    } finally {
        if (browser) await browser.close();
        child.kill();
    }
})().catch(e => {console.error(e);process.exitCode=1;});
