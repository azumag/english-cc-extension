# English CC Extension 引き継ぎ文書

最終更新: 2026-08-16 (JST)

## 0. 最初に確認すること

このプロジェクトは、**初期実装と自動テストまでは完了していますが、Chrome・OBS・Twitchを接続した実機確認はまだ完了していません**。

次の担当者は、機能追加より先に [`docs/manual-test.md`](manual-test.md) のPhase 0を実行してください。実機確認を終えるまでは、MVP完成・Twitch対応完了とは扱わないでください。

| 項目 | 現状 |
|---|---|
| リポジトリ | `azumag/english-cc-extension` |
| 基準ブランチ | `main` |
| 親Issue | #1 |
| 初期実装コミット | `58c1ec5bffe4fbc336000e48dbd6cb628238bb43` |
| 拡張バージョン | `0.1.0` |
| 自動テスト | GitHub Actionsで成功 |
| 実機テスト | 未実施 |
| 第一対象 | Windows x64 / Google Chrome 138以降 / OBS Studio 28以降 |

## 1. 目的

日本語で話した配信者のマイク音声をChromeで認識し、Chrome内蔵Translator APIで英訳して、OBS WebSocket経由でTwitch公式クローズドキャプションへ送ります。

```text
配信用マイク
  -> Chrome Web Speech API (ja-JP)
  -> Chrome Translator API (ja -> en)
  -> 字幕整形・重複排除・期限管理
  -> OBS WebSocket SendStreamCaption
  -> OBS配信出力
  -> Twitch公式CC
```

Twitchへ送るのは**英訳済み字幕だけ**です。日本語字幕や翻訳失敗時の原文は送りません。映像への字幕焼き込みも行いません。

## 2. MVPで意図的に扱わないもの

初期実装では次を対象外にしています。

- dociaiとの連携
- Electronアプリやlocalhost中継サーバー
- Whisper、LocalVocal、CUDA
- DeepL、Google Cloud Translationなどの外部翻訳API
- Twitch OAuth、Cookie、Twitchタブ操作
- Content Script
- 多言語字幕トラック
- 字幕の映像焼き込み
- サイドパネルを閉じた後も続くバックグラウンド処理
- Chrome Web Storeへの公開・署名・アイコン整備
- macOS、Linuxでの動作保証

本リポジトリは、`azumag/dociai` Issue #282の統合版とは独立した実装です。

## 3. 現在のアーキテクチャ

### 3.1 ライフサイクル

MVPでは、サイドパネルがComposition Rootです。マイク、音声認識、翻訳、字幕キュー、OBS接続をすべてサイドパネルの生存期間内で管理します。

```text
拡張アイコンを押す
  -> Service WorkerがSide Panelを開く
  -> Side Panelが設定を復元
  -> マイク一覧・Translator対応状況を確認

「英語CCを開始」
  -> 設定とOBSパスワードを保存
  -> 必要ならOBSへ接続
  -> Translatorを初期化
  -> マイクを取得
  -> SpeechRecognitionを開始
  -> final認識結果だけ字幕キューへ投入
  -> 英訳
  -> CaptionPolicyで検査・分割
  -> OBSの配信状態・マイクミュートを確認
  -> SendStreamCaption

「停止」またはSide Panelを閉じる
  -> 新規字幕受付停止
  -> 待機字幕を破棄
  -> SpeechRecognition停止
  -> MediaStreamTrack停止
  -> Translator破棄
  -> OBS WebSocket切断
```

### 3.2 送信条件

通常字幕は、次をすべて満たす場合だけ送信します。

- サイドパネル側のCC処理がON
- 音声認識結果が`final`
- 翻訳結果が空でない
- 翻訳結果に日本語文字が残っていない
- 直前に送った字幕と同一でない
- 認識確定から`maxAgeMs`を超えていない
- OBS WebSocketに接続済み
- OBSが配信中
- OBSマイク入力名を設定した場合、その入力がミュートされていない

「テスト字幕」はマイクミュート判定のみ迂回します。OBSが配信中であることは引き続き必要です。

## 4. 主要ファイル

| パス | 責務 |
|---|---|
| `manifest.json` | Manifest V3、Side Panel、最小権限、CSP |
| `src/background/service-worker.js` | 拡張アイコンからSide Panelを開く設定のみ |
| `src/sidepanel/sidepanel.html` | 操作画面 |
| `src/sidepanel/sidepanel.css` | 操作画面のスタイル |
| `src/sidepanel/sidepanel.js` | UI、各サービスの生成、開始・停止、状態表示を統合するComposition Root |
| `src/speech/speech-recognizer.js` | マイク取得、入力一覧、SpeechRecognition、終了後の再開 |
| `src/translation/chrome-translator.js` | Translator APIの可用性確認、初期化、ダウンロード進捗、翻訳 |
| `src/captions/caption-queue.js` | 1件ずつ処理する有界FIFO、期限切れ・overflow処理 |
| `src/captions/caption-policy.js` | 正規化、日本語混入拒否、重複排除、置換、長文分割 |
| `src/captions/caption-pacer.js` | 分割字幕・連続発話間の送信間隔（ペーシング） |
| `src/obs/obs-websocket-client.js` | obs-websocket 5.x接続、認証、request/response管理 |
| `src/obs/obs-caption-output.js` | OBSバージョン確認、配信・ミュート判定、字幕送信 |
| `src/settings/settings-store.js` | 通常設定とOBSパスワードの保存境界 |
| `src/shared/contracts.js` | 設定既定値・正規化・localhost制約 |
| `src/shared/errors.js` | OBS関連のエラー型 |
| `src/shared/logger.js` | サイドパネル内だけのリングログ |
| `tests/` | Node.js unit test |
| `scripts/check-syntax.mjs` | 全JavaScriptファイルの構文検査 |
| `.github/workflows/test.yml` | GitHub Actions |
| `docs/manual-test.md` | Chrome・OBS・Twitch実機用チェックリスト |

## 5. 設定と既定値

正典は `src/shared/contracts.js` です。

| 設定 | 既定値 | 備考 |
|---|---:|---|
| `recognitionLanguage` | `ja-JP` | 現UIでは固定 |
| `targetLanguage` | `en` | 現UIでは固定 |
| `microphoneDeviceId` | 空 | 空なら既定マイク |
| `obsHost` | `127.0.0.1` | `127.0.0.1`または`localhost`のみ許可 |
| `obsPort` | `4455` | 1〜65535 |
| `obsMicrophoneInputName` | 空 | 空ならOBS側ミュート判定をしない |
| `maxPending` | `2` | 1〜10。処理中の1件は別枠 |
| `maxAgeMs` | `5000` | 500〜30000ms |
| `maxCaptionChars` | `72` | 暫定値。実機確認後に確定する |
| `segmentIntervalMs` | `1500` | 0〜10000ms。分割字幕・連続発話間の送信間隔。`0`で無効化。暫定値 |
| `replacements` | `{}` | 英訳後に適用する完全一致部分置換 |
| `logCaptions` | `false` | 将来用。現在のUIでは本文永続ログを行わない |
| `obsPasswordPersistLocal` | `false` | opt-in。trueかつユーザーが警告文に同意した場合のみOBSパスワードを`chrome.storage.local`にも保存する |

### 保存場所

- 通常設定: `chrome.storage.local`
- OBS WebSocketパスワード: 既定は`chrome.storage.session`のみ。`obsPasswordPersistLocal=true`のopt-in時のみ`chrome.storage.local`にも平文でミラー保存する（`src/settings/settings-store.js`）
- `chrome`自体が使えないテスト環境（`globalThis.chrome`未定義）: メモリのみ。`obsPasswordPersistLocal`は無視される
- `chrome.storage.local`はあるが`chrome.storage.session`だけ使えない環境（実Chrome 138以降では起こらない想定）: 生存中の値はメモリにフォールバックするが、`persistLocal`のlocalミラー書き込み自体は独立して動くため、その場合は書き込まれたlocalの値を`loadObsPassword()`が読みに行かない非対称が残る
- 日本語認識結果・英訳結果: 永続保存しない
- イベントログ: サイドパネルのメモリ内のみ

既定（`obsPasswordPersistLocal=false`）ではChromeを再起動するとOBSパスワードは消えます。opt-inした場合のみ再起動後も保持されます。「このデバイスに保存する」チェックボックスはON/OFFどちらも`change`イベントで即座に`persistSettings()`（設定全体の保存＋`saveObsPassword`）を呼びます。「設定を保存」ボタンを別途押すのを待ちません。チェックを外した瞬間に`chrome.storage.local`側のコピーが消去されるのはこの経路によるもので、設定オブジェクト内の`obsPasswordPersistLocal`フラグと実際の`chrome.storage.local`の保存状態が食い違ったまま残ることを防ぎます。localのみを消去する`removeLocalObsPassword()`（`src/settings/settings-store.js`）はテスト・将来のUIから利用できるよう公開していますが、現在のサイドパネルUIからは直接呼んでいません。

## 6. セキュリティ上の不変条件

変更時も次を維持してください。

1. OBS接続先を`127.0.0.1`または`localhost`以外に広げない。
2. OBSパスワードを、ユーザーが警告文に明示的に同意してopt-inした場合（`obsPasswordPersistLocal=true`）を除き`chrome.storage.local`へ保存しない。`chrome.storage.sync`へはいかなる場合も保存しない。既定値は常にOFF。opt-inをOFFへ戻したら保存済みパスワードを即時に消去する。
3. 認識原文・翻訳文を既定で永続保存しない。
4. 翻訳失敗時に日本語原文をTwitchへ送らない。
5. TwitchのCookie、OAuth、タブ、閲覧履歴権限を要求しない。
6. `--disable-web-security`、remote debuggingなどの危険な回避策を使わない。
7. OBS未接続・未配信・状態確認失敗時はfail closedで字幕を送らない。
8. 字幕機能の失敗でOBS配信そのものを停止しない。
9. 権限追加が必要な場合は、用途と代替案をIssueまたはPRに記録する。

## 7. 自動検証済みの範囲

初期実装コミット時点では、GitHub Actionsの`test`ワークフローが成功しています。

```bash
npm install
npm test
```

`npm test`は次を実行します。

```text
node --test
node scripts/check-syntax.mjs
```

初期実装では、17件のNode.jsテストと19ファイルの構文検査が成功しました。

主な自動テスト対象:

- Manifestの権限と基本構造
- OBS challenge-response認証値
- OBS配信中・未配信・マイクミュート時の送出判定
- CaptionPolicyの正規化、日本語拒否、重複排除、分割
- CaptionQueueの順序、overflow、期限切れ
- Translator wrapperの初期化・翻訳・空結果処理

自動テストは実Chromeの組み込みAPI、実OBS、実Twitchを保証しません。

## 8. 未検証の範囲

以下は、コードが存在していても実機で成立するか未確認です。

### Chrome

- Side Panelで`getUserMedia()`の許可を取得できるか
- マイク一覧とラベルが取得できるか
- `SpeechRecognition`が拡張ページ内で動くか
- `SpeechRecognition.start(MediaStreamTrack)`で選択マイクを使えるか
- 非対応時にブラウザ既定マイクへ安全にフォールバックできるか
- `onend`後の再開が長時間安定するか
- Translator APIが拡張ページで利用できるか
- 初回言語パックのダウンロード進捗が取得できるか
- `chrome.storage.session`が想定どおり機能するか

### OBS

- Chrome拡張から`ws://127.0.0.1:4455`へ接続できるか
- パスワードありのchallenge-response認証が通るか
- `GetVersion.availableRequests`に`SendStreamCaption`が含まれるか
- `GetStreamStatus`と`GetInputMute`のフィールドが実OBSと一致するか
- `SendStreamCaption`が実際の配信出力へ載るか

### Twitch

- ライブプレーヤーにCCボタンが表示されるか
- PCブラウザ、iPhone、Androidで字幕を切り替えられるか
- VODに字幕が残るか
- CEA-608で安全に扱える文字種
- 1字幕あたりの安全な文字数
- 分割字幕を送る安全な間隔

### 長時間運用

- 2時間連続で音声認識と翻訳が回復可能か
- OBS切断・再接続後に古い字幕が流れないか
- サイドパネルを閉じた際にマイク利用が確実に止まるか
- Chromeのスリープ・省メモリ・タブ切替の影響

詳細なチェック欄は [`docs/manual-test.md`](manual-test.md) にあります。

## 9. 現時点で注意すべき実装リスク

以下は確定バグではなく、実機確認または本番化の際に優先して確認する箇所です。

### 9.1 選択マイクの扱い

`SpeechRecognizer`は選択した`MediaStreamTrack`を`recognition.start(track)`へ渡し、失敗した場合は引数なしの`start()`へフォールバックします。

Chrome側がトラック指定を実装していない場合、画面上で選択したマイクと、実際に音声認識が聞くOS既定マイクが異なる可能性があります。ステータス表示の「聞き取り中（選択マイク）」または「既定マイクへ切替」を必ず確認してください。

### 9.2 恒久的な音声認識エラーの再開

現在は`onend`後に指数バックオフで再開しますが、`not-allowed`など再試行しても直らないエラーの分類はまだありません。権限拒否時に再試行ループになる場合は、fatal errorを分類して停止してください。

### 9.3 OBS自動再接続

OBS WebSocketクライアントには切断検出がありますが、自動再接続は未実装です。現状はサイドパネルから手動で再接続します。

本番化する場合は、古い字幕キューを破棄したうえで、上限付き指数バックオフを追加してください。

### 9.4 分割字幕の送信間隔（対応済み・実機値は未確定）

`src/captions/caption-pacer.js`の`CaptionPacer`が`ObsCaptionOutput`を薄くラップし、前回**送信成功**時刻からの経過が`segmentIntervalMs`未満なら待機してから送信するようになりました。`sidepanel.js`の`createCaptionPipeline`でセグメント送信ループに組み込み済みです。間隔はセグメント間だけでなく、連続する確定発話間にも自然に効きます（`lastSentAt`をパイプライン生存期間で保持するため）。

設定は`segmentIntervalMs`（`src/shared/contracts.js`、既定`1500`ms、`0`で無効化、範囲`0〜10000`）。`clock`/`wait`を注入できるため、`tests/caption-pacer.test.js`は実sleepを使わずに検証しています。

`CaptionPacer`は`shouldAbort`コールバックも受け付けます。待機（wait）は最大`segmentIntervalMs`かかるため、待機中にCC停止・Side Panel終了などで`state.running`がfalseになるケースを、待機直後・実送信直前に再チェックして`{ sent: false, reason: "aborted" }`で打ち切ります。これがないと、停止操作から最大`segmentIntervalMs`分遅れて字幕が1件だけ配信に載ってしまいます。

残タスクは実機のみです。Twitch上で複数セグメントが確実に読める安全な間隔は未計測のため、`segmentIntervalMs`の既定値`1500ms`はPhase 0実測で確定してください。待機中に`maxAgeMs`超過で後続キュー項目が`expired`落ちしやすくなる点は意図した挙動です（14節「最新字幕を優先し、遅れた字幕を後からまとめて送らない」）。

同じ理由で、1件の長い発話が`maxCaptionChars`超で複数セグメントに分割された場合、各セグメントの期限判定は元発話の`createdAt`を基準にする（`caption-policy.js`の`prepare()`）ため、`segmentIntervalMs`による待機が積み重なると**同一発話の後半セグメントだけが`expired`で送られない**ことがあります（目安: ソース文が概ね120文字を超えるとチャンク数が4件前後になり、既定値`1500ms`の累積待機が`maxAgeMs`既定`5000ms`に近づく）。これも14節の方針どおりの意図した挙動ですが、体感としては「後続キュー項目の破棄」とは別の現象（同一字幕の尻切れ）なので、実機確認時は区別して記録してください。

### 9.5 CEA-608文字集合

現在は制御文字と日本語を拒否し、スマートクォートなど一部記号をASCIIへ正規化していますが、CEA-608で安全な文字集合へ厳密には制限していません。絵文字、特殊記号、アクセント付き文字などは実機確認が必要です。

### 9.6 OBS状態取得の回数

通常字幕の各セグメント送信前に`GetStreamStatus`と、設定時は`GetInputMute`を呼びます。サイドパネル表示用にも2.5秒ごとに状態を取得します。

まずは安全優先の実装ですが、実測で遅延が大きい場合はOBSイベント購読または短寿命キャッシュを検討してください。その際も送出直前のfail closed特性を失わないようにします。

### 9.7 再接続失敗時の状態整理

OBS再接続処理を変更する場合、古い`ObsCaptionOutput`やタイマーを残さないことを確認してください。接続失敗後に以前のclientを参照し続けないよう、状態遷移テストを追加するのが望ましいです。

`connectObs()`は再接続のたびに`state.pacer?.setOutput(state.output)`を呼び、CC実行中に手動で「OBSへ接続」を押した場合でも`CaptionPacer`が古い（切断済みの）`ObsCaptionOutput`を握り続けないようにしています。`ObsCaptionOutput.initialize()`が失敗する場合に備えて、`setOutput`は`initialize()`より前（`state.output`の代入直後）に呼ぶ配置にしてあります。この配線を変更する場合は`tests/caption-pacer.test.js`の`setOutput()`関連テストを参照してください。

### 9.8 Side Panel終了イベント

現在は`beforeunload`でマイク、Translator、OBSを解放します。ChromeがSide Panelを閉じたときに必ず期待どおり呼ばれるか実機確認が必要です。

## 10. 次の担当者が行う作業順

### Step 1: 基準状態を確認

```bash
git clone https://github.com/azumag/english-cc-extension.git
cd english-cc-extension
npm install
npm test
```

テスト失敗があれば、実機確認へ進む前に解消します。

### Step 2: unpacked拡張として読み込む

1. `chrome://extensions`を開く。
2. デベロッパーモードをONにする。
3. 「パッケージ化されていない拡張機能を読み込む」でリポジトリルートを選ぶ。
4. 拡張アイコンからSide Panelを開く。
5. Side PanelのDevToolsと、`chrome://extensions`にあるService WorkerのDevToolsを開ける状態にする。

### Step 3: Chrome単体を確認

1. 「更新・許可」でマイク権限を与える。
2. 配信用マイクが一覧に出ることを確認する。
3. Translatorの状態を確認する。
4. 必要なら言語パックをダウンロードする。
5. OBS送信前に、日本語認識と英訳プレビューが更新されるか確認する。
6. 選択マイクが本当に使われているか、別マイクを鳴らして判別する。

### Step 4: OBS接続を確認

1. OBSの「ツール → WebSocketサーバー設定」でサーバーを有効化する。
2. パスワード認証を有効化する。
3. 拡張から`127.0.0.1:4455`へ接続する。
4. OBSでテスト配信を開始する。
5. 「テスト字幕」を送る。
6. 失敗時はSide Panelログ、DevTools Console、OBSログを保存する。

### Step 5: Twitchで確認

1. Twitchへテスト配信する。
2. PCブラウザでCCボタンとテスト字幕を確認する。
3. 日本語で話し、英語だけが表示されることを確認する。
4. OBSの対象マイクをミュートし、字幕が止まることを確認する。
5. 配信停止時に字幕送信が止まることを確認する。
6. iPhone、Android、VODを確認する。

### Step 6: 結果を記録

- `docs/manual-test.md`へ結果を追記する。
- Chrome、OBS、OS、端末のバージョンを記録する。
- 遅延、文字数、文字化け、字幕間隔を具体的に記録する。
- Issue #1へ成功項目、失敗項目、再現手順、ログをコメントする。
- 実装変更が必要なら、Phase 0の観測結果を根拠に小さく修正する。

## 11. 推奨する優先順位

### P0: 中核経路の成立

- Side Panelでマイク・SpeechRecognitionが動く
- Translator APIで`ja -> en`が動く
- OBS WebSocket認証が通る
- `SendStreamCaption`がTwitchに届く
- 日本語原文が送られない

P0が成立しない場合は、機能を膨らませずIssue #1にある代替案を再評価してください。

### P1: 配信中の安全性

- 音声認識fatal errorの分類
- OBS自動再接続
- 字幕送信ペーシング（実装済み、実機での間隔確定が残タスク。9.4参照）
- CEA-608安全文字の正規化
- 長時間テスト
- 状態遷移テスト
- エラー表示と再試行UX

### P2: 利便性

- Offscreen Documentによるバックグラウンド化
- Chrome端末内音声認識モード
- OBS入力一覧の自動取得
- 設定インポート・エクスポート
- アイコン、パッケージ、Chrome Web Store準備
- macOS/Linux検証

P2へ進む前にP0とP1の主要項目を終えるのが安全です。

## 12. トラブルシューティング

### Side Panelが開かない

- `chrome://extensions`で拡張エラーを確認する。
- 拡張を再読み込みする。
- Service WorkerのConsoleを確認する。
- `manifest.json`の`side_panel.default_path`を確認する。

### マイク名が表示されない

マイク権限付与前はデバイスラベルが空になることがあります。「更新・許可」を押した後に一覧を更新してください。

### 選択したマイクを認識していない

ステータスが「既定マイクへ切替」になっていないか確認します。Chromeが`start(track)`に対応していない場合は、OSまたはChromeの既定マイクを配信用マイクへ変更する必要があります。

### Translatorが利用不可

- Chromeのバージョンを確認する。
- Side PanelのConsoleで`Translator`の存在と`availability()`の戻り値を確認する。
- 初回ダウンロードに必要なネットワーク接続と空き容量を確認する。
- Chrome本体では動くが拡張ページでは動かない場合、その差をIssue #1へ記録する。

### OBSへ接続できない

- OBS WebSocketサーバーが有効か確認する。
- ホストが`127.0.0.1`または`localhost`か確認する。
- ポートがOBS設定と一致するか確認する。
- パスワードを再入力する。
- OBS側ログとWebSocket close codeを確認する。

### テスト字幕が送れない

- OBSが実際に配信中か確認する。録画のみでは`GetStreamStatus.outputActive`がfalseになる可能性があります。
- `GetVersion.availableRequests`に`SendStreamCaption`があるか確認する。
- Side Panelログに`obs-not-streaming`、`obs-disconnected`などの理由がないか確認する。

### TwitchにCCボタンが出ない

まず音声認識・翻訳を切り離し、「テスト字幕」だけで確認します。OBSへのリクエスト成功と、Twitch側での受信は別段階です。OBSバージョン、配信方式、Twitchプレーヤー、視聴端末を記録してください。

### 英訳が破棄される

イベントログの理由を確認します。

- `contains-japanese`: 翻訳結果に日本語が残った
- `duplicate`: 直前字幕と同一
- `expired`: 翻訳・送信までに`maxAgeMs`を超過
- `overflow`: 待機字幕が`maxPending`を超過
- `microphone-muted`: OBSの対象入力がミュート
- `obs-not-streaming`: OBS未配信

## 13. 変更時の検証ルール

コード変更時は最低限、次を行ってください。

```bash
npm test
```

加えて、変更箇所に対応するunit testを追加します。

- 字幕ポリシー変更: `tests/caption-policy.test.js`
- キュー変更: `tests/caption-queue.test.js`
- 送信ペーシング変更: `tests/caption-pacer.test.js`
- OBS認証・プロトコル変更: `tests/obs-auth.test.js`など
- OBS送出条件変更: `tests/obs-caption-output.test.js`
- Translator wrapper変更: `tests/chrome-translator.test.js`
- Manifest権限変更: `tests/manifest.test.js`
- 設定・OBSパスワード保存境界の変更: `tests/settings-store.test.js`

Chrome APIの実挙動に関わる修正は、unit testだけで完了扱いにせず、`docs/manual-test.md`の関連項目も再実行してください。

## 14. 実装方針として維持したい判断

- まず中核経路を実機で成立させ、Offscreen Documentなどの複雑化は後にする。
- 外部依存・ビルド工程を増やす前に、標準Web APIと小さな純粋モジュールで解決する。
- Service Workerへ長時間処理を置かず、MVPではSide Panelの寿命と処理の寿命を一致させる。
- Twitchへ直接接続せず、字幕送出はOBSの配信出力へ任せる。
- OBS状態が不明な場合は送信しない。
- 最新字幕を優先し、遅れた字幕を後からまとめて送らない。
- 翻訳できない場合は日本語原文を送らない。
- 秘密情報と字幕本文を必要以上に保存しない。
- 実機差がある箇所は推測で固定せず、Phase 0の観測結果を残してから決める。

## 15. MVP完了条件

最低限、次を満たしてからIssue #1のMVPを完了扱いにします。

- [ ] Windows x64上の対象Chromeで拡張を読み込める
- [ ] 配信用マイクの日本語音声を認識できる
- [ ] 日本語から英語へ翻訳できる
- [ ] OBS WebSocketへ認証付きで接続できる
- [ ] OBS配信中にTwitch公式CCへ英語字幕を送れる
- [ ] 日本語原文や途中認識結果を送らない
- [ ] OBS未配信時に送らない
- [ ] 対象マイクのミュート中に送らない
- [ ] 停止・Side Panel終了時にマイクを解放する
- [ ] 2時間連続運用で回復不能な停止や古い字幕の一括送信がない
- [ ] PC、iPhone、AndroidでCC表示を確認する
- [ ] VOD字幕の挙動を文書化する
- [ ] 安全な文字集合、最大文字数、送信間隔を文書化する
- [ ] `npm test`とGitHub Actionsが成功する
- [ ] READMEと手動テスト文書を実測結果に合わせて更新する

## 16. 関連資料

- 親Issue: `https://github.com/azumag/english-cc-extension/issues/1`
- 初期実装コミット: `https://github.com/azumag/english-cc-extension/commit/58c1ec5bffe4fbc336000e48dbd6cb628238bb43`
- dociai統合版Issue: `https://github.com/azumag/dociai/issues/282`
- Chrome組み込みAI: `https://developer.chrome.com/docs/ai/built-in-apis`
- Chrome Translator API: `https://developer.chrome.com/docs/ai/translator-api`
- Chrome Side Panel API: `https://developer.chrome.com/docs/extensions/reference/api/sidePanel`
- OBS WebSocket: `https://github.com/obsproject/obs-websocket`
- OBS WebSocket protocol: `https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md#sendstreamcaption`
