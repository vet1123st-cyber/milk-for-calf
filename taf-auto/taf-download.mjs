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
async function listFarms(page) {
  await backToFarmSelect(page);
  await page.locator('input[name=radioSelect]').first().waitFor({ state: 'attached', timeout: WAIT });
  const farms = await page.locator('input[name=radioSelect]').evaluateAll((els) => els.map((el) => {
    const code = (el.value || '').trim();
    const tr = el.closest('tr');
    const cells = tr ? [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()) : [];
    const name = cells.find((t) => t && t !== code && !/^\d{8}$/.test(t)) || '';
    return { '生産者コード': code, '名前': name.replace(/\s+/g, ' ') };
  }).filter((f) => /^\d+$/.test(f['生産者コード'])));
  if (!farms.length) throw new Error('農家を選ぶ画面に農家が1戸も見つかりません');
  return farms;
}

async function chooseFarm(page, farm) {
  const code = farm['生産者コード'];
  await backToFarmSelect(page);
  let radio = page.locator(`input[name=radioSelect][value="${code}"]`);
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
  await page.waitForURL(/DLL60/i, { timeout: WAIT });
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
    for (const el of els) {
      const t = labelOf(el);
      if (!names.includes(t)) continue;
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

async function downloadCowList(page, farm, outRoot) {
  // 上のメニューの「牛一覧」（/SeisanPC/DNL00）
  const menu = page.locator('a[href$="/SeisanPC/DNL00"], a[href="DNL00"]').first();
  if (await menu.count()) await menu.click();
  else await clickByText(page, ['牛一覧']);
  await page.waitForURL(/DNL00/i, { timeout: WAIT });
  await page.waitForLoadState('networkidle').catch(() => {});

  await checkAllFilters(page);

  // CSV はリンクを開くのではなく、押すと裏で POST が飛んでファイルが届く作り。
  // 押す場所がずれて牛の行を押さないよう、座標ではなく a.csv-output を直接押す。
  const dl = page.waitForEvent('download', { timeout: WAIT * 2 });
  const btn = page.locator('a.csv-output').first();
  if (await btn.count()) await btn.click();
  else await clickByText(page, ['表示中リストCSV出力']);
  const file = await dl;

  const dir = path.join(outRoot, safeName(`${farm['生産者コード']}_${farm['名前'] || ''}`));
  fs.mkdirSync(dir, { recursive: true });
  const dated = path.join(dir, `牛一覧_${today()}.csv`);
  await file.saveAs(dated);

  const size = fs.statSync(dated).size;
  if (size < 50) throw new Error(`取れたCSVが空に近い（${size} バイト）。画面の作りが変わったかもしれません。`);
  // 他のアプリやエクセルからは、いつも同じ名前で最新を開けるようにしておく
  fs.copyFileSync(dated, path.join(dir, '牛一覧_最新.csv'));

  const rows = fs.readFileSync(dated).toString('latin1').split(/\r?\n/).filter(Boolean).length - 1;
  log(`  保存しました: ${dated}（${rows} 頭）`);
  return dated;
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
        const farms = cfg['農家'] === '全部'
          ? listed
          : cfg['農家'].filter((f) => listed.some((x) => x['生産者コード'] === f['生産者コード']));
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
