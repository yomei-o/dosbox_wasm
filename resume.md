# 引継ぎメモ

2026-09-15 時点。https://yomei-o.github.io/dosbox_wasm/ は公開済み。

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
| WXP の常駐 | 起動バナー表示、`MEM /C` が 32K → 158K |

**ただし、実用上はまだ使える状態ではない。** マウスの問題（2節）で
まともに操作できない、というのが利用者の評価。上の表は「機構が動いている」
ことの確認であって、「使える」ことの確認ではない。

### 未確認

- **JW_CAD の文字入力欄で実際に日本語が入るか。** 文字コマンド（右メニューの `A`）を
  出すところまでは自動操作できたが、JW_CAD は文字を置く位置をクリックするまで
  文字を読み始めないため、ヘッドレスでそこまで詰めきれなかった。
  COMMAND.COM と同じ `INT 16h` 経由で読むはずなので通ると見ている。

---

## 2. 最優先の宿題 — マウスが使いものにならない

**利用者の報告（2026-09-15）**

> エミュ内のマウスとブラウザ内のマウスが位置が合わないので操作がうまくできない
> たぶんエミュレータでは全然 CAD は動かないんだと思う
> WASM 内でマウスをクリックすると WASM の外に出れないんだ
> だから日本語入力できない

**実用上、現状の JW_CAD はまともに操作できない。** ここが最大の課題。

### 問題は2つある

**(a) キャプチャしていないとカーソルが合わない。**
DOSBox-X はマウスキャプチャ前提で相対移動をゲストへ送る。掴んでいない状態では
ホストのポインタとゲストのカーソルが別々に動き、位置が一致しない。

**(b) 一度掴むと、ページの他の場所に戻れない。**
`[sdl] autolock=true` にしたのでクリックでポインタロックが掛かる。ロック中は
ページ上の他の要素をクリックできないので、**日本語入力欄にたどり着けない**。
日本語入力の設計（ページ側のテキスト欄に打ち込む）がこれで成立しなくなっていた。
`autolock=false` に戻せば (b) は消えるが (a) が残る。**どちらの設定でも詰んでいる。**

### 応急処置（実施済み、要検証）

`web/jwcad.js` に脱出経路を入れた。ただし**実機での確認は取れていない。**

- `Esc` — ブラウザ自身のポインタロック解除。仕様上ページ側から抑止できないので確実
- `Ctrl+Shift+Space` — `exitPointerLock()` してから日本語入力欄にフォーカスを入れる。
  `window` に capture フェーズで付けているので、ロック中でも届く
- `pointerlockchange` を監視し、解放されたら自動で日本語入力欄にフォーカス。
  掴んでいる間はヘッダに「マウスを掴んでいます — Esc で解放」と出す

### 本筋の解決案（どれか、あるいは組み合わせ）

1. **キャプチャせずに絶対座標で追従させる。** これができれば (a) も (b) も同時に
   消える。ロックが要らなくなるのでページとの行き来も自由。最有力。
   - Emscripten の SDL2 は `xscale = window->w / client_w` で CSS 拡大を補正する
     はずなので、理屈の上では `autolock=false` で合うはず。合わないなら
     どこで壊れているかを実測する必要がある
   - 切り分け: キャンバスの CSS 拡大をやめて 1:1 にして試す。
     一度 `[render] scaler=normal2x` でバッキングストアを大きくしようとしたが
     **scaler はバッキングストアに効かなかった**（640×480 のまま）。原因未調査
   - DOSBox-X 側で、キャプチャ無しのときに `Mouse_CursorSet()` 相当の
     絶対座標経路を通っているかをソースで確認する
     （`GFX_CaptureMouse` は `src/gui/sdlmain.cpp:2677`、`autolock` は 6892 行）

2. **日本語入力欄をキャンバスの外に置かない。** ロック中でもキーイベントは
   ページに流れてくるので、キー1発でキャンバス上にオーバーレイを出し、
   そこで IME を使う。ロックを解かずに済む

3. `[sdl] usesystemcursor=true`（`src/gui/sdlmain.cpp:6953`）も一応試す

### 検証のしかた

**実機で触ってもらうのが圧倒的に速い。** ヘッドレスではカーソル位置の精密測定が
できない（スクリーンショットが描画途中で破れる、6節参照）。最低限これだけ聞けば
切り分けられる:

- 掴んでいない状態でカーソルは2つ見えるか、ズレの方向は一定か
- クリックしたときブラウザのカーソルは消えるか（＝ロックが掛かっているか）
- `Esc` で抜けられるか

---

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

- **JW_CAD の文字入力欄で日本語が入るかの確認**（1節参照）。
  2節のマウス問題が片付かないと、そもそも文字を置く位置をクリックできない
- `web/dosbox-x.wasm` が 17MB。gzip で 4MB 程度になるが、初回読み込みは重い。
  ASYNCIFY の対象を絞れば小さくできる可能性がある（未着手）
- DOSBox-X のメニューバーは `showmenu=false` で消してある。設定を触りたく
  なったときの導線が無いので、必要ならページ側にボタンを用意する
- 画面サイズの切り替え（`-V6a` = 800×600）は UI に選択肢はあるが未検証。
  README_V.DOC によると SVGA モードでは FEP がインラインで動かない旨の記述がある
