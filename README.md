# dosbox_wasm — JW_CAD DOS/V in the browser

[DOSBox-X](https://github.com/joncampbell123/dosbox-x) built to WebAssembly with its
DOS/V (Japanese) emulation turned on, running **JW_CAD for DOS/V 2.22H**. 日本語も
打てますし、描いた図面を **PNG / SVG / PDF** で取り出せます。

👉 **https://yomei-o.github.io/dosbox_wasm/**

用意するものはありません。開けば動きます。

## なぜ DOSBox-X なのか

JW_CAD の DOS/V 版は VGA 640×480 のグラフィックス画面に直接描画し、漢字は DOS/V が
提供するフォント API から取得します。本家 DOSBox や
[em-dosbox](https://github.com/dreamlayers/em-dosbox) には DOS/V 機能が無いので、
漢字が出ません。DOSBox-X は `src/ints/int_dosv.cpp` に DOS/V を実装していて、
内蔵の日本語フォントを持っているため、実機の DOS/V を用意しなくても動きます。

設定は `web/jwcad.js` が生成しています。要点は:

```ini
[dosbox]
machine=svga_s3          # -V12 (VGA 640x480 16色) に必要
dpi aware=false          # 高DPI環境でキャンバスが拡大率倍に膨れるのを防ぐ
[dosv]
dosv=jp                  # DOS/V エミュレーション
fepcontrol=both          # $IAS と MS-KANJI、両方の FEP 制御 API
[sdl]
autolock=false           # ポインタを捕まえない（キャンバスの外に出られる）
windowresolution=original
showmenu=false           # DOSBox-X のメニューバーは JW_CAD のものと重なる
```

## 日本語入力

`Ctrl` + `Space` で画面のすぐ下に入力欄が開きます。**ブラウザの IME でそのまま変換**して
`Enter` で送ると、JW_CAD の文字列入力欄に入ります。`↑` `↓` で直近20件の履歴、
`Esc` で閉じます。

DOS の FEP は使いません。DOSBox-X の DOS レイヤが `MS$KANJI` を提供していて、
その裏をブラウザの IME が受け持つ形です。非配布物はひとつもありません。

送信の実体は DOSBox-X が既に持っていた仕組みです。ホストの IME で確定した文字列を
ゲストのコード頁に変換して BIOS キーボードバッファへ流す処理が入っているのですが、
Win32 / X11 / macOS 用の `#if` の中にあって Emscripten ビルドからは消えています。
そこで最後の一段だけを `dosbox_x_type_bytes` として外に出し、ページから呼んでいます
（`scripts/patch-dosbox-x.py`）。

入力欄は**画面を覆いません**。JW_CAD は上端を文字列入力欄とパラメータ行に、下端を
ステータス行に使うので、重ねると数値が読めなくなります。

## 図面の書き出し（PNG / SVG / PDF）

JW_CAD のプロッタ出力を受け取って変換します。線・円弧・点のほか、SVG と PDF では
**文字が文字のまま**入るので、検索もコピーもできます。

JW_CAD 側の手順です。上部バーの項目に `(L)` `(R)` と書かれていたら、**バーではなく
作図領域を左/右クリック**して選びます。

### プリンタポート経由（おすすめ）

ファイル名を聞かれないぶん手数が少なくて済みます。

1. **入出力**（左メニュー、`q`）→ `2` プロッタ
2. **右クリック** — `2)プリンタポート出力(R)`
3. 一覧から `WASM.JWP` を選び、もう一度クリックして確定
4. 設定画面 → 作図領域を**左クリック**（確定）
5. 作図開始 → 作図領域を**左クリック**（実行）
6. ページ上部の **PNG** / **SVG** / **PDF** を押す

出力は `C:\PLOT.PRN` に固定です。`[parallel] parallel1=file` でポートをファイルに
落としていて、2秒無通信で閉じます。

### ファイル出力

出力ごとに名前を付けられるので、複数の図面を区別したいときはこちら。

1. **入出力**（`q`）→ `2` プロッタ
2. `3` ファイル出力
3. 一覧から `WASM.JWP` を選び、もう一度クリックして確定
4. 「出力ファイル名 ?」に名前を入れて `Enter`
5. 設定画面 → 作図領域を**左クリック**（確定）
6. 作図開始 → 作図領域を**左クリック**（実行）
7. ページ上部の **PNG** / **SVG** / **PDF** を押す

どちらで出しても、変換ボタンは `C:` にある**いちばん新しいプロッタ出力**を拾います。

`WASM.JWP` はこのページが `C:\JWCAD` に入れているプロッタ設定ファイルです。実在の
プロッタ用ではなく、変換しやすい形で書き出させるためのもの。JW_CAD のプロッタ設定
ファイルは命令ごとの出力文字列を定義できるテンプレートなので、HP-GL を解読せずに
済みます（`web/wasm.jwp`、書式は配布書庫の `JWP.DOC`）。

用紙は**描かれた中身に合わせます**（周囲 10mm）。プロッタ設定の用紙選択に左右されません。

PDF は [libharu](https://github.com/libharu/libharu) を wasm にしたものを使います
（`web/pdf.wasm`、222KB）。日本語は PDF 標準の CJK エンコーディング `90ms-RKSJ-H` で
出すので、**フォントを埋め込みません** — プロッタ出力の文字がシフトJISのまま渡せて、
数MBのフォントを同梱せずに済みます。

## ファイルの出し入れ

エミュレータの `C:` はブラウザの IndexedDB (Emscripten IDBFS) に載っています。
つまり **JW_CAD が書いたものはリロードしても残ります**。

* **取り出す** — `.JWC` などを手元にダウンロード
* **ファイルを入れる** — 手元の図面を `C:` に置く（JW_CAD からすぐ見えます）
* **保存** — IndexedDB へ明示的に書き戻す（15秒ごとの自動保存もあります）

ファイルはブラウザの中だけに置かれ、どこにも送信されません。

## ビルド

autotools と Emscripten が要ります。Windows なら WSL を使ってください
（MSYS2 / Git Bash では emcc のパス変換が通りません）。

```sh
scripts/build-wasm.sh          # 全部
scripts/build-wasm.sh lzh      # lzh.wasm だけ
scripts/build-wasm.sh pdf      # pdf.wasm だけ
scripts/build-wasm.sh dosbox   # dosbox-x.wasm だけ
```

ビルド元のコミットはスクリプトの先頭で固定しています。配信しているバイナリが
どのソースから作られたかを特定できるようにするためで、「その時点の最新」は取りません。

成果物は `web/` に置かれ、そのままコミットされています。GitHub Pages はリポジトリの
ルートをそのまま配信するので、CI を通さなくても更新できます。

| 出力 | 中身 |
|---|---|
| `web/dosbox-x.js` / `.wasm` | DOSBox-X 本体。ASYNCIFY 有効、SDL2、出力は software surface |
| `web/lzh.js` / `.wasm` | [lhasa](https://github.com/fragglet/lhasa) の LZH 展開 |
| `web/pdf.js` / `.wasm` | [libharu](https://github.com/libharu/libharu)。PDF 書き出し |

`.lzh` をブラウザ側で展開しているのは、JW_CAD の配布条件（無改変・必須ファイル一式で
配布）を、配布書庫をそのまま置くことで素直に満たすためです。

`web/index.html` はスクリプトを `jwcad.js?v=<commit>` として読みます。HTML とスクリプトは
別ファイルでキャッシュの寿命も別なので、片方だけ古い状態を防ぐためです。**`web/` を
触ったらこのスタンプも更新してください。**

## ライセンス

このリポジトリ自身のコード（`web/index.html`、`web/jwcad.js`、`web/plot.js`、
`web/wasm.jwp`、`src/`、`scripts/`）は MIT です。同梱している第三者の著作物とビルドに
使うソフトウェアの条件は [third_party/NOTICE.md](third_party/NOTICE.md) に
まとめてあります。

DOSBox-X が GPL-2.0 なので、配信している `web/dosbox-x.wasm` も GPL-2.0 で配布されます。
対応するソースはコミット `145d6a1` にこのリポジトリの `scripts/patch-dosbox-x.py` を
適用したものです。libharu は zlib 系で、ビルド元の書庫を
`third_party/libharu-3467749.zip` として同梱しています。
