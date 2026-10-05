// 保存先フォルダにある全農家の「牛一覧_最新.csv」をまとめて、
// 耳標の4桁で引ける検索の画面（牛検索.html）を1枚作る。
//
// 画面は1つのファイルにデータごと入れてあるので、ダブルクリックで開くだけで動く。
// インターネットにつながっていなくても使える。
//
// 単独でも動かせる：  node build-viewer.mjs "C:\LIGvets\TAF牛一覧"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// TAF の CSV は Shift_JIS。名号は半角カナなので、読みやすいよう全角に直す（NFKC）。
function readCsv(file) {
  const text = new TextDecoder('shift_jis').decode(fs.readFileSync(file));
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(splitCsvLine(line));
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// 半角カナの名号は長音を「-」で書いてある（ﾋﾟ-ｴｽ）。カナのあとの「-」は「ー」に戻す。
function kana(s) {
  return String(s || '').normalize('NFKC').replace(/([ァ-ヶー])-/g, '$1ー').replace(/([ァ-ヶー])-/g, '$1ー').trim();
}

// 前回取ったCSV（牛一覧_日付.csv のうち、最新の1つ前）を読む。初回は無い。
function previousOf(dir) {
  const dated = fs.readdirSync(dir).filter((n) => /^牛一覧_\d{8}\.csv$/.test(n)).sort();
  if (dated.length < 2) return null;
  const name = dated[dated.length - 2];
  const rows = readCsv(path.join(dir, name));
  const h = rows[0].map((s) => s.trim());
  const byId = new Map();
  for (const r of rows.slice(1)) {
    const o = {};
    h.forEach((k, i) => { o[k] = kana(r[i]); });
    byId.set(o['耳標ID'], o);
  }
  const m = name.match(/(\d{4})(\d{2})(\d{2})/);
  return { byId, date: `${m[1]}-${m[2]}-${m[3]}` };
}

// フォルダ名「00001234_十勝 太郎」から農家の名前とコードを取り出す
function farmOf(dirName) {
  const m = dirName.match(/^(\d+)_?(.*)$/);
  return m ? { code: m[1], name: m[2].trim() } : { code: '', name: dirName };
}

export function buildViewer(outRoot) {
  const farms = [];
  const cows = [];
  let header = null;

  for (const d of fs.readdirSync(outRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(outRoot, d.name, '牛一覧_最新.csv');
    if (!fs.existsSync(f)) continue;
    const rows = readCsv(f);
    if (rows.length < 1) continue;
    const h = rows[0].map((s) => s.trim());
    if (!header || h.length > header.length) header = h;
    const prev = previousOf(path.join(outRoot, d.name));
    const farm = { ...farmOf(d.name), date: fs.statSync(f).mtime.toISOString().slice(0, 10), n: rows.length - 1, prev: prev ? prev.date : '' };
    const fi = farms.push(farm) - 1;
    for (const r of rows.slice(1)) {
      const o = { _f: fi };
      h.forEach((k, i) => { o[k] = kana(r[i]); });
      // 前回と比べる：新しく入った牛（生まれた子牛・導入牛）と、分娩日が変わった牛
      if (prev) {
        const before = prev.byId.get(o['耳標ID']);
        if (!before) o._new = 1;
        else if ((before['最新分娩日'] || '') !== (o['最新分娩日'] || '')) o._calv = before['最新分娩日'] || '';
      }
      cows.push(o);
    }
  }
  if (!farms.length) throw new Error(`${outRoot} に「牛一覧_最新.csv」が1つもありません`);

  const tpl = fs.readFileSync(path.join(HERE, 'viewer-template.html'), 'utf8');
  const data = { built: new Date().toISOString(), header, farms, cows };
  // </script> が名号などに紛れても画面が壊れないよう、< をエスケープして埋め込む
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = tpl.replace('/*__DATA__*/null', json);
  const file = path.join(outRoot, '牛検索.html');
  fs.writeFileSync(file, html, 'utf8');
  return { file, farms: farms.length, cows: cows.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let root = process.argv[2];
  if (!root) {
    const cfg = path.join(HERE, 'config.json');
    if (fs.existsSync(cfg)) root = JSON.parse(fs.readFileSync(cfg, 'utf8'))['保存先フォルダ'];
  }
  if (!root) { console.error('保存先フォルダを指定してください'); process.exit(1); }
  const r = buildViewer(root);
  console.log(`作りました: ${r.file}（${r.farms} 戸・${r.cows} 頭）`);
}
