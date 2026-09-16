# 引継ぎメモ

2026-09-16 時点。https://yomei-o.github.io/dosbox_wasm/ は公開済み。

---

## 1. 今どうなっているか

DOSBox-X を WebAssembly にビルドし、DOS/V エミュレーションを有効にして
JW_CAD DOS/V 2.22H を動かしている。

### 動作確認済み

| | 確認方法 |
|---|---|
| JW_CAD DOS/V の起動・描画 | ヘッドレスでスクリーンショット取得。漢字メニューも正常 |
| マウス `INT 33h` の初期化 | ログに `Define Horizontal range min:0 max:639` / `Vertical 0-479` |
| キー入力 | `z` を送ると JW_CAD の電卓が開く |
| `C:` の永続化 (IDBFS) | リロード後もファイル一覧が残る |
| LZH 展開 (`lzh.wasm`) | 3書庫すべて lhasa CLI とバイト一致 |
| **日本語のゲストへの注入** | DOS プロンプトに `日本語` を送って6バイト全部受理、漢字が表示された |
| **JW_CAD の文字入力** | 文字コマンド → 位置クリック → 送信で「文字列入力／日本語」が表示。**利用者も実機で確認済み** |
| **マウスの追従** | 誤差 0〜2px（640×480 中）。`dosbox_x_mouse_probe` で実測 |
| **右クリック** | `mousedown button=2` が届き、JW_CAD が右ボタン側コマンドを選択 |
| 日本語入力欄へのタイプ | `nihongo` が入り、かつ DOS 側に漏れない |
| WXP の常駐 | 起動バナー表示、`MEM /C` が 32K → 158K（ただし後述のとおり不要） |

**一通り使える状態になっている。**

---

## 2. マウス — 解決済み（原因: DOSBox-X のメニューバー）

一時は「エミュ内のカーソルとブラウザのポインタが合わない」「クリックすると
WASM の外に出られない」で操作不能だった。**両方とも解決している。**

### 何が起きていたか

DOSBox-X はマウスをロックしていないとき、ゲストに**絶対座標**を渡す:

```c
x = (motion->x - sdl.clip.x) / (sdl.clip.w - 1) * xsensitivity / 100.0f;
```

つまり本来はキャプチャ無しで追従するはず。壊していたのは
**DOSBox-X 自身のメニューバー**だった。表示していると:

- キャンバスが 640×**497**（480 + メニュー 17px）になる
- `sdl.clip` がその 17px 分ずれた状態で、ゲスト画面 480 にマップされる
- 結果、全位置が縦にずれ、かつ倍率も狂う

`[sdl] showmenu=false` で撤去したら揃った。`autolock=false` にしてキャプチャも
やめたので、**ポインタロックが掛からず、画面と入力欄を自由に行き来できる**。

### 実測値

`dosbox_x_mouse_probe`（`scripts/patch-dosbox-x.py` で追加）が
clip 矩形・ホストポインタ・ゲストカーソルを同時に返す。
キャンバスのスクリーンショットは描画途中を掴んで破れるため、
**カーソル位置はピクセルからは測れない。数値で見ること。**

```
0.25,0.25 → guest 160,120   期待 160,120   誤差 0,0
0.50,0.50 → guest 321,241   期待 320,240   誤差 1,1
0.75,0.75 → guest 481,361   期待 479,359   誤差 2,2
clip=(0,0,640,480)  locked=0
```

残る 1〜2px は DOSBox-X が `clip.w - 1` で割っている分。

### 付随して塞いだもの（`web/jwcad.js`）

- **右クリック**: JW_CAD はメニューの各セルに左右別コマンドを持つ二ボタン UI
  なので、ブラウザの `contextmenu` が出ると機能の半分が死ぬ。キャンバス上で
  `contextmenu` / `auxclick` / `dragstart` / `selectstart` を抑止
- **キー漏れ**: SDL2 は `window` で keydown を拾うため、
  (a) 日本語入力欄でタイプしたキーが DOS にも届いてコマンドが暴発し、
  (b) SDL が `preventDefault()` するせいで入力欄に文字が入らない。
  `dosbox-x.js` を読み込む**前に** capture フェーズのリスナを登録し、
  フォーム要素にフォーカスがある間は `stopImmediatePropagation()` で止める。
  登録順が効くので、この位置から動かさないこと

## 3. 日本語入力の設計（重要）

### FEP 経路は原理的に無理だと判明している

JW_CADV.EXE の中に、常駐 FEP を判定するための **DOS デバイス名の固定リスト**がある。
オフセット 180231 付近:

```
$AIC#NEC  $ATC#NEC  FPLD$10  AS$VJE  MTTK  $AID#NEC  MS$KANJI  $KANJI  FIXER  $BNK#DRV  CON
```

一方 WXP のドライバ `wxdp.sys` のデバイスヘッダ（`attr=0x8000`、文字デバイス）が
名乗る名前は **` AISoft `**。リストのどれとも一致しない。
**起動キーを何にしても JW_CAD が この WXP を見つけることはない。**

（JW_CAD 側には `FP$WXP` というドライバ名があるので WXP 自体はサポートされている。
おそらく PC-98 版か DOS/V 版 WXP が対象で、1990年の J-3100 版とはデバイス名が違う。）

デバイスヘッダを読むスクリプトは
`(scratchpad)/devname.py` にある。必要なら再作成すればよい（20行程度）。

### 採用した経路

DOSBox-X は元々、ホストの IME で打った文字をゲストのコードページに変換して
BIOS キーボードバッファへ積む処理を持っている（`SDL_TEXTINPUT` ハンドラ、
`src/gui/sdlmain.cpp` の 6255 行目あたり）。FEP が変換確定文字をアプリへ渡すのと
同じ経路。ところがその処理は

```c
#if (defined(WIN32) && !defined(HX_DOS) || defined(LINUX) && C_X11 || defined(MACOSX)) && ...
```

の中にあり、**Emscripten ビルドでは丸ごと消えている**。

そこで最後の一段だけを `dosbox_x_type_bytes(const unsigned char *s, int len)` として
エクスポートし（`scripts/patch-dosbox-x.py` の `TYPE_NEW`）、ページから呼んでいる。

- Shift_JIS 変換表は持ち込まず、ブラウザ内蔵の `TextDecoder('shift_jis')` を
  全パターン舐めて逆引きしている（`buildSjisTable()`）
- BIOS キーボードバッファは十数文字しか入らないので、受理数を見ながら
  40ms 間隔で少しずつ流す（`flushTyping()`）
- IME 変換確定の Enter と送信の Enter は `ev.isComposing` で区別

### WXP は残してあるが、もう要らない

`[devices]` から読み込む経路は残してある（`fepInstalled()` が真のとき）。
害はないが、日本語入力には不要。

---

## 4. ビルド

```sh
scripts/build-wasm.sh          # dosbox-x と lzh の両方
scripts/build-wasm.sh lzh      # lzh.wasm だけ（数秒）
scripts/build-wasm.sh dosbox   # dosbox-x だけ（初回 ~25分）
```

### 環境（このマシンでの実績）

autotools が要るので **WSL の Ubuntu 20.04** を使った。MSYS2 / Git Bash では
emcc のパス変換が通らない。

| | |
|---|---|
| WSL | `wsl -d Ubuntu-20.04 -u root`（aarch64, 4コア）。sudo はパスワードが要るので root で入る |
| emsdk | `/opt/emsdk`、**3.1.57**。DOSBox-X 公式は 3.1.28 と言っているが、その版に linux-arm64 バイナリが無い。3.1.57 が arm64 の最古 |
| dosbox-x | `/opt/dosbox-x` にクローン済み。`make` 済みなので差分ビルドが効く |
| lhasa | `/opt/lhasa` |
| Playwright | `/opt/pw`（chromium headless shell） |

**Python の罠**: このマシンの WSL は `/usr/bin/python3` が `/usr/local/bin/python3.12`
への symlink に差し替えられていて、その 3.12 は `_ctypes` を欠いている。
emcc がこれを掴むと動かない。`/opt/pybin/python3 -> /usr/bin/python3.8` を作って
PATH の先頭に置いて回避している（`(scratchpad)/emenv.sh`）。

### 差分ビルドの手順（sdlmain.cpp を触ったとき、~5分）

```sh
python3 scripts/patch-dosbox-x.py /opt/dosbox-x
cd /opt/dosbox-x && make -j4
cp src/dosbox-x     web/dosbox-x.js
cp src/dosbox-x.wasm web/dosbox-x.wasm
```

`scripts/patch-dosbox-x.py` は文字列の完全一致置換で、再実行しても冪等。

### configure し直しが要る場合

`RECONFIGURE=1 scripts/build-wasm.sh dosbox`。config.h が変わるのでフルビルド（~25分）。

---

## 5. 潰したバグ（再発したとき用）

すべて DOSBox-X 側の問題。修正は `scripts/patch-dosbox-x.py` と
`scripts/build-wasm.sh` の configure オプションに入っている。

1. **`SDL_InitSubSystem(SDL_INIT_JOYSTICK)` がブラウザで戻ってこない。**
   起動が `Initializing SDL joystick subsystem...` で完全停止。110秒待っても
   ログが1行も進まない。ジョイスティックと CD-ROM の初期化を丸ごと飛ばした。

2. **`C_GAMELINK` が Emscripten でも定義されたまま、`src/Makefile.am` が
   ライブラリだけリンク対象から外す。** メモリ初期化直後に
   `missing function: GameLink::AllocRAM` で abort。`--disable-gamelink` で解決。

3. **`[devices]` は `[autoexec]` より前に走る。** `mount c` を autoexec に
   書いていたため、`DEVICE=` の時点で `C:` が存在せず WXP が黙って読み込まれて
   いなかった。同セクションの `RUN=MOUNT C` で先に mount する。

4. **`wxpdosv` を併用するとゲストがリセットする。** WXP が辞書を読み終えた直後に
   `F000:FFF0` へジャンプ。DOSBox-X の DOS/V エミュレーションが、あの TSR が
   やっていた J-3100 固有 BIOS コールの肩代わりを既に済ませているため。
   `wxpdosv` は実行しない（書庫は資料として同梱したまま）。

---

## 6. テストのやりかたと、その落とし穴

### 起動が固まったときの追跡 — 同期 XHR トレース

**レンダラがブロックされると `console.log` は届かない。** メッセージループが
止まるので devtools にも Playwright のリスナにも来ない。ページはただ死んで見える。

`Module.print` / `printErr` を**同期 XHR** で `/LOG/<message>` に投げると、
スレッドがブロックされていても送信される。Web サーバのアクセスログがトレースになり、
**止まる直前の最後の1行が犯人**。上記バグ1はこれで特定した。

- 常用ページ: `web/index.html?trace=1` で有効になる
- 単体ツール: `tools/trace.html`（使い方は `tools/README.md`）

```sh
python3 -u -m http.server 8795 --bind 127.0.0.1 > /tmp/httpd.log 2>&1 &
# ページを開いてから
grep -oE 'GET /LOG/[^ ]*' /tmp/httpd.log | sed 's|GET /LOG/||' |
  python3 -c 'import sys,urllib.parse; [print(urllib.parse.unquote(l.strip())) for l in sys.stdin]'
```

### ヘッドレス環境の癖（かなり時間を取られた）

- **3〜4回に1回くらい、ブラウザ起動か `page.goto` で無反応のまま固まる。**
  原因は掴めていない。残留プロセスでもメモリ不足でもなかった。
  必ず `timeout -s KILL` を掛け、**node の出力はファイルにも落とすこと**。
  SIGKILL でバッファされた stdout は消える。
- **`canvas.screenshot()` が描画途中を掴んで、複数フレームが合成された
  破れた画像になることがある。** カーソル位置の精密測定には使えない。
  状態の大まかな確認には使える。
- 1回の起動確認に **1〜2分**かかる。JW_CAD の描画完了まで含めると
  起動から 60〜70秒は待つ必要がある。
- キャンバスをクリックするとタブが固まる、という現象を一度見たが再現しなかった。
  headless 特有の不安定さだった可能性が高い。**ただしこれを「headless 特有」と
  early に決めつけたのは失敗だった。** 実機でも操作できないという報告が来るまで
  本物のバグとして追わなかった。挙動がおかしいときは実機で確認してもらうのが早い。

### 判定は画面より中身を見る

`MEM /C > C:\MEMLIST.TXT` を autoexec に仕込み、`Module.FS.readFile()` で
JS 側から読むと、何が常駐したかが確実に分かる。WXP の常駐（32K → 158K）と
wxpdosv のクラッシュはこれで判定した。スクリーンショットの目視より信頼できる。

---

## 7. ファイルの地図

```
web/
  index.html      UI。ヘッダに FEP 欄と日本語入力欄、下にファイルパネル
  jwcad.js        起動、dosbox-x.conf の生成、IDBFS、LZH 展開、日本語注入
  dosbox-x.js/.wasm  DOSBox-X 本体（コミット済み、17MB）
  lzh.js/.wasm    lhasa。-lh1-（WXP が使用）と -lh5- に対応
scripts/
  build-wasm.sh       ビルド一式
  patch-dosbox-x.py   DOSBox-X への修正3点（文字列完全一致、冪等）
third_party/
  jwcv222h.lzh    JW_CAD DOS/V 2.22H（無改変の配布書庫のまま）
  wxpdosv4.lzh    wxpdosv（実行していない。資料として同梱）
  NOTICE.md       同梱物の出典と条件
tools/
  trace.html      起動ハング追跡用
patches/          参考用の diff（実際に当てるのは scripts/patch-dosbox-x.py）
.github/workflows-pending/
  ワークフロー2本。push したトークンに workflow スコープが無くて弾かれたので
  ここに退避してある。Pages はブランチ配信なので無くても動く。
  有効にするなら gh auth refresh -h github.com -s workflow の後に移動。
```

`web/jwcad.js` の `buildConf()` が生成する `dosbox-x.conf` が設定の中心。
`INSTALL_VERSION` を上げると、次回起動時に `C:` へ再インストールされる。

---

## 8. ライセンスまわり

`third_party/NOTICE.md` に詳細。要点だけ:

- **JW_CAD**: 配布条件に「転載及び配布」の項があり、無改変・必須ファイル一式・
  使用条件の引用を条件に配布が認められている。配布書庫をそのまま置き、
  ブラウザ側で展開することで満たしている。雑誌等への収録は作者との事前相談が必要。
- **WXP**: エー・アイ・ソフトの条件5項で、許可なく他のネットへ転載することが
  禁じられている。**同梱していない。** 書庫のままでも展開してディスクイメージに
  入れても同じ扱いになる。利用者が `wxpj31.lzh` を自分で入手して
  ページに放り込む方式にしてある。
  なお日本語入力は WXP 無しで動くようになったので、実用上は不要。
  - 手元の `C:\prog\claude2\wxpj31.lzh` は `.gitignore` 済み。
- **wxpdosv**: Vector のフリーソフト。明示的な再配布制限は無いが、
  作者から申し出があれば削除する旨を NOTICE に書いてある。
- **DOSBox-X**: GPL-2.0。配信している `dosbox-x.wasm` は GPL-2.0 で配布される。
- **lhasa**: ISC。

---

## 9. 積み残し（マウス以外）

- 配置された文字は既定（`S=1/100`・文字サイズ 3.0mm・表示倍率 0.40）だと
  数ピクセルにしかならず画面上で判読できない。入力自体は通っているので実害は
  無いが、確認したいときは JW_CAD 側で拡大するか文字種を大きくする
- `web/dosbox-x.wasm` が 17MB。gzip で 4MB 程度になるが、初回読み込みは重い。
  ASYNCIFY の対象を絞れば小さくできる可能性がある（未着手）
- DOSBox-X のメニューバーは `showmenu=false` で消してある。設定を触りたく
  なったときの導線が無いので、必要ならページ側にボタンを用意する
- 画面サイズの切り替え（`-V6a` = 800×600）は UI に選択肢はあるが未検証。
  切り替えるとキャンバスの寸法が変わるので、2節のクリップ矩形の話が
  再燃しないか確認すること
- FEP 欄（WXP の投入）と「かな漢字 ON/OFF」ボタンは、日本語入力が
  ブラウザ IME 経由で解決したので**もう不要**。残してあるだけなので、
  UI を整理するなら外してよい
