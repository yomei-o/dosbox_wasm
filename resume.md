# 引継ぎメモ

2026-09-16 時点。https://yomei-o.github.io/dosbox_wasm/ は公開済み。

---

## 1. 今どうなっているか

DOSBox-X を WebAssembly にビルドし、DOS/V エミュレーションを有効にして
JW_CAD DOS/V 2.22H を動かしている。**利用者が用意するものは何もない。**

### 動作確認済み

| | 確認方法 |
|---|---|
| JW_CAD DOS/V の起動・描画 | ヘッドレスでスクリーンショット取得。漢字メニューも正常 |
| **漢字入力** | `Ctrl`+`Space` → ブラウザの IME で変換 → Enter。**利用者が実機で確認済み** |
| **マウスの追従** | 誤差 0〜2px。拡大率 100% / 125% / 200% で実測 |
| **右クリック** | `mousedown button=2` が届き、JW_CAD が右ボタン側コマンドを選択 |
| `C:` の永続化 (IDBFS) | リロード後もファイル一覧が残る |
| LZH 展開 (`lzh.wasm`) | 3書庫すべて lhasa CLI とバイト一致 |
| 日本語のゲストへの注入 | DOS プロンプトに `日本語` を送って6バイト全部受理 |
| 入力欄が画面を覆わないこと | 全状態で `covers:false` を実測 |

### 入力欄の仕様（`Ctrl`+`Space`）

- **画面の外、キャンバスのすぐ下**に出る。JW_CAD は上端を文字列入力欄と
  パラメータ行に、下端をステータス行に使うので、**画面の上に重ねてはいけない**
  （両方やって両方とも怒られた）
- Enter は送信するが**閉じない**。位置のクリック → `Ctrl`+`Space` → 打つ →
  Enter の繰り返しになるため。クリックでフォーカスはキャンバスへ移る
- `Ctrl`+`Space` は「開く／入力欄へ戻る／閉じる」の3状態
- `↑` `↓` で直近20件の履歴

---

## 2. マウス — 3回別々の原因で壊れた

「ずれる」という同じ症状で、**原因が3つあった**。どれも直っているが、
次にずれたときに1つ目だけ見て満足しないこと。

### 原因1: DOSBox-X 自身のメニューバー

表示しているとキャンバスが 640×**497**（480 + メニュー 17px）になり、
`sdl.clip` がずれた状態でゲスト画面 480 にマップされる。
`[sdl] showmenu=false` で撤去。

### 原因2: 高DPI（**利用者環境でだけ再現した**）

`SDL_CreateWindow` に `SDL_WINDOW_ALLOW_HIGHDPI` が付いていると
（`dpi_aware_enable` が既定で有効、`src/gui/sdlmain.cpp:1885`）、
Emscripten の SDL2 がキャンバスのバッキングストアを devicePixelRatio 倍にする。
ウィンドウがゲスト画面より大きくなり、DOSBox-X はその中央に 640x480 を
**等倍のまま**置く。

| | devicePixelRatio 2 | 修正後 |
|---|---|---|
| バッキングストア | 2560x2560 | 640x480 |
| クリップ矩形 | 320,400,640,480 | 0,0,640,480 |
| 位置誤差 | 最大 279px | 0〜2px |

**「マウスがずれる」と「画面が小さい」は同じバグ**だった。対処は設定だけ:

```ini
[dosbox]
dpi aware=false      ; 注意: [sdl] ではなく [dosbox]（src/dosbox.cpp:1690）
[sdl]
windowresolution=original
```

**教訓**: 拡大率 100% でしか測っていなかったので、ずっと「合っている」と
見えていた。利用者環境固有の条件は、条件を変えて測るまで直ったと言わないこと。

### 原因3: 本物の DOS を起動すると相対移動になる（MS-DOS 路線を取り下げた理由）

`BOOT` すると DOSBox-X の INT 33h が消える。**INT 33h こそが絶対座標を
渡す仕組み**で、キャプチャ無しで追従できていたのはこれのおかげ。
ゲストは PS/2 の相対移動しか見えなくなり、動かすほどズレが溜まる。

残そうとしたが**構造的に無理**だった:

```c
i33loc = RealMake(DOS_GetMemory(0x1,"i33loc")-1, 0x10);   // DOS のメモリから確保
```

ハンドラのスタブが DOS メモリ上にあり、起動したゲストがそのメモリを所有する。
フラグ（`en_int33`）もベクタも問題ではなく、**居場所を奪われる**。
残すにはスタブを BIOS 側の領域へ移し、起動後にベクタを張り直す必要がある。

CuteMouse（CTMOUSE）は GPL で同梱もできるが、**全バイナリを調べて VMware の
マジックナンバー `0x564D5868` を持たないことを確認済み**。絶対座標は喋らない。

### 検証ツール

`(scratchpad)/mouse.mjs` — 第3引数に viewport 幅、第4引数に devicePixelRatio。
`dosbox_x_mouse_probe` が clip 矩形・ホストポインタ・ゲストカーソルを同時に返す。
**キャンバスのスクリーンショットは描画途中を掴んで破れるため、カーソル位置を
ピクセルから測ってはいけない。数値で見ること。**

---

## 2.5 ページとスクリプトのキャッシュ

`index.html` と `web/jwcad.js` は別ファイルで、キャッシュの寿命も別。
**片方だけ古い状態が実際に起きた** — MS-DOS モードを消したとき、古いままの
スクリプトが無くなった要素を掴んで
`Cannot set properties of null (setting 'onchange')` で落ちた。

`<script src="jwcad.js?v=<commit>">` と刻んであるので、**`web/` を触ったら
このスタンプも更新すること**。忘れると同じことが起きる。

GitHub Pages の反映は push から約30秒。それより早く試すと古いものが返る。

---

## 3. 日本語入力の設計（重要）

### FEP 経路は原理的に無理だと判明している

> **範囲に注意（2026-09-16 追記）**: これは **DOSBox-X 内蔵の DOS の上での話**。
> 本物の MS-DOS 5.0/V を起動すれば MSIME も WXP も動き、変換まで通った
> （下の「本物の MS-DOS 5.0/V の上で JW_CAD が動いた」以降）。
> ただしマウスが相対移動になるため取り下げた（2節の原因3）。

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

### 本物の MS-DOS 5.0/V の上で JW_CAD が動いた（2026-09-16）

**起動する。DOS/V の日本語表示も出る。MSIME も常駐する。JW_CAD も動く。**
残るは MSIME を呼び出した瞬間にゲストが固まる一点。

#### 根本原因はひとつだった — CALLBACK_Idle と Asyncify

`CALLBACK_Idle()` は DOSBox-X がエミュレート時間を進めたいときに必ず呼ぶ
関数で、入れ子で `DOSBOX_RunMachine()` を回して割り込みを処理させる。
Emscripten ビルドではそこに `GFX_Events()`（＝`emscripten_sleep()`）が
入っていて、**割り込みハンドラの数フレーム奥で Asyncify の巻き戻しが起き、
そこから復帰できない。** ゲストはコールバック直後の IRET で永久に止まる。

実 DOS の起動はこれを連続で踏む:

| 踏んだ場所 | 呼び出し元 |
|---|---|
| `INT 13h` ブートセクタの読み込み | `diskio_delay()` の転送遅延ループ |
| `INT 1Ah` | CMOS の「更新中」ビット待ち（`src/ints/bios.cpp:3067`）|

対処は2つ。前者は設定で逃げられる:

```ini
[dos]
hard drive data rate limit=0
floppy drive data rate limit=0
```

**JW_CAD が最初から無事だったのはこれが入っていたからで、完全に偶然。**

後者は設定では逃げられないので、`CALLBACK_Idle()` から yield を外した
（`scripts/patch-dosbox-x.py`）。入れ子のマシン実行が機能の本体で、
`GFX_Events()` は「待っている間ブラウザを固めない」ためのおまけ。

#### そこに至るまでに踏んだ地雷

1. **emscripten は既定で C++ 例外を消す**（`-fignore-exceptions`）。
   DOSBox-X はマシン再起動を `throw int(8)` でやるので、`BOOT` が
   失敗ではなく**トラップ**していた。`-fexceptions` と
   `-sDISABLE_EXCEPTION_CATCHING=0` を足してフルビルド
2. **配布イメージがトリムされている。** `Disk1.IMG` は 2,256 セクタしか
   無いのに BPB は 2,880 と申告するので、後方セクタの読み取りが失敗して
   `Non-System disk or disk error` になる。1,474,560 バイトへゼロ埋めで解決
3. `MSIMED.SYS` の入れ忘れ →「かな漢字変換は組み込まれませんでした」
4. **実 DOS を起動すると DOSBox-X の INT 33h が消える。** JW_CAD は
   マウスドライバが無いと即終了する（「マウスドライバーが組み込まれて
   いません」）。Disk1 の `MOUSE.CO_` を展開して `AUTOEXEC.BAT` から実行
5. テストページを `<script type="module">` にしたら `var Module` が
   モジュールスコープに閉じて `dosbox-x.js` から見えなくなった。
   `window.Module` に代入すること

#### C: はホストのディレクトリのままでよい

心配していた「C: をディスクイメージ方式に作り直す大工事」は**不要だった**。
`MOUNT C <dir>` した状態で `BOOT` すると DOSBox-X がそのディレクトリを
FAT イメージに変換してゲストへ渡す:

```
Drive C is mounted as local directory /work/
Converting drive C: to FAT...
```

JW_CAD も辞書もホスト側に置いたまま、実 DOS から読める。

#### 構成

起動フロッピー `BOOTIME.IMG` は Disk1（パディング済み）から SETUP 関連を
消して作る。IO.SYS は動かさないこと（ブートセクタが先頭データクラスタに
あることを期待する）。作成スクリプトはリポジトリの
`scripts/make-msdos-boot.sh`（引数なし／`prompt`／`wxp` の3種類）。

```
A:  IO.SYS MSDOS.SYS COMMAND.COM
    BILING.SYS $FONT.SYS $DISP.SYS DOSVSYS.SYS $JPNZN16.FNT ...
    KKCFUNC.SYS MSIMEK.SYS MSIMEI.SYS MSIMED.SYS
    MOUSE.COM CONFIG.SYS AUTOEXEC.BAT
C:  (ホストのディレクトリ) MSIME.DIC MSIMER.DIC JWCAD\
```

`CONFIG.SYS` の順序は Disk1 のものに倣う:

```
device=\biling.sys
device=\$font.sys /u=0
device=\$disp.sys
device=\dosvsys.sys
device=\kkcfunc.sys
device=\msimek.sys
device=\msimei.sys
```

#### 到達点 — MSIME の日本語入力が通った

起動すると `KKCFUNC` と `マイクロソフトかな漢字変換 バージョン 2.51`、
`Microsoft Mouse Driver Version 7.04` が常駐し、DOS プロンプトに落ちる。
そこで `DIR` を打つと**エコーされて実行され**、出力も日本語で出る:

```
C>dir
 ドライブ C: のボリュームラベルは
 ディレクトリは C:\
JWCAD        <DIR>
MSIME    DIC     2048
MSIMER   DIC   629760
```

C: はホストのディレクトリのままで、`BOOT` が FAT に変換したものが見えている。

そこから **`Alt` + `` ` `` で MSIME が起きる**（最下行に
`部首 かな カナ 半角 英数 切替` のファンクションキーガイドが出る）。
`nihongo` と打つと **`にほんご`**、`Space` で **`日本語`** に変換される。
かな漢字変換が最後まで通っている。

検証は `(scratchpad)/prompt.mjs` + `.build/msdosprompt.html`。
JW_CAD を経由しないプロンプト専用の起動イメージ `BOOTPRMT.IMG` は
`scripts/make-msdos-boot.sh prompt` で作る。アプリ越しに見ると
「キーが届かない」のか「FEP が動かない」のか切り分けられないので、
先にこちらで確かめること。

#### 待ち条件を間違えないこと

このマシンではヘッドレスで **BOOT からプロンプトまで約5分**かかる。
起動完了の判定は3つ揃えて初めて成り立つ:

1. キャンバスが 640x480（DOS/V のグラフィックモード）になっている
2. 描画が3回続けて落ち着いている — ただし**カーソルが点滅するので
   完全一致では永久に成立しない。** 80 ピクセル程度の許容差で見る
3. 経過時間が最低 60 秒（JW_CAD 起動なら 90 秒）

どれか1つで判定すると必ず早撃ちになり、起動途中のゲストにキーを
撃ち込んで「固まった」と誤読する。

#### 「固まる」はすべて誤診だった — 原因は起動時間

以前ここには「MSIME を呼んだ瞬間に画面が止まる」と書いてあった。**そんな
事実はない。** 実際には**起動が終わる前にキーを撃っていた**だけだった。
ヘッドレスのこの環境では、BOOT からプロンプトまで **約 5 分（309 秒）**
かかる。テストは「画面が 2 回続けて変化しなければ起動完了」と見なして
いたので、DOSBox-X のバナーが出たまま止まっている時点で先へ進んでいた。

判定条件は3つ揃えること。**キャンバスが 640x480（DOS/V のグラフィック
モード）になっていること・描画が3回続けて落ち着いていること・経過時間が
最低 60 秒あること。** どれか1つでは必ず早撃ちする。

描画側も潔白だった。`dosbox_x_gfx_probe()`（`scripts/patch-dosbox-x.py`）
でフレームを数えると:

```
RENDER start=+26 busy=+0 end=+52 | GFX start=+0 ... | cpu=5c34:2db6
```

`RENDER_StartUpdate` は6秒あたり26回で一定、つまり**フレームクロックは
生きている**。`GFX_StartUpdate` が 0 なのは異常ではない —
`RENDER_StartUpdate` はスキャンラインが実際に変化したときにだけ遅延して
`GFX_StartUpdate` を呼ぶので、**0 は「ゲストが VRAM に何も書いていない」
としか言っていない。** 入力待ちの DOS アプリはまさにそうなる。

つまり `CALLBACK_Idle` から yield を外した件は `GFX_EndUpdate` には
波及していない。そちらを疑う必要はなかった。

**教訓**: 黒い画面・動かない画面は、それ自体では何も言っていない。
`lit` が変わらないことを「固まった」と読んだのが最初の誤りで、
そこから `GFX_EndUpdate` まで2段階にわたって間違った方向を追った。
数えられるものを数えるまでは判断しないこと。

#### WXP も動いた（2026-09-16）

**本物の MS-DOS 5.0/V の上なら WXP は素直に常駐する。** DOSBox-X 内蔵の
DOS では黙って読み込まれなかったもので、ここが最初の壁だった。

ただし配布されている WXP は **J-3100 版**で、東芝 J-3100 固有のキーと
BIOS コールを見ている。エミュレートしているのは PC/AT なので、常駐は
するがキーが一切届かない（`Alt`+`` ` `` でも何も起きない）。

決め手は `wxpdosv4.lzh` に入っている **`wxpdosv.exe`**。これは WXP 本体
ではなく、**J-3100 の BIOS コールをエミュレートする TSR**（たかぴゅう氏作、
`WXP for J-3100 on DOS/V Version 0.04`）。AUTOEXEC から常駐させると
101 キーボードの `Alt`+`` ` `` で FEP が起動する。

到達点:

```
Alt+`     → 最下行に WXP のガイド（切替 単漢字 文字種 文字幅 登録 補助 / 連 ローマ かな 全 学）
nihongo   → にほんご
Space     → 日本語
```

構成（`scripts/make-msdos-boot.sh wxp`）:

```
CONFIG.SYS  device=\wxp.sys /R /Z /H30 /CS /D1C:\JISHO01.DIC /D3C:\JISHO02.DIC
            device=\wxdp.sys
AUTOEXEC    a:\mouse
            a:\wxpdosv
```

辞書は 650K あってフロッピーに載らないので `/D1` `/D3` で C: を見せる。
`/R` ローマ字入力、`/Z` 全角、`/H30` バッファ、`/CS` シフトJIS。
検証は `(scratchpad)/wxp2.mjs` + `.build/msdoswxp.html`。

**WXP 本体（`wxp.sys` / `wxdp.sys` / 辞書）はリポジトリに入れないこと。**
再配布を禁じている（`third_party/wxpj31.lzh` は gitignore 済み）。

`wxpdosv` は別扱いでよい。**作者が明示的に権利を放棄している**
（`WXPDOSV.DOC`「権利は放棄しますんで、煮るなり焼くなりお好きなように
お使いください。」）ので、`third_party/wxpdosv4.lzh` として同梱済み。
同じ書庫の `wxpatch.com` は他者のパッチを元にしたものと書かれていて
この放棄の対象か不明だが、V-Text 用で今回の構成では使わない。

#### マウスを動かすとキーボードが死ぬ — INT 74h が 8042 を読まない

**本物の MS-DOS を起動しているときだけ起きる。** JW_CAD とは無関係で、
DOS プロンプトだけで再現する。JW_CAD で文字コマンド → 位置クリックの
あと何を打っても画面が変わらなかったのは、**全部これの影**だった。
FEP の問題でも描画の問題でもない。

##### 症状

```
マウス未使用で VER   sdl=+8 kbd=+8 drawn=+5   エコーされて実行される
移動だけ（ボタン無し） sdl=+0 kbd=+0 drawn=+0
移動後に VER         sdl=+8 kbd=+8 drawn=+0   1行も描かれない
```

**クリックではなく移動で壊れる。** CPU は正常に走り続けている。

##### 三段階で絞った

1. `auxdevice=none` にすると起きない → **PS/2 補助デバイスが原因**
2. カウンタ（`dosbox_x_gfx_probe`）→ AUX バイトが1個だけ入り、
   **IRQ12 はちゃんと上がっている**。その直後からゲストが
   **ポート 0x60 を二度と読まない**
3. 状態プローブ（`dosbox_x_kbd_probe` / `dosbox_x_pic_probe`）→ 詰まった瞬間:

```
8042: p60held=1 fromAux=1 queued=39 sched=0 kbdOn=1 auxOn=1 irq12en=1 p60=0x8
PIC : master irr=0x00 imr=0xf8 isr=0x00 | slave irr=0x00 imr=0x2c isr=0x00
```

AUX バイトが未読で居座り、キーが39個その後ろに溜まり、**配送予約はゼロ**。
割り込みコントローラは完全に空 — 要求も in-service も無い。つまり
**割り込みは上がって、取られて、EOI まで返っている。なのに 0x60 は
読まれていない。**

##### 原因

`INT74_Handler`（`src/ints/mouse.cpp`）は DOSBox-X 自前の INT 33h マウス層の
ハンドラで、**自分の内部イベントキューだけ**を処理して戻る。エミュレート
された 8042 は管轄外なので、ポート 0x60 に触らない。

ゲスト OS を起動してもこのベクタは生き残る（CPU プローブが `f000:cfa1` で
捉えた）。だからマウスを動かすと:

1. AUX バイトが 8042 の出力レジスタに入り、IRQ12 が上がる
2. DOSBox-X 自身の INT 74h ハンドラが走り、読まずに戻る
3. `p60changed` が下りない。**次のバイトは 0x60 が読まれたときにしか
   予約されない**（`read_p60()`）ので、以後のキーが全部そこで止まる

出力レジスタはキーボードと AUX で共用の**1バイト**しかない。これが要。

##### 対処

実機の BIOS の INT 74h ハンドラは必ずポート 0x60 からデータバイトを読む。
DOSBox-X のハンドラはその代役なのだから、同じことをすればよい
（`scripts/patch-dosbox-x.py` の `KEYBOARD_AUX_DrainPending`）。

ゲストが自分で INT 74h をフックしている場合は、そもそもこのハンドラが
走らない。つまりこれが走るのは「他に誰も読まない」場合だけなので、
影響範囲は限定される。

##### 外した仮説（記録として）

- 「画面の更新が止まっている」→ 違う。`RENDER_StartUpdate` は回り続けていた
- 「キーが届いていない」→ 違う。`kbd=+8` で鍵盤まで届いていた
- 「`CALLBACK_Idle` 系」→ 違う。`keyboard.cpp` にも `mouse.cpp` にも
  yield は無く、残る呼び出し元は PC-98 専用の経路だけ
- 「INT 15h が Enable AUX を出していないので IRQ12 が上がらない」→ 違う。
  `auxNoIrq=0`、IRQ12 は上がっていた。当てた修正は**戻した**
- 「EOI が返っていない」→ 違う。PIC は完全に空だった

**症状はどれも同じ顔をしている。数えられるものを数えるまで判断しないこと。**

#### 高DPIでマウスがずれ、画面が小さくなる（2026-09-16 に修正）

**ユーザ環境で再現し、こちらの環境では再現しなかったバグ。** 原因は
ディスプレイの拡大率（Windows の 125% / 150% / 200% など）。

`SDL_CreateWindow` に `SDL_WINDOW_ALLOW_HIGHDPI` が付いていると
（`dpi_aware_enable` が既定で有効、`src/gui/sdlmain.cpp:1885`）、
Emscripten の SDL2 がキャンバスのバッキングストアを devicePixelRatio 倍に
する。するとウィンドウがゲスト画面よりずっと大きくなり、DOSBox-X は
その中央に 640x480 を**等倍のまま**置く。結果:

| | devicePixelRatio 2 のとき | 修正後 |
|---|---|---|
| バッキングストア | 2560x2560 | 640x480 |
| クリップ矩形 | 320,400,640,480 | 0,0,640,480 |
| 位置誤差 | 最大 279px | 0〜2px |
| 見た目 | 1280x1280 の中央に等倍 | ウィンドウいっぱい |

**「マウスがずれる」と「画面が小さい」は同じバグ**だった。

対処は設定だけで済む（再ビルド不要）:

```ini
[dosbox]
dpi aware=false      ; 注意: [sdl] ではなく [dosbox] セクション
[sdl]
windowresolution=original
```

`dpi aware` を `[sdl]` に書いても黙って無視される（`src/dosbox.cpp:1690` で
`secprop` は "dosbox"）。

**教訓**: 拡大率 100% でしか測っていなかったので、ずっと「0〜2px で
合っている」と見えていた。ユーザ環境固有の条件は、再現条件を変えて
測るまで「直った」と言わないこと。検証は
`(scratchpad)/mouse.mjs`（第3引数に viewport 幅、第4引数に
devicePixelRatio を取る）。

#### キーはクリック後もちゃんと届いている

JW_CAD で文字コマンド → 位置クリックのあと、何を打っても画面が
変わらない。これを一度「キーが届いていない」と書きかけたが、**誤り**。
`dosbox_x_gfx_probe()` のカウンタで数えると:

```
Shift+A  sdl=+4  kbd=+4    ← 効く（画面も変わる）
click    sdl=+0  kbd=+0
romaji   sdl=+14 kbd=+14   ← 7文字×(押下+解放)、全部通っている
escape   sdl=+2  kbd=+2
```

`sdl` は SDL がイベントを受けた回数、`kbd` は `KEYBOARD_AddKey()` に
渡った回数。**両方増えているので、キーはエミュレート鍵盤まで届いている。**
ゲストが受け取ったうえで何も描いていない、というのが正しい症状。

プロンプトでは同じ MSIME が `にほんご` → `日本語` まで動くので、
差は「JW_CAD がグラフィックモードにいること」。次はそこを追う。

#### 素材（いずれも gitignore 済み）

`.build/msdos/` に Disk1〜3、パディング済みの `_full`、起動用 `BOOTIME.IMG`。
`.build/msime/` に展開済みの MSIME と DOS/V ドライバ。
`.build/exc/` に例外有効ビルドの dosbox-x。
MS-DOS は Microsoft の商用ソフトなので公開リポジトリには置けない。

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

---

## 11. 図面を SVG / PDF で取り出す（着手、未完）2026-09-17

**狙い**: JW_CAD のプロッタ出力を捕まえて SVG / PDF にする。実用性が一段
上がる。ラスタ印刷より質が高くできる見込みがある。

### 書式は解読済み — 出力する文字列をこちらで決められる

プロッタ出力は**プロッタ設定ファイル（`.JWP`）**にしたがう。これは実質
テンプレートで、命令ごとの出力文字列を自由に定義できる。`JWP.DOC` に全仕様、
`SAMPLE.JWP` に HP-GL 版の実例がある。ドキュメント自身が最小形を例示している:

```
MOVE =M [1][2]\n
DRAW =D [1][2]\n
```

`M ` `D ` はそのまま送られ、`[1]` `[2]` が座標に置き換わる。**HP-GL を解読
する必要はない。**

使える引数（`JWP.DOC` より）:

| 命令 | 主な引数 |
|---|---|
| `MOVE` / `DRAW` | `[1][2]` 座標 |
| `CIRCLE` | `[1][2]`中心 `[3]`半径 `[4]`開始角 `[5]`終了角 |
| `POINT` | `[1][2]` |
| `ANK` / `KANA` | `[1][2]`左下 `[3][4]`サイズ `[9%f]`回転角 `[A%c]`文字コード |
| `KANJI` | 同上 + `[C%c][D%c]` **シフトJISのバイト** |
| `PEN_1..6` / `LTYP_1..8` | ペンと線種 |
| `INIT2` / `TERM` | `[1]-[4]` 図面範囲、`[5%s]` 用紙名 |

**文字がコードのまま取れる**のが大きい。PDF にしたとき検索もコピーもできる
本物の文字にできる。

自前の定義ファイルは **`web/wasm.jwp`**。1命令1行、文字コードは行末
（ANK は 0x21-0x7f、シフトJIS の2バイト目も改行を含まないので行で切れる）。
**ASCII のみで書くこと** — DOS はシフトJISで読むので、UTF-8 で書くと
JW_CAD のファイル選択画面で説明文が化ける（一度やった）。

### 操作手順（ここまで判明）

```
入出力(q) → 2(プロッタ) → 3(ファイル出力)
→ 定義ファイルをクリックして選択 → もう一度クリックで確定
→ 「出力ファイル名 ?」 に名前 + Enter
→ 設定画面（破線ピッチ・鎖線・速さ）→ 上部バーの「1)確定」で出力開始
```

**最後の「1)確定」に届いていない。** 上部バーの項目は**キーではなく
クリック**で選ぶ（`1` キーを押しても選択画面のままだった）。

### 詰まっている理由

**同じ操作列でも画面遷移が毎回違う。** `lit` の推移が run ごとに変わり、
座標クリックが当たったり外れたりする。当てずっぽうのクリックでは収束しない。

次にやるなら、クリックの前に**画面を撮って現在地を確認してから座標を決める**
（各ステップで OCR 的に上部バーを読む、あるいは段階ごとに人が一度確認する）。
1回の試行が約2分なので、盲目的な反復は割に合わない。

### やってはいけないと分かったこと

- **配布されているネイティブ版で代用しようとしない。** 速さに引かれて試したが
  2つの意味で筋が悪い。(1) この ARM64 Windows では起動すらしなかった
  （`configuration tool theme` の警告の直後で停止、設定ファイル・作業
  ディレクトリ・ビデオドライバのどれを変えても同じ）。(2) 仮に動いても、
  昨日直した修正は**こちらのパッチ済みビルドにしか入っていない**ので、
  そこで調べたことは移植できない。

  ネイティブを使うなら**こちらのソース（`/opt/dosbox-x`）からビルドする**の
  が本来の形。ただし Windows 版を作っても (1) の起動しない問題は環境側なので
  たぶん直らない。やるなら **WSL 上で Linux 版をビルドして Xvfb で動かす**。
  利用者のデスクトップにも触らずに済む。ビルド依存の導入から込みで数時間。

  **ただし今の律速は速度ではない。** 詰まっているのは「同じ操作列でも画面
  遷移が毎回変わり、座標クリックが当たらない」ことで、エミュレータが速く
  なっても当たらないクリックは当たらない。先に効くのは観測性の方
- **`SDL_VIDEODRIVER=dummy` は窓を消さない。** SDL の描画窓は消えるが
  DOSBox-X が Win32 のメッセージボックスで出す警告は素通りする。
  `--help` もダイアログで止まる。利用者のデスクトップを共有している
- **`?open=NAME.JWC` で起動時に図面を読ませない。** 実装したらレンダラごと
  クラッシュした。起動4秒後の最初の測定で既に死んでおり、JW_CAD が動き出す
  前、DOSBox-X の起動中。ファイル名も図面の大きさも無関係で、**理由は不明**。
  撤回済み（`git show 136c3aa`）

### 図面を用意する方法

`?open=` が使えないので、**線を引いて**中身を作る。`Shift`+`X` が線コマンドで、
2点クリックで1本。4本引いて矩形にするのは実績あり（左上のカウンタが
「線 4」になる）。

### 段取り（ここから）

1. 「1)確定」まで到達して**出力ファイルを1つ採取する**
2. そのファイル相手に**変換部をオフラインで開発**（エミュレータ不要、数秒/回）。
   作業量の大半はここ
3. ページにダウンロードを付ける

捕まえ方は2通り用意してある。ファイル出力（C: に直接書かれる）と、
プリンタポート出力（`[parallel] parallel1=file file:C:\PLOT.PRN timeout:2000`
を設定済み）。前者の方が確実。

---

## 10. 今日の判断と、診断のしかた（2026-09-16）

### MS-DOS 路線は「動いたが、使わない」

利用者の zip から**ブラウザの中だけで起動フロッピーを組み立てて**、本物の
MS-DOS 5.0/V を起動し、MSIME で `にほんご` → `日本語` まで通した。WXP も
`wxpdosv.exe` を入れれば同じところまで動いた。技術的には最後まで通っている。

取り下げたのは**マウス**（2節の原因3）。CAD で位置が合わないのは致命的で、
日本語入力だけ本物になっても割に合わない。**利用者の判断**で取り下げた。

再開するなら必要なものは全部残っている:

- 組み立て手順は下の「手順のメモ」と `scripts/make-msdos-boot.sh`
- ブラウザ内での組み立ては `git show dd1386b` に完全な実装がある
  （zip 読み取り `web/zip.js`、`PREP.BAT` の生成、`msdosConf()`）
- **FAT12 の書き込みも SZDD の展開も自前で書く必要はない。**
  前者は DOSBox-X の DOS に `IMGMOUNT` / `COPY` / `DEL` でやらせ、
  後者は MS-DOS 自身の `EXPAND.EXE`（Disk1 にある）を使う。
  ブラウザ側は zip の展開と 1,474,560 バイトへのパディングだけ
- **先に解くべきはマウス**。それが解けない限り作図には使えない

### 診断の心得（今日、私は5回外した）

同じ「反応しない画面」が、毎回まったく違う原因だった。順に:

1. 「画面の更新が止まっている」→ 違う。`RENDER_StartUpdate` は回り続けていた
2. 「キーが届いていない」→ 違う。`kbd=+14` で鍵盤まで届いていた
3. 「`CALLBACK_Idle` 系」→ 違う。該当経路に yield が無い
4. 「INT 15h が Enable AUX を出していない」→ 違う。IRQ12 は上がっていた
5. 「EOI が返っていない」→ 違う。PIC は完全に空だった

6回目で当たった（INT 74h が 8042 を読まない）。**症状からは区別がつかない。**

効いたのは、推測をやめて**数えられるものを数えたこと**。カウンタと状態
プローブは `scripts/patch-dosbox-x.py` に入れてある:

| エクスポート | 何が見えるか |
|---|---|
| `dosbox_x_gfx_probe` | フレーム数、SDL キーイベント数、鍵盤に入った数、ポート 0x60 の読み取り数 |
| `dosbox_x_kbd_probe` | 8042 の未読バイト・溜まった数・配送予約・各種有効フラグ |
| `dosbox_x_pic_probe` | 割り込みコントローラの要求・マスク・in-service |
| `dosbox_x_cpu_probe` / `dosbox_x_callback_at` | CPU の位置と、コールバック領域なら**その名前** |
| `dosbox_x_mouse_probe` | clip 矩形・ホストポインタ・ゲストカーソル |

**推測で直したものは、効かなかったと分かった時点でツリーから戻すこと。**
今日は2回（INT 15h の Enable AUX、INT 33h の存続）そうした。

### ヘッドレス検証で外しやすいところ

- **起動完了の判定**は3つ揃えて初めて成り立つ（4節の「待ち条件」）。
  1つで判定すると起動途中にキーを撃ち込んで「固まった」と誤読する
- **カーソルが点滅する**ので、描画の落ち着きを完全一致で見ると永久に成立しない。
  80 ピクセル程度の許容差で見る
- ビルドと MS-DOS 起動を同時に走らせると**ブラウザのタブごとクラッシュする**
  （`Target crashed`）。メモリの取り合い。順番に流すこと
- `pkill -9 -f headless_shell` は**自分自身にマッチして巻き添えにする**。
  `[h]eadless_shell` と書く
