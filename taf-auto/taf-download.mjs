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

function readEnv() {
  const f = path.join(HERE, '.env');
  const env = {};
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return {
    user: process.env.TAF_USER || env.TAF_USER,
    pass: process.env.TAF_PASS || env.TAF_PASS,
  };
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
async function openRakuchiku(context, page, cred) {
  // まず酪畜履歴へ直接行く。サインインがまだならサインイン画面に飛ばされるので、そこで入れる。
  await page.goto(RAKUCHIKU + 'DZL99', { waitUntil: 'domcontentloaded' });
  if (await isLoginForm(page)) {
    log('サインインします');
    await signIn(page, cred);
  }
  if (page.url().startsWith(RAKUCHIKU)) return page;

  // 直接行けなかったときは、ポータルの「酪畜履歴」から入る（別の窓で開くこともある）
  log('ポータルから酪畜履歴に入ります');
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });
  if (await isLoginForm(page)) await signIn(page, cred);
  const popup = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await clickByText(page, ['酪畜履歴', '畜産履歴']);
  const p2 = (await popup) || page;
  await p2.waitForLoadState('domcontentloaded');
  if (await isLoginForm(p2)) await signIn(p2, cred);
  return p2;
}

// ---------- 農家を選ぶ ----------

// 農家を選ぶ画面に出ている農家を、ぜんぶ読み取る（名前と生産者コード）
async function listFarms(page) {
  if (!/DZL99/i.test(page.url())) await page.goto(RAKUCHIKU + 'DZL99', { waitUntil: 'domcontentloaded' });
  await page.locator('tr', { hasText: /\d{8}/ }).first().waitFor({ timeout: WAIT });
  const farms = await page.locator('tr').evaluateAll((trs) => trs.map((tr) => {
    const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
    const code = cells.find((t) => /^\d{8}$/.test(t));
    if (!code) return null;
    const name = cells.find((t) => t && t !== code) || '';
    return { '生産者コード': code, '名前': name.replace(/\s+/g, ' ') };
  }).filter(Boolean));
  if (!farms.length) throw new Error('農家を選ぶ画面に農家が1戸も見つかりません');
  return farms;
}

async function chooseFarm(page, farm) {
  const code = farm['生産者コード'];
  if (!/DZL99/i.test(page.url())) {
    // 別の農家を見ていたら、「ユーザー切替」で選ぶ画面に戻る
    await page.goto(RAKUCHIKU + 'DZL99', { waitUntil: 'domcontentloaded' });
  }
  // 生産者コードで絞ってから、その行の丸を押す
  const codeBox = page.locator('xpath=//*[contains(normalize-space(.),"生産者コード")]/following::input[@type="text" or not(@type)][1]').first();
  if (await codeBox.isVisible().catch(() => false)) {
    await codeBox.fill(code);
    await clickByText(page, ['この条件で表示']);
    await page.waitForLoadState('domcontentloaded');
  }
  const row = page.locator('tr', { hasText: code }).first();
  await row.waitFor({ timeout: WAIT }).catch(() => {
    throw new Error(`生産者コード ${code} の農家が一覧にありません（${farm['名前'] || ''}）`);
  });
  const radio = row.locator('input[type=radio], label, td').first();
  await radio.click();

  // 丸を押しただけで農場の画面に移る作りと、決定ボタンを押す作りの両方に備える
  const moved = await page.waitForURL(/DLL60/i, { timeout: 5000 }).then(() => true).catch(() => false);
  if (!moved) {
    await clickByText(page, ['決定', '選択', 'OK', '次へ', '表示']);
    await page.waitForURL(/DLL60/i, { timeout: WAIT });
  }
  await page.waitForLoadState('domcontentloaded');
}

// ---------- 牛一覧を取る ----------

async function downloadCowList(page, farm, outRoot) {
  await clickByText(page, ['牛一覧']);
  await page.waitForLoadState('domcontentloaded');
  await page.getByText('在籍牛一覧').first().waitFor({ timeout: WAIT }).catch(() => {});

  const dl = page.waitForEvent('download', { timeout: WAIT * 2 });
  await clickByText(page, ['表示中リストCSV出力', 'CSV出力']);
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
  const cred = readEnv();
  if (!cred.user || !cred.pass) throw new Error('.env に TAF_USER と TAF_PASS を書いてください。');

  const outRoot = cfg['保存先フォルダ'];
  fs.mkdirSync(path.join(HERE, 'logs'), { recursive: true });
  logFile = path.join(HERE, 'logs', `${today()}.log`);

  const opts = { headless: !cfg['画面を出す'] };
  if (process.env.TAF_BROWSER_PATH) opts.executablePath = process.env.TAF_BROWSER_PATH;
  else if (cfg['ブラウザ']) opts.channel = cfg['ブラウザ']; // Windows に入っている Edge をそのまま使う
  const browser = await chromium.launch(opts);
  const context = await browser.newContext({ acceptDownloads: true, locale: 'ja-JP' });
  let page = await context.newPage();

  const failed = [];
  try {
    page = await openRakuchiku(context, page, cred);
    const farms = cfg['農家'] === '全部' ? await listFarms(page) : cfg['農家'];
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
    log(`✗ ${e.message}`);
    await keepEvidence(page, 'サインイン');
    failed.push('サインイン');
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
