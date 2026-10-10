// TAF（十勝酪農畜産物生産履歴システム）から、農家ごとの「在籍牛一覧」CSVを取ってくる。
//
// 人が毎朝やっている手順をそのままなぞる：
//   サインイン → 酪畜履歴 → 農家を選ぶ → 牛一覧 → 表示中リストCSV出力
//
// 使い方は README.md を見ること。ID とパスワードは .env、農家と保存先は config.json に書く。
// うまくいかなかったときは logs/ に画面の写真と中身を残す（直すときの手がかりになる）。

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildViewer } from './build-viewer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 本番の入口。試験のときだけ環境変数で偽のサイトに向け替える。
const PORTAL = process.env.TAF_PORTAL_URL || 'https://www.jatokachi.jp/Portal/';
const RAKUCHIKU = process.env.TAF_RAKUCHIKU_URL || 'https://rakuchiku.jatokachi.jp/SeisanPC/';

// 版。差し替えたつもりで古いファイルが残っていても、黒い画面の最初の行で見分けられるようにする
const VERSION = '2026-10-10 版9（農家一覧の読み込みを粘る・取りこぼしを知らせる）';

const WAIT = 30_000; // サイトが重い朝もあるので、1つの操作に30秒までは待つ

// ---------- 設定を読む ----------

// .env から TAF のアカウントを読む。JA ごとに ID が違うので、いくつでも並べられる。
//   TAF_NAME_1=清水町   TAF_USER_1=farmers\…   TAF_PASS_1=…
//   TAF_NAME_2=新得町   TAF_USER_2=farmers\…   TAF_PASS_2=…
// 番号なしの TAF_USER / TAF_PASS も1つ目として使える（前の書き方）。
function readAccounts() {
  const f = process.env.TAF_ENV || path.join(HERE, '.env');
  const env = {};
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  Object.keys(process.env).filter((k) => /^TAF_(USER|PASS|NAME)(_\d+)?$/.test(k)).forEach((k) => { env[k] = process.env[k]; });

  const accounts = [];
  if (env.TAF_USER || env.TAF_PASS) accounts.push({ name: env.TAF_NAME || '', user: env.TAF_USER, pass: env.TAF_PASS });
  const nums = [...new Set(Object.keys(env).map((k) => (k.match(/^TAF_(?:USER|PASS|NAME)_(\d+)$/) || [])[1]).filter(Boolean))]
    .sort((x, y) => x - y);
  for (const n of nums) accounts.push({ name: env[`TAF_NAME_${n}`] || `アカウント${n}`, user: env[`TAF_USER_${n}`], pass: env[`TAF_PASS_${n}`] });

  // メモ帳で日本語入力のまま打つと「farmers￥…」のように全角や円記号になることがある。
  // TAF には半角の「\」で送らないと通らないので、ID は半角にそろえて円記号を「\」に直す。
  // パスワードは記号も意味を持つので、前後の空白を除くだけにする。
  for (const a of accounts) {
    if (a.user) a.user = a.user.normalize('NFKC').replace(/[\u00A5\uFFE5]/g, '\\').trim();
    if (a.pass) a.pass = a.pass.trim();
  }
  const usable = accounts.filter((a) => a.user || a.pass);
  if (!usable.length) throw new Error('.env に TAF の ID とパスワード（TAF_USER_1 と TAF_PASS_1）を書いてください。');
  for (const a of usable) {
    if (!a.user || !a.pass || /ここに/.test(a.user + a.pass)) {
      throw new Error(`.env の「${a.name || 'アカウント'}」の ID かパスワードが書けていません。`);
    }
  }
  return usable;
}

function readConfig() {
  const f = process.env.TAF_CONFIG || path.join(HERE, 'config.json');
  if (!fs.existsSync(f)) throw new Error('config.json がありません。config.example.json をコピーして作ってください。');
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!c['保存先フォルダ']) throw new Error('config.json に「保存先フォルダ」がありません。');
  // 「農家」を書かなければ（または "全部" なら）、一覧に出る農家をぜんぶ取る
  if (c['農家'] === undefined || c['農家'] === '全部') c['農家'] = '全部';
  else if (!Array.isArray(c['農家']) || !c['農家'].length) throw new Error('config.json の「農家」が空です。');
  return c;
}

// ---------- 小道具 ----------

function today() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function stamp() {
  return new Date().toLocaleString('ja-JP', { hour12: false });
}

// Windows のフォルダ名に使えない文字を除く
function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

let logFile = null;
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, line + '\r\n');
}

// うまくいかなかったときに、その時の画面を残す
async function keepEvidence(page, label) {
  try {
    const dir = path.join(HERE, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${today()}_${safeName(label)}`);
    await page.screenshot({ path: base + '.png', fullPage: true });
    fs.writeFileSync(base + '.html', await page.content());
    log(`  画面を残しました: ${base}.png`);
  } catch { /* 画面が閉じていたら残せないが、本題ではないので先へ進む */ }
}

// 書いてある文字で押す場所を探す。サイトの作りが少し変わっても、文字が同じなら押せる。
async function clickByText(page, texts, { timeout = WAIT } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const t of texts) {
      const cands = [
        page.getByRole('link', { name: t, exact: false }),
        page.getByRole('button', { name: t, exact: false }),
        page.locator(`input[type=button][value*="${t}"], input[type=submit][value*="${t}"]`),
        page.getByText(t, { exact: false }),
      ];
      for (const c of cands) {
        const el = c.first();
        if (await el.isVisible().catch(() => false)) {
          await el.click();
          return t;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`「${texts.join('」「')}」が画面に見つかりません`);
}

// ---------- サインイン ----------

async function isLoginForm(page) {
  return page.locator('input[type=password]').first().isVisible().catch(() => false);
}

async function signIn(page, cred) {
  // ADFS のサインイン画面。名前の欄・パスワードの欄・ボタンは ADFS 標準の id だが、
  // 変わっていても「パスワード欄の1つ前の入力欄」で拾えるようにしておく。
  const pass = page.locator('#passwordInput, input[type=password]').first();
  await pass.waitFor({ timeout: WAIT });
  let user = page.locator('#userNameInput');
  if (!(await user.count())) user = page.locator('input[type=text], input[type=email], input:not([type])').first();
  await user.fill(cred.user);
  await pass.fill(cred.pass);
  const btn = page.locator('#submitButton, span#submitButton, [type=submit]').first();
  if (await btn.count()) await btn.click();
  else await clickByText(page, ['サインイン', 'ログイン']);
  await page.waitForLoadState('domcontentloaded');
  // まだパスワード欄が残っていたら、ID かパスワードが違う
  await page.waitForTimeout(1500);
  if (await isLoginForm(page)) {
    const msg = await page.locator('#errorText, .error, [role=alert]').first().innerText().catch(() => '');
    throw new Error('サインインできませんでした。ID とパスワードを確かめてください。' + (msg ? `（画面の表示: ${msg.trim()}）` : ''));
  }
}

// 酪畜履歴の「農家を選ぶ画面」までたどり着く
// 酪畜履歴はポータルの「酪畜履歴」（Redirector.aspx）から新しいタブで開く作り。
// ポータルを通るとサインインが引き継がれるので、直接 DZL99 は開かずに必ずポータルから入る。
async function openRakuchiku(context, page, cred) {
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });
  if (await isLoginForm(page)) {
    log('サインインします');
    await signIn(page, cred);
    if (!page.url().startsWith(PORTAL)) await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });
  }
  const link = page.locator('a[href*="Redirector.aspx"][href*="rakuchiku"]').first();
  const popup = context.waitForEvent('page', { timeout: WAIT }).catch(() => null);
  if (await link.count()) await link.click();
  else await clickByText(page, ['酪畜履歴', '畜産履歴']);
  const p2 = (await popup) || page;
  await p2.waitForURL(/DZL99|DLL60|SeisanPC/i, { timeout: WAIT }).catch(() => {});
  if (await isLoginForm(p2)) await signIn(p2, cred);
  await p2.waitForLoadState('domcontentloaded');
  if (!p2.url().startsWith(RAKUCHIKU)) throw new Error(`酪畜履歴が開けませんでした（開いた画面: ${p2.url()}）`);
  return p2;
}

// 「ユーザー切替」と同じ。農家を選ぶ画面（DZL99）に戻る。
async function backToFarmSelect(page) {
  if (/DZL99/i.test(page.url())) return;
  await page.goto(RAKUCHIKU + 'DZL99', { waitUntil: 'domcontentloaded' });
}

// ---------- 農家を選ぶ ----------

// 農家を選ぶ画面に出ている農家を、ぜんぶ読み取る。
// 丸（input name=radioSelect）の value が生産者コードになっている。
// 農家の一覧は、下までスクロールすると続きが読み込まれる作り（はじめは15戸ほどしか出ない）。
// 上に出ている「○○ 件」の数になるか、増えなくなるまで下へ送り続ける。
async function loadAllFarmRows(page, { quiet = false } = {}) {
  const radios = page.locator('input[name=radioSelect]');
  await radios.first().waitFor({ state: 'attached', timeout: WAIT });
  const want = await page.getByText(/^\s*\d+\s*件\s*$/).first().innerText({ timeout: 3000 })
    .then((t) => +t.match(/(\d+)/)[1]).catch(() => 0);
  let last = -1, still = 0;
  for (let i = 0; i < 80; i++) {
    const n = await radios.count();
    if (want && n >= want) break;
    // サイトが重い日は続きが出るまで時間がかかる。件数に届いていないうちは長めに粘る（約20秒）
    if (n === last) { if (++still >= (want ? 8 : 4)) break; } else still = 0;
    last = n;
    // 最後の行を画面に出し、一覧の枠と画面の両方をいちばん下まで送る
    await radios.last().evaluate((el) => {
      const row = el.closest('tr') || el;
      row.scrollIntoView({ block: 'end' });
      for (let p = row.parentElement; p; p = p.parentElement) {
        if (p.scrollHeight > p.clientHeight + 5) p.scrollTop = p.scrollHeight;
      }
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await page.mouse.wheel(0, 2000).catch(() => {});
    // 「マウスを置いて数秒すると続きが出る」ので、最後の行の上にマウスを置いて待つ
    const box = await radios.last().locator('xpath=ancestor::tr[1]').boundingBox().catch(() => null);
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  const n = await radios.count();
  if (!quiet && want && n < want) log(`  ⚠ 農家の一覧は ${want} 件のはずが、${n} 件しか読み込めませんでした`);
  return { n, want };
}

// 一覧に出ている農家を読み取る（名前と生産者コード）
async function readFarmRows(page) {
  return page.locator('input[name=radioSelect]').evaluateAll((els) => els.map((el) => {
    const code = (el.value || '').trim();
    const tr = el.closest('tr');
    const cells = tr ? [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()) : [];
    const name = cells.find((t) => t && t !== code && !/^\d{8}$/.test(t)) || '';
    return { '生産者コード': code, '名前': name.replace(/\s+/g, ' ') };
  }).filter((f) => /^\d+$/.test(f['生産者コード'])));
}

// 農家を選ぶ画面の農家をぜんぶ集める。読み込みが途中で止まる日があるので、
// 足りなければ画面を開き直して最大3回読み、見つかった農家を足し合わせる。
async function listFarms(page) {
  const all = new Map();
  let want = 0;
  for (let round = 1; round <= 3; round++) {
    if (round > 1) await page.goto(RAKUCHIKU + 'DZL99', { waitUntil: 'domcontentloaded' });
    else await backToFarmSelect(page);
    const r = await loadAllFarmRows(page, { quiet: true });
    want = Math.max(want, r.want);
    for (const f of await readFarmRows(page)) all.set(f['生産者コード'], f);
    if (!want || all.size >= want) break;
    log(`  農家の一覧が ${all.size}/${want} 件しか出ないので、読み直します（${round}回目）`);
  }
  if (!all.size) throw new Error('農家を選ぶ画面に農家が1戸も見つかりません');
  const farms = [...all.values()];
  farms.short = want && farms.length < want ? `${farms.length}/${want}` : '';
  log(`農家の一覧：${farms.length} 件${want ? `（画面の件数 ${want}）` : ''}`);
  return farms;
}

async function chooseFarm(page, farm) {
  const code = farm['生産者コード'];
  await backToFarmSelect(page);
  let radio = page.locator(`input[name=radioSelect][value="${code}"]`);
  // 下の方の農家は、スクロールして読み込まないと一覧に出てこない
  if (!(await radio.count())) await loadAllFarmRows(page, { quiet: true });
  if (!(await radio.count())) {
    // 一覧に見当たらないときは、生産者コードで絞って探し直す
    await page.locator('input[name=SEISANCODE]').fill(code);
    await page.locator('a.jsSearchUser').click();
    await radio.first().waitFor({ state: 'attached', timeout: WAIT }).catch(() => {
      throw new Error(`生産者コード ${code} の農家が一覧にありません（${farm['名前'] || ''}）`);
    });
  }
  // 丸は見た目用の span に隠れていることがあるので、要素に直接クリックを送る
  await radio.first().evaluate((el) => { if (!el.checked) el.click(); });
  await page.locator('#BTNCHANGE').click();
  // 農家によって最初に出る画面（ホーム）が違う。どこでもよいので、選ぶ画面から移ったら次へ
  await page.waitForURL((u) => !/DZL99/i.test(u.toString()), { timeout: WAIT });
  await page.waitForLoadState('domcontentloaded');
}

// ---------- 牛一覧を取る ----------

// 牛一覧の絞り込みは前回の状態が残る（「未経産牛」だけになっていたこともある）。
// 全頭を取りたいので、絞り込みのチェックをぜんぶ入れてから一覧を読み直す。
const ALL_FILTERS = ['経産牛', '未経産牛', '搾乳牛', '乾乳牛', '素牛', '肥育牛', '初生', '預かっている牛', '預けている牛'];

async function checkAllFilters(page) {
  const { found, turnedOn } = await page.locator('input[type=checkbox]').evaluateAll((els, names) => {
    const labelOf = (el) => {
      const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = (byFor || el.closest('label') || el.parentElement || {}).innerText || '';
      return t.trim();
    };
    const on = [];
    let n = 0;
    const seen = new Set();
    for (const el of els) {
      const t = labelOf(el);
      // 同じ名前のチェックが「さらに絞り込み」にもある。上の「絞り込み」の分（最初に出てくる方）だけ触る
      if (!names.includes(t) || seen.has(t)) continue;
      seen.add(t);
      n++;
      if (!el.checked) { el.click(); on.push(t); }
    }
    return { found: n, turnedOn: on };
  }, ALL_FILTERS);
  if (found < ALL_FILTERS.length) {
    // 見つからないと一部の牛しか出ないおそれがある。止めはしないが、記録に残して気づけるようにする。
    log(`  ⚠ 絞り込みのチェックが ${found}/${ALL_FILTERS.length} 個しか見つかりません。全頭が出ていないかもしれません`);
  }
  if (turnedOn.length) {
    log(`  絞り込みを全部に戻します（${turnedOn.join('・')} を入れた）`);
    const reloaded = page.waitForResponse((r) => /GetList/i.test(r.url()), { timeout: WAIT }).catch(() => null);
    await clickByText(page, ['この条件で表示']);
    await reloaded;
    await page.waitForTimeout(500);
  }
}

// 「表示中リストCSV出力」を押して、届いたCSVを file に保存する。
// CSV は押すと裏で POST（DNL00/CsvOutput）が飛んで届く作り。届き方が
//  ・その画面のダウンロード ・別のタブでのダウンロード ・POST の返事そのもの
// のどれでも受け取れるよう、3つを同時に待って最初に来たものを使う。
async function fetchCsv(page, file) {
  const context = page.context();
  let done = false;
  let cleanup = () => {};
  const viaDownload = new Promise((resolve) => {
    const onDl = (d) => { if (!done) resolve({ kind: 'download', d }); };
    const watch = (p) => p.on('download', onDl);
    context.pages().forEach(watch);
    context.on('page', watch);
    cleanup = () => { context.off('page', watch); context.pages().forEach((p) => p.off('download', onDl)); };
  });
  const viaResponse = page.waitForResponse((r) => /CsvOutput/i.test(r.url()) && r.request().method() === 'POST', { timeout: WAIT * 2 })
    .then(async (r) => ({ kind: 'response', r, body: await r.body().catch(() => null) }))
    .catch(() => null);

  // 押す場所がずれて牛の行を押さないよう、座標で押さずに要素へ直接クリックを送る。
  // 見えている a.csv-output（なければ文字で探す）を使う。
  const links = page.locator('a.csv-output');
  let clicked = false;
  for (let i = 0; i < (await links.count()); i++) {
    const a = links.nth(i);
    if (await a.isVisible().catch(() => false)) { await a.evaluate((el) => el.click()); clicked = true; break; }
  }
  if (!clicked && (await links.count())) { await links.first().evaluate((el) => el.click()); clicked = true; }
  if (!clicked) await clickByText(page, ['表示中リストCSV出力']);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), WAIT * 2));
  // POST の返事が先に来ても、ダウンロードとして届くならそちらを優先したいので少しだけ待つ
  let got = await Promise.race([viaDownload, viaResponse.then((x) => x && new Promise((r) => setTimeout(() => r(x), 3000))), timeout]);
  done = true;
  cleanup();
  if (!got) throw new Error('「表示中リストCSV出力」を押しても CSV が届きませんでした');

  if (got.kind === 'download') {
    await got.d.saveAs(file);
    return;
  }
  // POST の返事を直接保存する。中身が牛一覧（見出しに「耳標ID」）か確かめる
  const body = got.body;
  const text = body ? new TextDecoder('shift_jis').decode(body.subarray(0, 400)) : '';
  if (!body || !text.includes('耳標ID')) {
    throw new Error(`CSV の返事が牛一覧ではありませんでした（${got.r.status()} ${got.r.headers()['content-type'] || ''}）`);
  }
  fs.writeFileSync(file, body);
}

async function downloadCowList(page, farm, outRoot) {
  // 上のメニューの「牛一覧」（/SeisanPC/DNL00）
  // ホームの画面が農家ごとに違ってメニューの場所も違うので、牛一覧の画面を直接開く
  await page.goto(RAKUCHIKU + 'DNL00', { waitUntil: 'domcontentloaded' });
  if (!/DNL00/i.test(page.url())) {
    const menu = page.locator('a[href$="/SeisanPC/DNL00"], a[href="DNL00"]').first();
    if (await menu.count()) await menu.click();
    else await clickByText(page, ['牛一覧']);
    await page.waitForURL(/DNL00/i, { timeout: WAIT });
  }
  await page.waitForLoadState('networkidle').catch(() => {});

  const dir = path.join(outRoot, safeName(`${farm['生産者コード']}_${farm['名前'] || ''}`));
  fs.mkdirSync(dir, { recursive: true });
  const dated = path.join(dir, `牛一覧_${today()}.csv`);

  if (await page.locator('a.csv-output').count()) {
    await checkAllFilters(page);
    await fetchCsv(page, dated);
  } else {
    // 牛一覧からCSVを出せない農家（権限が限られている農家など）は、
    // 農場状況の「経産牛」「未経産牛」の数字から開く一覧を、画面から読み取って保存する
    log('  牛一覧からCSVを出せないので、農場状況の一覧を画面から読み取ります');
    await scrapeFromFarmStatus(page, farm, dated);
  }

  const size = fs.statSync(dated).size;
  if (size < 50) throw new Error(`取れたCSVが空に近い（${size} バイト）。画面の作りが変わったかもしれません。`);
  // 他のアプリやエクセルからは、いつも同じ名前で最新を開けるようにしておく
  fs.copyFileSync(dated, path.join(dir, '牛一覧_最新.csv'));

  const rows = fs.readFileSync(dated).toString('latin1').split(/\r?\n/).filter((l) => l.trim()).length - 1;
  log(`  保存しました: ${dated}（${rows} 頭）`);
  return dated;
}

// ---------- 画面から読み取る（CSVを出せない農家） ----------

// 農場状況の画面を開く。DLL60 で「経産牛」が見えなければ、上のメニューの「農場状況」を押す
async function openFarmStatus(page) {
  await page.goto(RAKUCHIKU + 'DLL60', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  if (await page.getByText('経産牛', { exact: true }).count()) return;
  await clickByText(page, ['農場状況']);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByText('経産牛', { exact: true }).first().waitFor({ timeout: WAIT });
}

// 「経産牛」の文字の近くにある数字（押すと一覧が開く）に印を付けて、その数を返す
async function markCountLink(page, label) {
  return page.evaluate((label) => {
    document.querySelectorAll('[data-taf-pick]').forEach((e) => e.removeAttribute('data-taf-pick'));
    const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    const labels = [...document.querySelectorAll('body *')].filter((el) => own(el) === label || (el.children.length === 0 && el.textContent.trim() === label));
    for (const lb of labels) {
      // ラベルから外側へ3段まで広げて、その中にある「数字だけ」の要素を探す
      let box = lb;
      for (let up = 0; up < 4 && box; up++, box = box.parentElement) {
        const nums = [...box.querySelectorAll('a, button, [onclick], span, div, td, p')]
          .filter((e) => /^\d+$/.test(e.textContent.trim()) && !e.querySelector('a, button'));
        if (nums.length) {
          // 押せそうなもの（リンク・ボタン・onclick付き）を優先
          const pick = nums.find((e) => e.closest('a, button, [onclick]')) || nums[0];
          const target = pick.closest('a, button, [onclick]') || pick;
          target.setAttribute('data-taf-pick', '1');
          return +pick.textContent.trim();
        }
      }
    }
    return null;
  }, label);
}

// いま開いている一覧の表を読み取る。下までスクロールして続きを読み込み、「次へ」があればたどる
async function readListTable(page) {
  const out = { header: null, rows: [] };
  for (let pageNo = 0; pageNo < 50; pageNo++) {
    // 続きの読み込み（行が増えなくなるまで下へ送る）
    let last = -1;
    for (let i = 0; i < 30; i++) {
      const n = await page.locator('tbody tr, table tr').count();
      if (n === last) break;
      last = n;
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        document.querySelectorAll('*').forEach((el) => { if (el.scrollHeight > el.clientHeight + 5 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = el.scrollHeight; });
      });
      await page.waitForTimeout(800);
    }
    const t = await page.evaluate(() => {
      // 見出しに「耳標」が入っている表のうち、いちばん行の多いものを使う
      const tables = [...document.querySelectorAll('table')].map((tb) => {
        const head = [...(tb.querySelector('thead tr') || tb.querySelector('tr') || { children: [] }).children].map((c) => c.innerText.trim());
        const body = [...tb.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('td'));
        return { tb, head, body };
      }).filter((x) => x.head.some((h) => /耳標|個体識別/.test(h)));
      if (!tables.length) return null;
      tables.sort((a, b) => b.body.length - a.body.length);
      const { head, body } = tables[0];
      const idCol = head.findIndex((h) => /耳標|個体識別/.test(h));
      const rows = body.map((tr) => {
        const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.replace(/\s+/g, ' ').trim());
        // 画面の耳標は「0722 6」のように一部しか出ないことがある。行の中に10桁の番号が隠れていればそれを使う
        const shown = (cells[idCol] || '').replace(/\D/g, '');
        const hidden = (tr.outerHTML.match(/\b\d{10}\b/g) || []).find((d) => shown && d.endsWith(shown));
        if (hidden) cells[idCol] = hidden;
        else cells[idCol] = shown;
        return cells;
      });
      return { head, rows };
    });
    if (!t) break;
    out.header = out.header || t.head;
    out.rows.push(...t.rows);
    const next = page.locator('a, button').filter({ hasText: /^(次へ|次のページ|＞|>)$/ }).first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  return out;
}

// CSV と同じ並び（見出し＋行）で書き出す。画面から読んだ分は UTF-8（印付き）で保存する。
function writeCsv(file, header, rows) {
  const cell = (v) => (/[",\r\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  fs.writeFileSync(file, '﻿' + text, 'utf8');
}

async function scrapeFromFarmStatus(page, farm, file) {
  let header = null;
  const byId = new Map();
  const counts = [];
  for (const label of ['経産牛', '未経産牛']) {
    await openFarmStatus(page);
    const n = await markCountLink(page, label);
    if (n === null) { log(`  ⚠ 農場状況に「${label}」の数字が見つかりません`); continue; }
    if (n === 0) { counts.push(`${label} 0`); continue; }
    const popup = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await page.locator('[data-taf-pick]').first().click();
    const p = (await popup) || page;
    await p.waitForLoadState('networkidle').catch(() => {});
    await p.waitForTimeout(1000);
    const t = await readListTable(p);
    if (p !== page) await p.close();
    if (!t.header) { await keepEvidence(page, `${farm['生産者コード']}_${label}の一覧`); throw new Error(`「${label}」の一覧の表が読めませんでした`); }
    header = header || t.header;
    const idCol = header.findIndex((h) => /耳標|個体識別/.test(h));
    for (const r of t.rows) byId.set(r[idCol] || JSON.stringify(r), r);
    counts.push(`${label} ${t.rows.length}/${n}`);
    if (t.rows.length !== n) log(`  ⚠ ${label}は ${n} 頭のはずが ${t.rows.length} 頭しか読めませんでした`);
  }
  if (!header || !byId.size) throw new Error('農場状況から牛の一覧を読み取れませんでした');
  // 見出しは他の農家のCSVと同じ名前にそろえる（牛検索で同じ欄に出るように）
  const fixed = header.map((h) => (/耳標|個体識別/.test(h) ? '耳標ID' : h.replace(/\s+/g, '')));
  writeCsv(file, fixed, [...byId.values()]);
  log(`  画面から読み取りました（${counts.join('・')}）`);
}

// ---------- 全体の流れ ----------

export async function run() {
  const cfg = readConfig();
  const accounts = readAccounts();

  const outRoot = cfg['保存先フォルダ'];
  fs.mkdirSync(outRoot, { recursive: true });
  fs.mkdirSync(path.join(HERE, 'logs'), { recursive: true });
  logFile = path.join(HERE, 'logs', `${today()}.log`);

  const opts = { headless: !cfg['画面を出す'] };
  if (process.env.TAF_BROWSER_PATH) opts.executablePath = process.env.TAF_BROWSER_PATH;
  else if (cfg['ブラウザ']) opts.channel = cfg['ブラウザ']; // Windows に入っている Edge をそのまま使う
  log(`TAF 牛一覧の取得 ${VERSION}`);
  const browser = await chromium.launch(opts);

  const failed = [];
  try {
    for (const acc of accounts) {
      // アカウントごとにまっさらな窓で入る（前のアカウントのサインインが残らないように）
      const title = acc.name || acc.user;
      log(`=== ${title} ===`);
      // どのIDで入ろうとしたかを残す（パスワードは文字数だけ。中身は書かない）
      log(`ID: ${acc.user}（パスワード ${acc.pass.length} 文字）`);
      const context = await browser.newContext({ acceptDownloads: true, locale: 'ja-JP' });
      let page = await context.newPage();
      try {
        page = await openRakuchiku(context, page, acc);
        const listed = await listFarms(page);
        // 「全部」ならこのアカウントで見える農家ぜんぶ。並べてあるときは、このアカウントで見えるものだけ
        const skip = new Set((cfg['取らない農家'] || []).map((c) => String(c).trim()));
        const farms = (cfg['農家'] === '全部'
          ? listed
          : cfg['農家'].filter((f) => listed.some((x) => x['生産者コード'] === f['生産者コード'])))
          .filter((f) => !skip.has(f['生産者コード']));
        const skipped = listed.filter((f) => skip.has(f['生産者コード']));
        if (skipped.length) log(`取らない農家: ${skipped.map((f) => `${f['生産者コード']} ${f['名前']}`).join('、')}`);
        // 一覧を全部読めなかったら、最後に「取りこぼし」として知らせる（ぜんぶ取れた、とは言わない）
        if (listed.short) {
          log(`  ⚠ 農家の一覧を全部読めませんでした（${listed.short}）。読めた分だけ取ります`);
          failed.push(`${title} の農家一覧（${listed.short} 件しか読めず）`);
        }
        log(`はじめます（${farms.length} 戸）`);
        for (const farm of farms) {
          const label = `${farm['生産者コード']} ${farm['名前'] || ''}`.trim();
          log(`${label}`);
          try {
            await chooseFarm(page, farm);
            await downloadCowList(page, farm, outRoot);
          } catch (e) {
            // 1戸でつまずいても、残りの農家は取りに行く
            log(`  ✗ ${e.message}`);
            await keepEvidence(page, label);
            failed.push(label);
          }
        }
      } catch (e) {
        // このアカウントで入れなくても、次のアカウントは試す
        log(`✗ ${title}: ${e.message}`);
        await keepEvidence(page, `サインイン_${title}`);
        failed.push(`${title} のサインイン`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  // 取れた分だけでも、検索の画面は作り直す（取れなかった農家は前回の分が残る）
  try {
    const r = buildViewer(outRoot);
    log(`検索の画面を作りました: ${r.file}（${r.farms} 戸・${r.cows} 頭）`);
  } catch (e) {
    log(`✗ 検索の画面を作れませんでした: ${e.message}`);
    failed.push('検索の画面');
  }

  if (failed.length) {
    log(`おわり：取れなかったもの ${failed.length} 件（${failed.join('、')}）`);
    process.exitCode = 1;
  } else {
    log('おわり：ぜんぶ取れました');
  }
  return failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { log(`✗ ${e.message}`); process.exitCode = 1; });
}
