// 検算：TAF に似せた偽のサイトを手元に立てて、取得 → 検索の画面づくり → 4桁で引く、までを通しで動かす。
// 本物のサイトには一切つながない。
//
//   npm test
//
// 結果は JSON で出す。ぜんぶ true なら合格。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const FARMS = [
  { code: '00000001', name: '試験　一郎', csv: 'farmA.csv' },
  { code: '00000002', name: '試験　二郎', csv: 'farmB.csv' },
];
const USER = 'farmers\\test', PASS = 'secret';
const log = { signIns: 0 };

const page = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const cookie = (req, k) => (req.headers.cookie || '').split(/;\s*/).map((s) => s.split('=')).find((p) => p[0] === k)?.[1];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(html)); };

  // ADFS に似せたサインイン
  if (u.pathname === '/adfs/ls') {
    if (req.method === 'POST') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const p = new URLSearchParams(b);
        if (p.get('UserName') === USER && p.get('Password') === PASS) {
          log.signIns++;
          res.writeHead(302, { 'set-cookie': 'auth=1; path=/', location: p.get('back') || '/Portal/' });
          res.end();
        } else send(`<form method=post><span id=errorText>ユーザーIDまたはパスワードが違います</span>
          <input id=userNameInput name=UserName><input id=passwordInput name=Password type=password><span id=submitButton onclick="this.closest('form').submit()">サインイン</span></form>`);
      });
      return;
    }
    return send(`<p>ユーザーID、パスワードを入力してサインインしてください</p><form method=post>
      <input type=hidden name=back value="${u.searchParams.get('back') || ''}">
      <input id=userNameInput name=UserName><input id=passwordInput name=Password type=password>
      <span id=submitButton role=button onclick="this.closest('form').submit()">サインイン</span></form>`);
  }
  if (cookie(req, 'auth') !== '1') {
    res.writeHead(302, { location: '/adfs/ls?back=' + encodeURIComponent(req.url) });
    return res.end();
  }
  if (u.pathname === '/SeisanPC/DZL99') {
    const want = u.searchParams.get('code') || '';
    const rows = FARMS.filter((f) => !want || f.code === want)
      .map((f) => `<tr><td><input type=radio name=farm onclick="location.href='/SeisanPC/DLL60?farm=${f.code}'"></td><td>${f.name}</td><td>${f.code}</td></tr>`).join('');
    return send(`<h2>ユーザー変更</h2><form><span>生産者コード</span><input type=text name=code value="${want}">
      <button type=submit>この条件で表示</button></form><table><tr><th></th><th>生産者名</th><th>生産者コード</th></tr>${rows}</table>`);
  }
  if (u.pathname === '/SeisanPC/DLL60') {
    res.setHeader('set-cookie', 'farm=' + u.searchParams.get('farm') + '; path=/');
    return send(`<p>農場名：${u.searchParams.get('farm')}</p><a href="/SeisanPC/DLL61">牛一覧</a><a href="#">CSV出力</a>`);
  }
  if (u.pathname === '/SeisanPC/DLL61') {
    return send(`<h2>在籍牛一覧</h2><a href="/SeisanPC/csv">表示中リストCSV出力</a>`);
  }
  if (u.pathname === '/SeisanPC/csv') {
    const f = FARMS.find((x) => x.code === cookie(req, 'farm'));
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="list.csv"` });
    return res.end(fs.readFileSync(path.join(HERE, 'fixtures', f.csv)));
  }
  if (u.pathname === '/Portal/') return send(`<a href="/SeisanPC/DZL99">酪畜履歴</a>`);
  res.writeHead(404); res.end();
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// 本番のスクリプトを、偽のサイトと試験用の設定に向けて動かす
const cfgFile = path.join(OUT, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ '保存先フォルダ': path.join(OUT, 'save'), '農家': '全部', 'ブラウザ': '' }));
Object.assign(process.env, {
  TAF_PORTAL_URL: base + '/Portal/',
  TAF_RAKUCHIKU_URL: base + '/SeisanPC/',
  TAF_CONFIG: cfgFile,
  TAF_USER: USER,
  TAF_PASS: PASS,
});
if (fs.existsSync('/opt/pw-browsers/chromium')) process.env.TAF_BROWSER_PATH ||= '/opt/pw-browsers/chromium';

const { run } = await import('../taf-download.mjs');
const failed = await run();

const save = path.join(OUT, 'save');
const r = {};
r['取れなかったものがない'] = failed.length === 0;
r['サインインは1回だけ'] = log.signIns === 1;
r['全農家のフォルダができた'] = FARMS.every((f) => fs.existsSync(path.join(save, `${f.code}_${f.name.replace(/\s+/g, ' ')}`, '牛一覧_最新.csv')));
r['検索の画面ができた'] = fs.existsSync(path.join(save, '牛検索.html'));

// 検索の画面を開いて、4桁で引いてみる
const browser = await chromium.launch(process.env.TAF_BROWSER_PATH ? { executablePath: process.env.TAF_BROWSER_PATH } : {});
const p = await browser.newPage();
await p.goto('file://' + path.join(save, '牛検索.html'));
await p.fill('#q', '1111');
r['4桁で1頭出る'] = (await p.locator('.cow').count()) === 1;
r['名号が全角カナで出る'] = (await p.locator('.cow .name').first().innerText()) === 'テスト ウシ ニ';
r['妊鑑マイナスの印が出る'] = (await p.locator('.cow .tag', { hasText: '妊鑑マイナス' }).count()) === 1;
r['体細胞の多い牛に印が出る'] = (await p.locator('.cow .tag.bad').count()) === 1;
await p.fill('#q', '0722');
r['同じ4桁は両方の農家から出る'] = (await p.locator('.cow').count()) === 2;
await p.fill('#q', '07226');
r['5桁（最後の1桁つき）で絞れる'] = (await p.locator('.cow').count()) === 1;
await p.fill('#q', 'ベツノ');
r['名号の一部でも探せる'] = (await p.locator('.cow').count()) === 1;
await p.fill('#q', '9999');
r['ない番号は「見つかりません」'] = (await p.locator('.empty').innerText()).includes('見つかりません');
await p.screenshot({ path: path.join(OUT, 'viewer.png'), fullPage: true });
await p.fill('#q', '0722');
await p.screenshot({ path: path.join(OUT, 'viewer-0722.png'), fullPage: true });
await browser.close();
server.close();

console.log(JSON.stringify(r, null, 2));
if (Object.values(r).some((x) => !x)) process.exitCode = 1;
