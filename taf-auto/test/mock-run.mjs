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
  // 一覧の下の方にあって、スクロールしないと出てこない。選ぶとホームが別の画面（DLL70）
  { code: '00000003', name: '試験　三郎', csv: 'farmC.csv', home: 'DLL70' },
  // 見る権限がない農家（取らない農家に入れておく）
  { code: '00000004', name: '権限　なし', csv: null },
  // 牛一覧からCSVを出せないが、農場状況の「経産牛」「未経産牛」の数字から一覧が見られる農家
  { code: '00000005', name: '画面　だけ', csv: null, screen: true },
];
// JA ごとにアカウントが違い、見える農家も違う（清水町と新得町のように）
const ACCOUNTS = [
  { name: '清水町', user: 'farmers\\shimizu', pass: 'secret1', farms: ['00000001', '00000003', '00000004', '00000005'] },
  { name: '新得町', user: 'farmers\\shintoku', pass: 'secret2', farms: ['00000002'] },
];
const log = { signIns: 0, viaPortal: 0, directHit: 0 };
const ALL = ['経産牛', '未経産牛', '搾乳牛', '乾乳牛', '素牛', '肥育牛', '初生', '預かっている牛', '預けている牛'];
let base = '';

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
        const ai = ACCOUNTS.findIndex((a) => a.user === p.get('UserName') && a.pass === p.get('Password'));
        if (ai >= 0) {
          log.signIns++;
          res.writeHead(302, { 'set-cookie': `auth=${ai + 1}; path=/`, location: p.get('back') || '/Portal/' });
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
  const acc = ACCOUNTS[(+cookie(req, 'auth') || 0) - 1];
  if (!acc) {
    res.writeHead(302, { location: '/adfs/ls?back=' + encodeURIComponent(req.url) });
    return res.end();
  }
  // ポータル。酪畜履歴は Redirector.aspx を通して新しいタブで開く（本物と同じ）
  if (u.pathname === '/Portal/') {
    return send(`<table><tr><td><a href="Redirector.aspx?ushi=${encodeURIComponent(base + '/SeisanPC/')}" target="_blank"><span>酪畜履歴</span></a></td></tr></table>`);
  }
  if (u.pathname === '/Portal/Redirector.aspx') {
    log.viaPortal++;
    res.writeHead(302, { 'set-cookie': 'rk=1; path=/', location: '/SeisanPC/DZL99' });
    return res.end();
  }
  // 酪畜履歴はポータルを通っていないと入れない
  if (u.pathname.startsWith('/SeisanPC/') && cookie(req, 'rk') !== '1') {
    log.directHit++;
    return send('<p>セッションが切れました。ポータルからやり直してください。</p>');
  }
  if (u.pathname === '/SeisanPC/DZL99') {
    const mine = FARMS.filter((f) => acc.farms.includes(f.code));
    const rowOf = (f) => `<tr data-code="${f.code}"><td><input name="radioSelect" type="radio" value="${f.code}" style="display:none"><span class="radio"></span></td><td>${f.name}</td><td>${f.code}</td></tr>`;
    // はじめは1戸だけ。いちばん下までスクロールすると続きが読み込まれる（本物と同じ）
    const rows = rowOf(mine[0]);
    const rest = JSON.stringify(mine.slice(1).map(rowOf));
    const homes = JSON.stringify(Object.fromEntries(FARMS.map((f) => [f.code, f.home || 'DLL60'])));
    return send(`<span>JA</span><span>生産者コード</span><input class="SEISANCODE is-number is-integer" data-name="生産者コード" maxlength="8" name="SEISANCODE" type="tel">
      <a class="jsSearchUser btn search-btn icon-reload" tabindex="0">この条件で表示</a>
      <p>${mine.length} 件</p>
      <table id="t"><tr><th></th><th>生産者名</th><th>生産者コード</th></tr>${rows}</table>
      <div style="height:2500px"></div>
      <a class="btn-link green" id="BTNCHANGE">変更</a>
      <script>
        const rest = ${rest}, homes = ${homes};
        const wire = () => document.querySelectorAll('span.radio').forEach((sp) => sp.onclick = () => sp.previousElementSibling.click());
        window.addEventListener('scroll', () => {
          // 重い日を再現：1回に1戸ずつ、3秒たってから出てくる
          if (rest.length && !window.loading && window.scrollY + innerHeight >= document.body.scrollHeight - 50) {
            window.loading = true;
            const more = rest.splice(0, 1);
            setTimeout(() => { document.getElementById('t').insertAdjacentHTML('beforeend', more.join('')); wire(); window.loading = false; }, 3000);
          }
        });
        document.querySelector('.jsSearchUser').onclick = () => {
          const c = document.querySelector('[name=SEISANCODE]').value;
          const hit = rest.filter((r) => r.includes('"' + c + '"'));
          if (hit.length) { document.getElementById('t').insertAdjacentHTML('beforeend', hit.join('')); wire(); }
          document.querySelectorAll('tr[data-code]').forEach((tr) => { tr.style.display = !c || tr.dataset.code === c ? '' : 'none'; });
        };
        wire();
        document.getElementById('BTNCHANGE').onclick = () => {
          const r = document.querySelector('[name=radioSelect]:checked');
          if (r) location.href = '/SeisanPC/' + homes[r.value] + '?farm=' + r.value;
        };
      </script>`);
  }
  if (u.pathname === '/SeisanPC/DLL70') {
    // ホームが違う農家。牛一覧へのメニューが無い
    res.setHeader('set-cookie', 'farm=' + u.searchParams.get('farm') + '; path=/');
    return send(`<p>別のホーム画面：${u.searchParams.get('farm')}</p>`);
  }
  // ---- 画面だけの農家（00000005）----
  const SCREEN_HEAD = ['耳標ID', '生年月日', '名号', '品種', '産次', '最新分娩日'];
  const SCREEN_COWS = {
    // 経産牛は1ページ1頭で「次へ」がある。1頭目は行の中に10桁が隠れている。2頭目は画面に出ている5桁しか分からない
    keisan: [['7777712343', '2020/01/01', 'ｶﾞﾒﾝ ｲﾁ', 'ホルス', '2', '2026/05/01', true], ['7777756785', '2021/02/02', 'ｶﾞﾒﾝ ﾆ', 'ホルス', '1', '2026/06/01', false]],
    mikei: [['7777790127', '2025/03/03', 'ｶﾞﾒﾝ ｻﾝ', 'ホルス', '-', '', true]],
  };
  if (u.pathname === '/SeisanPC/DLL60' && cookie(req, 'farm') === '00000005' && !u.searchParams.get('farm')) {
    return send(`<nav id="menu"><a href="/SeisanPC/DLL60">農場状況</a></nav>
      <div class="box"><p>経産牛</p><a href="/SeisanPC/DKL10?k=keisan&p=0">${SCREEN_COWS.keisan.length}</a></div>
      <div class="box"><p>未経産牛</p><a href="/SeisanPC/DKL10?k=mikei&p=0">${SCREEN_COWS.mikei.length}</a></div>`);
  }
  if (u.pathname === '/SeisanPC/DKL10') {
    const list = SCREEN_COWS[u.searchParams.get('k')], pg = +u.searchParams.get('p');
    const per = 1, part = list.slice(pg * per, pg * per + per);
    const tr = part.map((c) => `<tr>${c.slice(0, 6).map((v, i) => i === 0
      ? `<td>${c[6] ? `<input type="hidden" value="${v}">` : ''}<span class="big">${v.slice(5, 9)}</span> ${v.slice(9)}</td>`
      : `<td>${v}</td>`).join('')}</tr>`).join('');
    const next = (pg + 1) * per < list.length ? `<a href="/SeisanPC/DKL10?k=${u.searchParams.get('k')}&p=${pg + 1}">次へ</a>` : '';
    return send(`<table><thead><tr>${SCREEN_HEAD.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${tr}</tbody></table>${next}`);
  }
  if (u.pathname === '/SeisanPC/DLL60') {
    res.setHeader('set-cookie', 'farm=' + u.searchParams.get('farm') + '; path=/');
    return send(`<nav id="menu"><ul class="dropdown"><li><a href="/SeisanPC/DLL60">農場状況</a></li><li><a href="/SeisanPC/DNL00"><svg width="10" height="10"></svg><span>牛一覧</span></a></li></ul></nav>
      <p>農場名：${u.searchParams.get('farm')}</p><div class="flex-row-space"><a class="arrow-link csv-output" href="DLL60/CsvOutput">表示中リストCSV出力</a></div>`);
  }
  if (u.pathname === '/SeisanPC/DNL00' && cookie(req, 'farm') === '00000005') {
    return send('<h2>在籍牛一覧</h2><p>この農家の牛一覧は表示できません</p>');
  }
  if (u.pathname === '/SeisanPC/DNL00') {
    // 絞り込みは前回の状態が残る。はじめは「未経産牛」だけ（拡張機能で見たときと同じ状態）
    const flt = decodeURIComponent(cookie(req, 'flt') || '未経産牛').split(',');
    const boxes = ALL.map((n) => `<label class="check"><input type="checkbox" name="flt" value="${n}" style="display:none" ${flt.includes(n) ? 'checked' : ''}><span class="box"></span>${n}</label>`).join('');
    // 「さらに絞り込み」にも同じ名前のチェックがある。こちらを入れると牛が減る（触ってはいけない）
    const more = ['搾乳牛', '乾乳牛'].map((n) => `<label class="check"><input type="checkbox" name="more" value="${n}" style="display:none"><span class="box"></span>${n}</label>`).join('');
    return send(`<h2>在籍牛一覧</h2><div class="filter">${boxes}</div><div class="more">${more}</div>
      <button type="button" id="show">この条件で表示</button><span id="cnt"></span>
      <div class="flex-row-space"><a class="arrow-link csv-output" href="DNL00/CsvOutput">表示中リストCSV出力</a></div>
      <script>
        const sel = () => [...document.querySelectorAll('[name=flt]:checked')].map((e) => e.value).join(',')
          + ([...document.querySelectorAll('[name=more]:checked')].length ? ',MORE' : '');
        document.getElementById('show').onclick = async () => {
          const r = await fetch('/SeisanPC/DNL00/GetList', { method: 'POST', body: sel() });
          document.getElementById('cnt').textContent = await r.text();
        };
        // CSV はリンクを開くのではなく、POST で取る
        document.querySelector('a.csv-output').onclick = (e) => {
          e.preventDefault();
          const f = document.createElement('form'); f.method = 'post'; f.action = 'DNL00/CsvOutput';
          // 農家によっては別のタブで届く（本物でどちらか分からないので両方確かめる）
          if (document.cookie.includes('farm=00000002')) f.target = '_blank';
          document.body.appendChild(f); f.submit();
        };
      </script>`);
  }
  if (u.pathname === '/SeisanPC/DNL00/GetList' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      res.writeHead(200, { 'set-cookie': 'flt=' + encodeURIComponent(b) + '; path=/', 'content-type': 'text/plain; charset=utf-8' });
      res.end('表示しました');
    });
    return;
  }
  if (u.pathname === '/SeisanPC/DNL00/CsvOutput') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const f = FARMS.find((x) => x.code === cookie(req, 'farm'));
    const flt = decodeURIComponent(cookie(req, 'flt') || '未経産牛').split(',');
    let buf = fs.readFileSync(path.join(HERE, 'fixtures', f.csv));
    if (flt.includes('MORE')) {
      buf = Buffer.from(buf.toString('latin1').split('\r\n')[0] + '\r\n', 'latin1');
    } else if (!ALL.every((n) => flt.includes(n))) {
      // 絞り込みが全部でなければ、見出しと未経産（産次が「-」）の行だけ返す
      const lines = buf.toString('latin1').split('\r\n');
      buf = Buffer.from(lines.filter((l, i) => i === 0 || l.split(',')[6] === '-').join('\r\n') + '\r\n', 'latin1');
    }
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="list.csv"` });
    return res.end(buf);
  }
  res.writeHead(404); res.end();
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;

// 本番のスクリプトを、偽のサイトと試験用の設定に向けて動かす
const cfgFile = path.join(OUT, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ '保存先フォルダ': path.join(OUT, 'save'), '農家': '全部', '取らない農家': ['00000004'], 'ブラウザ': '' }));
Object.assign(process.env, {
  TAF_PORTAL_URL: base + '/Portal/',
  TAF_RAKUCHIKU_URL: base + '/SeisanPC/',
  TAF_CONFIG: cfgFile,
  TAF_ENV: path.join(OUT, 'no.env'), // 手元の .env は読まない
  TAF_NAME_1: ACCOUNTS[0].name, TAF_USER_1: ACCOUNTS[0].user, TAF_PASS_1: ACCOUNTS[0].pass,
  TAF_NAME_2: ACCOUNTS[1].name, TAF_PASS_2: ACCOUNTS[1].pass,
  // 日本語入力のまま打った全角の円記号でも通ること
  TAF_USER_2: ACCOUNTS[1].user.replace('\\', '￥'),
});
if (fs.existsSync('/opt/pw-browsers/chromium')) process.env.TAF_BROWSER_PATH ||= '/opt/pw-browsers/chromium';

// 先週の分が残っている状態にしておく（子牛1頭が増え、1頭の分娩日が変わった想定）
const farmADir = path.join(OUT, 'save', `${FARMS[0].code}_${FARMS[0].name.replace(/\s+/g, ' ')}`);
fs.mkdirSync(farmADir, { recursive: true });
fs.copyFileSync(path.join(HERE, 'fixtures', 'farmA_prev.csv'), path.join(farmADir, '牛一覧_20000101.csv'));

const { run } = await import('../taf-download.mjs');
const failed = await run();

const save = path.join(OUT, 'save');
const r = {};
r['取れなかったものがない'] = failed.length === 0;
r['アカウントごとにサインインは1回ずつ'] = log.signIns === 2;
r['スクロールしないと出ない農家・ホームが違う農家も取れた'] = fs.existsSync(path.join(save, '00000003_試験 三郎', '牛一覧_最新.csv'));
const scr = path.join(save, '00000005_画面 だけ', '牛一覧_最新.csv');
const scrText = fs.existsSync(scr) ? fs.readFileSync(scr, 'utf8') : '';
r['CSVを出せない農家は画面から全頭読んだ'] = scrText.charCodeAt(0) === 0xfeff && scrText.trim().split('\r\n').length === 4;
r['画面の10桁が隠れていれば10桁で保存'] = scrText.includes('7777712343') && scrText.includes('7777790127');
r['取らない農家は取りに行かない'] = !fs.readdirSync(save).some((n) => n.startsWith('00000004'));
r['全農家のフォルダができた'] = FARMS.filter((f) => f.csv).every((f) => fs.existsSync(path.join(save, `${f.code}_${f.name.replace(/\s+/g, ' ')}`, '牛一覧_最新.csv')));
r['ポータルを通って入った'] = log.viaPortal === 2 && log.directHit === 0;
const rowsOf = (f) => fs.readFileSync(path.join(save, `${f.code}_${f.name.replace(/\s+/g, ' ')}`, '牛一覧_最新.csv'), 'latin1').split('\r\n').filter(Boolean).length - 1;
r['未経産だけに絞られていても全頭取れた'] = rowsOf(FARMS[0]) === 3 && rowsOf(FARMS[1]) === 1;
r['検索の画面ができた'] = fs.existsSync(path.join(save, '牛検索.html'));

// 検索の画面を開いて、4桁で引いてみる
const browser = await chromium.launch(process.env.TAF_BROWSER_PATH ? { executablePath: process.env.TAF_BROWSER_PATH } : {});
const p = await browser.newPage();
await p.goto('file://' + path.join(save, '牛検索.html'));
await p.fill('#q', '1111');
r['4桁で1頭ならすぐ牛の情報が出る'] = (await p.locator('.cow').count()) === 1;
r['名号が全角カナで出る'] = (await p.locator('.cow .name').first().innerText()) === 'テスト ウシ ニ';
r['妊鑑マイナスの印が出る'] = (await p.locator('.cow .tag', { hasText: '妊鑑マイナス' }).count()) === 1;
r['体細胞の多い牛に印が出る'] = (await p.locator('.cow .tag.bad').count()) === 1;
await p.fill('#q', '0722');
r['同じ4桁は農家の候補が2つ出る'] = (await p.locator('.cand').count()) === 2 && (await p.locator('.cow').count()) === 0;
r['候補に農家名が出る'] = (await p.locator('.cand-farm').allInnerTexts()).join('|') === '試験 一郎|試験 二郎';
await p.screenshot({ path: path.join(OUT, 'viewer-cands.png'), fullPage: true });
await p.locator('.cand').first().click();
r['候補を選ぶとその牛の情報が出る'] = (await p.locator('.cow .farm').innerText()) === '試験 一郎';
r['分娩日が更新された印が出る'] = (await p.locator('.cow .tag.new', { hasText: '分娩日が更新（前回 2024/08/01）' }).count()) === 1;
await p.screenshot({ path: path.join(OUT, 'viewer-cow.png'), fullPage: true });
await p.click('#back');
r['候補に戻れる'] = (await p.locator('.cand').count()) === 2;
await p.fill('#q', '2222');
r['新しく入った子牛に印が出る'] = (await p.locator('.cow .tag.new', { hasText: '今回新しく入った牛' }).count()) === 1;
await p.fill('#q', '1111');
r['変わっていない牛には印が出ない'] = (await p.locator('.cow .tag.new').count()) === 0;
await p.fill('#q', '07226');
r['5桁（最後の1桁つき）で絞れる'] = (await p.locator('.cow').count()) === 1;
await p.fill('#q', 'ベツノ');
r['名号の一部でも探せる'] = (await p.locator('.cow').count()) === 1;
await p.fill('#q', '1234');
r['画面から読んだ牛も4桁で引ける'] = (await p.locator('.cow .farm').innerText().catch(() => '')) === '画面 だけ';
await p.fill('#q', '5678');
r['5桁しか分からない牛も4桁で引ける'] = (await p.locator('.cow .name').innerText().catch(() => '')) === 'ガメン ニ';
await p.fill('#q', '9999');
r['ない番号は「見つかりません」'] = (await p.locator('.empty').innerText()).includes('見つかりません');
await browser.close();
server.close();

console.log(JSON.stringify(r, null, 2));
if (Object.values(r).some((x) => !x)) process.exitCode = 1;
