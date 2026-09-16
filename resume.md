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

### WXP を JW_CAD で使う試み — 行き止まり（2026-09-16）

日本語入力はブラウザ IME で解決済みだが、それとは別に「WXP を FEP として
使えないか」を追いかけた。**WXP は DOSBox-X 上では ON にできない。**

#### 分かったこと

`wxpdosv.asm`（書庫に同梱のソース）の INT 15h AH=4Fh ハンドラが、WXP の
制御方法をそのまま示している:

```
        cmp     al,56h          ; -j: J-3100 漢字キー
        cmp     al,38h          ; -a: 右ALT (E0 38)
        cmp     al,29h          ; 既定: Alt + 全角/半角
        ...
        mov     ax,4c00h
        int     6ch             ; WX 状態取得 (AL: 0=OFF)
        mov     ah,00h
        int     6ch             ; WX 設定変更 (AL: 0/1)
```

つまり **WXP の制御口は INT 6Ch**。WXP 自身はキーボードを見張っていないので、
誰かが INT 6Ch を叩かない限り一生 ON にならない。常駐しているのに無反応
だったのはこれが理由。

検証したこと:

| | 結果 |
|---|---|
| INT 6Ch ベクタ | `0464:71E0` = WXP.SYS のロード先。生きている |
| 状態取得 `AX=4C00h` | **正常に返る**（AL=0 = OFF） |
| ON 設定 `AH=00h, AL=01h` | **エミュレータが固まる** |

ON 設定の固まりかたは、呼ぶ文脈を変えても同じだった:

1. キーボード IRQ 内（INT 15h AH=4Fh ハンドラ）から → 固まる
2. アプリ文脈（INT 16h フック）から → 固まる
3. 普通の COM から単独で → 固まる

3通りとも同じなので、呼び出し側の問題ではなく **WXP が ON 処理の中で
戻ってこない**。おそらく変換表示やステータスラインを J-3100 の表示 BIOS
経由で描こうとして、DOSBox-X がそれを提供していないため。

#### ここまでに分かった周辺事実（再挑戦するとき有用）

- DOSBox-X の IRQ1 コールバックは確かに `mov ah,4Fh / stc / int 15h` を
  発行している（`src/ints/bios_keyboard.cpp` の CB_IRQ1 疑似コード）。
  実測でも Scroll Lock は `46h`/`C6h` として届く。**キーフックは使える。**
- ただし **INT 6Ch をキーボード IRQ の中から呼ぶと固まる**。TSR を書くなら
  IRQ では旗を立てるだけにして、実処理は INT 16h 側でやること
- JW_CAD 側の FEP 検出（`MS$KANJI` などのデバイス名リスト）とは無関係に、
  WXP を ON にできれば INT 16h 経由で文字は入るはず。JW_CAD のドキュメントの
  `-I`/`-I2` は「かな漢字変換の自動 On-Off」の制御で、検出はトグルの
  自動化のためのもの

#### 残っている道（いずれも重い）

1. **J-3100 表示 BIOS を DOSBox-X 側に実装する。** WXP が ON 処理で何を
   呼んでいるかは、DOSBox-X に INT 10h / INT 60h のトレースを仕込めば分かる。
   wxpdosv.asm がどの呼び出しを埋めているかが設計の下敷きになる
2. **wxpdosv を直す。** ソースがあるので、DOSBox-X が既に提供している部分
   （int 10h/29h/60h の大半）を削って、必要な最小限だけ残す。ただし
   そのままではゲストがリセットするので、まずどこで落ちるかの特定が要る
3. WXP の `/ME`（カーソル ON/OFF を無視して強制エコーモード）を試す。
   未検証。表示経路が変わるので固まりが回避できる可能性はある

#### 手元にあるもの

- `src/wxpkey/wxpkey.asm` — INT 15h でキーを拾い INT 16h でトグルする TSR。
  **現状では使えない**（ON 設定で固まるため）が、道 2/3 が解決すれば
  そのまま使える。ビルドは `nasm -f bin wxpkey.asm -o WXPKEY.COM`
- 診断用の小物（scratchpad にあったもの。必要なら作り直す、各 100 行未満）:
  `wxprobe.asm` INT 6Ch ベクタと状態を表示 /
  `wxpon.asm` ON 設定だけを実行 /
  `keyspy.asm` INT 15h AH=4Fh に来たスキャンコードを表示

### MS-DOS 5.0/V の MSIME を使う試み — こちらも行き止まり（2026-09-16）

WXP が駄目だったので、MS-DOS 5.0/V 付属の **MSIME** を試した。
**FEP としては正しい相手だが、DOSBox-X の内蔵 DOS 上では動かない。**

#### なぜ MSIME なら見込みがあったか

JW_CADV.EXE が FEP 検出に使うデバイス名リストには `MS$KANJI` が入っている。
そして MSIME のデバイスヘッダを読むと:

| ファイル | 属性 | デバイス名 |
|---|---|---|
| `MSIMEK.SYS` | `c000` 文字デバイス | **`MS$KANJI`** |
| `MSIMEI.SYS` | `c000` 文字デバイス | `MS IMEI$`（中に `$IAS` / `$IBMAIAS` の文字列あり） |

つまり MSIME は MS-KANJI API を実装した**本物の DOS/V 用 FEP**で、
JW_CAD が素直に検出できるはずだった。J-3100 用で `AISoft` を名乗る WXP とは
根本的に違う。

#### 何が起きたか

`[devices]` から `DEVICE=C:\DOS\MSIMEK.SYS` で読ませると:

```
Device driver load area: segment 464-9f1a for driver 'C:\DOS\MSIMEK.SYS'
Init device name 'MSIMEK.SYS'
...
ERROR CPU:Illegal Unhandled Interrupt Called 6      ← 以後ずっと繰り返し
```

ロードと初期化開始までは行くが、そこで**無効オペコード例外（INT 6）を
延々と踏み続けて**止まる。DOS バージョンは関係ない（DOSBox-X は既定で
5.0 を名乗る）。DOSBox-X の内蔵 DOS は MS-DOS そのものではないので、
MSIME が前提にしている DOS 内部構造か DOS/V のデバイス
（`$IBMAFNT` など）が噛み合っていないと思われる。

#### 切り分けた結果（安い可能性は全部潰した）

| 試したこと | 結果 |
|---|---|
| MSIMEK.SYS 単独 | Init 直後に INT 6 無限ループ |
| DOS/V ドライバ一式を前に入れる<br>(BILING → $FONT → $DISP → DOSVSYS → KKCFUNC) | **ドライバは全部正常にロードされる**が、MSIMEK で同じループ |
| `dosv=off`（本物のドライバに任せる） | 同じ |
| `ems=false`（辞書をメインメモリに） | 同じ（21,164回ループ） |
| DOS バージョン | DOSBox-X は既定で 5.0 を名乗るので元から一致 |

**前提ドライバ不足でも EMS でも DOS バージョンでもない。**
 の初期化コードが DOSBox-X の内蔵 DOS の上では
どこか不正な場所へ飛んでいる。INT 6 はデータを実行したときの症状なので、
DOS 内部構造か何かのポインタが期待と違うのだと思われる。

なお **DOS/V ドライバ一式（$FONT.SYS / $DISP.SYS / BILING.SYS / KKCFUNC.SYS）は
DOSBox-X の内蔵 DOS 上で問題なくロードできる**ことは分かった。これは収穫。

#### 残っている道

**本物の MS-DOS 5.0/V を起動する。** `IMGMOUNT` + `BOOT` でフロッピー
イメージから起動すれば、MSIME は設計どおりの環境で動くはず。ただし代償が
大きい:

- 実 DOS を起動するとホストディレクトリの `MOUNT C /work` が使えない。
  JW_CAD もファイルパネルもディスクイメージの中に移す必要がある
  （np2_wasm が実際にやっている方式なので、前例はある）
- 現在の「C: が IDBFS、ファイルパネルで出し入れ」という構成は作り直しになる

#### 素材の扱い（重要）

MS-DOS 5.0/V は **Microsoft の商用ソフトで著作権が生きている**。
JW_CAD（再配布明示許可）や WXP（フリーウェア）とは性質が違い、
**公開リポジトリには一切入れられない。** 検証に使ったファイルは
`.build/msime/`（gitignore 済み）にのみ置いた。

利用者が自分の手持ちを持ち込む形なら、WXP と同じくブラウザ内 (IndexedDB)
に留まり外には出ない。

#### 手順のメモ（再挑戦するとき）

配布イメージは `Disk1.IMG` 〜 `Disk3.IMG`。MSIME 一式は **Disk3**。
インストールディスクなので拡張子末尾が `_` の SZDD 圧縮。

```sh
apt install mtools mscompress
mcopy -i Disk3.IMG ::MSIMEK.SY_ .        # 取り出し
msexpand < MSIMEK.SY_ > MSIMEK.SYS       # 展開
```

`MSIMEK.SYS` の既定辞書パスは `C:\MSIME.DIC` と `C:\MSIMER.DIC`
（ファイル内の文字列で確認）。EMS があればそこに辞書を置き、無ければ
メインメモリにフォールバックする。

### 本物の MS-DOS 5.0/V を起動する試み — 途中（2026-09-16）

MSIME が内蔵 DOS で動かないので、実 DOS を起動する路線を試した。
**ブートの受け渡しまでは到達したが、画面が出ない。**

#### まず踏んだ地雷: emscripten は C++ 例外を消す

`BOOT` した瞬間にプログラムが死んで画面が真っ暗になる。原因は
DOSBox-X が**マシン再起動を `throw int(8)` で実装している**こと
（`src/dos/dos_programs.cpp` の 2337 / 2618 / 3491 行）。
一方 **emscripten は既定で `-fignore-exceptions` でコンパイルする**ので、
例外機構が無く `throw` がそのままトラップになる。

JW_CAD 用の構成では BOOT を通らないので今まで表に出なかった。

修正はビルドフラグだけ:

```
CFLAGS   += -fexceptions
CXXFLAGS += -fexceptions
LDFLAGS  += -fexceptions -sDISABLE_EXCEPTION_CATCHING=0
```

`CXXFLAGS` が変わるので configure からやり直し（フルビルド）。
これで死ななくなり、ページも生きたまま BOOT を通過するようになった。
**例外有効版は `.build/exc/` に置いてある**（`web/` の本番ビルドは
例外無効のまま。JW_CAD 側には不要なので）。

#### 現状: ブートは渡るが画面が出ない

```
IMGMOUNT A /work/Disk1.IMG -t floppy
BOOT -l A
```

トレースはここまで正常:

```
FAT: BPB says 18 sectors/track 2 heads 512 bytes/sector
Mounted FAT volume is FAT12 with 2847 clusters
DIRCACHE: Set volume label to DISK      1
...
Mounted empty C/H/S/sz 80/2/18/512 1440KB      ← 気になる
Booting guest OS stack_seg=0x0030 load_seg=0x07c0
```

イメージは正しく読めていて（ボリュームラベル `DISK 1` まで見えている）、
ブートセクタをロードしてゲストに制御を渡している。エラーも abort も無い。
その後 DOSBox-X が喋らなくなるのは、ゲストに移れば当然なので異常ではない。

**しかし画面は最初から最後まで真っ暗。** 120秒待っても変化なし。

#### 次に当たるべきところ

1. **`Mounted empty C/H/S/sz 80/2/18/512 1440KB`** — ブート直前に A: が
   空の 1.44MB として再マウントされているように読める。`MOUNT C` を
   外しても消えなかったので BOOT 自身の動作。空のドライブから起動して
   いるなら画面が出ないのは当然。ここが第一容疑
2. ゲストが本当に実行されているかの確認。CPU が進んでいるかを
   DOSBox-X 側から観測する（`dosbox_x_mouse_probe` と同じ要領で
   レジスタや実行カウンタを出すエクスポートを足せば分かる）
3. 画面出力の経路。マシンリセットを挟んだ後に `output=surface` の
   キャンバスが再初期化されているか
4. `BOOT` の引数。`BOOT -l A` ではなく `BOOT /work/Disk1.IMG -l A` の形や、
   `IMGMOUNT A ... -t floppy -fs none` も試す価値がある

#### 素材

`.build/msdos/` に Disk1〜3 のイメージ、`.build/msime/` に展開済みの
MSIME と DOS/V ドライバ一式（どちらも gitignore 済み。MS-DOS は
Microsoft の商用ソフトなので公開リポジトリには置けない）。

### WXP の同梱経路は残してある

`[devices]` から読み込む経路（`fepInstalled()` が真のとき）はそのまま。
常駐するだけなら害はない。

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
