# dosbox_wasm — JW_CAD DOS/V in the browser

[DOSBox-X](https://github.com/joncampbell123/dosbox-x) built to WebAssembly with its
DOS/V (Japanese) emulation turned on, running **JW_CAD for DOS/V 2.22H**, with a file
panel for moving drawings in and out.

👉 **https://yomei-o.github.io/dosbox_wasm/**

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
[dosv]
dosv=jp                  # DOS/V エミュレーション
fepcontrol=both          # $IAS と MS-KANJI、両方の FEP 制御 API
```

## ファイルの出し入れ

エミュレータの `C:` はブラウザの IndexedDB (Emscripten IDBFS) に載っています。
つまり **JW_CAD が書いたものはリロードしても残ります**。

* **取り出す** — `.JWC` などを手元にダウンロード
* **ファイルを入れる** — 手元の図面を `C:` に置く（JW_CAD からすぐ見えます）
* **保存** — IndexedDB へ明示的に書き戻す（15秒ごとの自動保存もあります）

ファイルはブラウザの中だけに置かれ、どこにも送信されません。

## 日本語入力 (FEP)

エー・アイ・ソフトのフリー FEP **WXP for J-3100** を使います。**WXP 本体は再配布条件により
同梱できません**（[third_party/NOTICE.md](third_party/NOTICE.md) 参照）。

1. `wxpj31.lzh` を入手する
2. ページ上部の **FEP** 欄に放り込む（ブラウザ内に保存されます）
3. **再起動**

以後は `CONFIG.SYS` 相当の `[devices]` から読み込まれます。

```ini
[devices]
RUN=MOUNT C /work
DEVICE=C:\WXP\WXP.SYS /R /Z /H30 /CS /D1C:\WXP\JISHO01.DIC /D3C:\WXP\JISHO02.DIC
DEVICE=C:\WXP\WXDP.SYS
```

`RUN=MOUNT C` が要るのは、このセクションが `[autoexec]` **より前**に走るからです。
`mount` を `[autoexec]` に書くと、`DEVICE=` の時点で `C:` がまだ存在せず、WXP は
黙って読み込まれません。

### wxpdosv は使っていません

WXP は J-3100 用なので、本来は DOS/V 機で動かすのに
[wxpdosv](https://www.vector.co.jp/soft/dos/writing/se105856.html)
という TSR で J-3100 固有の BIOS コールを埋める必要がありました。
DOSBox-X ではこれが**不要どころか有害**です。

| 構成 | 結果 |
|---|---|
| WXP のみ | 起動バナーが出て常駐。`MEM /C` が 32K → **158K** |
| WXP + wxpdosv | WXP が辞書を読み終えた直後、ゲストがリセットベクタ (`F000:FFF0`) へ飛ぶ |

DOSBox-X の DOS/V エミュレーションが、あの TSR のやっていた仕事をすでに
済ませているためです。書庫自体は `third_party/` に残してあります
（アセンブリソース付きで、当時どの BIOS コールを埋めていたかの資料になります）。

### 起動キー

FEP を呼び出すキーは環境で変わるので、ページ上部で選べるようにしてあります。
**かな漢字 ON/OFF** ボタンがそのキーをエミュレータへ直接送るので、ブラウザや OS に
<kbd>Alt</kbd> を横取りされる環境でも届きます。JW_CAD は左 <kbd>Alt</kbd> を
<kbd>GRPH</kbd> として使うので、そこは避けてください。

## ビルド

autotools と Emscripten が要ります。Windows なら WSL を使ってください
（MSYS2 / Git Bash では emcc のパス変換が通りません）。

```sh
scripts/build-wasm.sh          # dosbox-x.wasm と lzh.wasm の両方
scripts/build-wasm.sh lzh      # lzh.wasm だけ
```

成果物は `web/` に置かれ、そのままコミットされています。GitHub Pages はリポジトリの
ルートをそのまま配信するので、CI を通さなくても更新できます。

| 出力 | 中身 |
|---|---|
| `web/dosbox-x.js` / `.wasm` | DOSBox-X 本体。ASYNCIFY 有効、SDL2、出力は software surface |
| `web/lzh.js` / `.wasm` | [lhasa](https://github.com/fragglet/lhasa) の LZH 展開。`-lh1-`（WXP が使用）と `-lh5-` に対応 |

`.lzh` をブラウザ側で展開しているのは、JW_CAD の配布条件（無改変・必須ファイル一式で
配布）を、配布書庫をそのまま置くことで素直に満たすためです。同じ経路がユーザーの
持ち込む FEP 書庫にも使えます。

## ライセンス

このリポジトリ自身のコード（`web/index.html`、`web/jwcad.js`、`src/lzhwasm/`、
`scripts/`）は MIT です。同梱している第三者の著作物とビルドに使うソフトウェアの
条件は [third_party/NOTICE.md](third_party/NOTICE.md) にまとめてあります。
DOSBox-X が GPL-2.0 なので、配信している `dosbox-x.wasm` は GPL-2.0 で配布されます。
