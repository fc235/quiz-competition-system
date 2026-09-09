# 竞赛抽题系统

支持 Excel 题库导入、四轮抽题、点选队伍计分、排名和局域网手机答案端。投影建议使用1920×1080、浏览器100%缩放和全屏模式，按最多18队设计。

## 直接使用

在本仓库 Releases 下载 Windows 64位便携包，完整解压后双击“启动局域网服务.bat”，浏览器打开 http://127.0.0.1:8123/ 。比赛期间保持服务窗口打开。

便携包自带运行依赖，适用于 Windows 10/11 64位。详细操作及题库格式见[使用说明](使用说明.md)。换电脑需另行复制Excel题库；原浏览器比赛进度不会随文件包迁移。

## 源码运行与依赖

源码区不提交第三方库、运行环境及发布压缩包。

1. 安装 [Node.js](https://nodejs.org/)，本版本验证环境为 v24.13.1。服务端只使用内置模块，无需安装 npm 依赖。
2. 下载 [SheetJS 0.20.3 浏览器库](https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js)，保存到项目的 `js/xlsx.full.min.js`，用于离线读取Excel。
3. 在项目目录执行 `node server.js`，或在 Windows 双击“启动局域网服务.bat”。使用 Chrome 或 Edge 打开本机地址。

手机与电脑连接同一局域网，访问服务窗口显示的手机答案端地址。每场比赛只使用一个主控页面。

## 抽题逻辑位置

核心逻辑在[竞赛抽题系统.html](竞赛抽题系统.html)的内嵌 JavaScript 中，可按函数名搜索。行号对应首次发布版本。

| 位置 | 作用 |
| --- | --- |
| 第881行 | Excel工作表名称映射：单选、判断、多选、简答。 |
| 第958行 `doPick()` | 过滤已抽题目，使用 `Math.floor(Math.random() * avail.length)` 随机选取一题，记录已抽标识并保存状态。题池为空时提示已抽完。 |
| 第974行 `pickNormal()` | 第一轮单选；第二轮多选与判断混合；第四轮全部简答。题目分值设为10。 |
| 第983行 `pickR3(s)` | 第三轮10分池包含10分简答和全部多选；20/30分池分别包含对应分值简答。 |
| 第1084行 `judge()` | 答对按当前题分值加分；第二、四轮答错扣10分，第一、三轮答错不扣分。 |
| 第1133行 `resetBank()` | 清除已抽题标识，允许重新抽题。 |
| 第1163行 `analyzeAwards()` | 奖项名额及同分分析。 |

去重标识为“题型 + 题干”，通过共享的 `USED_IDS` 集合跨轮次去重。同题型相同题干视为同一题。第三轮与其他轮次共用多选、简答题库，准备题量时需考虑此前已抽题目。随机数使用浏览器 `Math.random()`。

`server.js` 负责静态页面服务、主控验证与状态同步；`answer.html` 负责手机答案展示与轮询。

## 测试

回归测试：

```powershell
node --test tests/regression.test.js
```

浏览器检查额外需要 Playwright 和本机 Chrome，仅开发验证使用：

```powershell
npm install --no-save --package-lock=false playwright
node tests/projection-check.js
```

检查覆盖Excel导入、计分、答案同步、服务重启和1080p布局。生成文件位于已忽略的 `test-results/`。
