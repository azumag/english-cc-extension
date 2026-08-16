# Multilingual CC Extension

マイク音声をChromeで認識し、Chrome内蔵Translator APIで選択した言語へ翻訳して、OBS WebSocket経由でTwitch公式クローズドキャプションへ送るManifest V3拡張です。

> 現在は初期実装です。純粋な字幕処理・OBSプロトコル処理は自動テスト済みですが、Chromeの音声認識、Translator API、OBS実機、Twitch CC表示はローカル環境でPhase 0確認が必要です。

## 目標

```text
配信用マイク
  -> Chrome Web Speech API (選択した認識言語)
  -> Chrome Translator API (認識言語 -> 選択した翻訳先)
  -> OBS WebSocket SendStreamCaption
  -> OBS配信出力
  -> Twitch公式CC
```

- 認識言語と翻訳先を設定可能
- Twitchへ送るのは翻訳済み字幕だけ
- 映像への字幕焼き込みなし
- Whisper / LocalVocal / CUDA、外部翻訳APIキー、ローカル中継サーバーなし

## 実装済み

- Manifest V3 / Side Panel UI
- マイク許可・入力デバイス列挙
- `SpeechRecognition` / `webkitSpeechRecognition`による音声認識
- 認識言語・翻訳先を選択式（`<select>`）で指定可能。一覧にない言語コードは「その他（手入力）」から直接入力できる
- 認識言語と翻訳先を入れ替えるボタン（⇄）
- 選択した言語ペアがChrome Translator APIで利用できるかを、開始前にその場で表示（利用可能／要ダウンロード／利用不可など。目安表示であり開始ボタンは無効化しない）
- 認識ロケールからTranslator API用言語タグへの正規化
- サイドパネルUI自体の表示言語をChromeの表示言語に自動追従（`chrome.i18n`、日本語・英語）
- 認識モード選択（`command` / `dictation` / `conversation`）。既定は連続発話向けの`conversation`（Chromeの既定は短い指示向けの`command`）
- 自動句読点補完（`unspokenPunctuation`、既定ON）
- 認識原文（翻訳前）へのNFKC正規化と固有名詞置換。聞き間違えやすい単語を翻訳前に補正できる
- 認識セッションの途中停止・無言停止の自動回復（再開ごとにクリーンなインスタンス、マイク切断時の再取得、90秒無反応時の強制再開）
- 長い発話は確定前でも`interimFlushChars`文字ごとに区切って先に翻訳（既定40、0で無効）
- 長い確定発話を句読点優先で短く区切ってから順番に翻訳
- Chrome Translator APIの利用可否確認、初回ダウンロード進捗、翻訳
- 日本語・中国語を翻訳先にした場合のCJK字幕送出
- 有界FIFO字幕キュー、期限切れ・重複の破棄
- 固有名詞置換と最終字幕文字数での長文分割
- 分割字幕・連続発話間の送信間隔（`segmentIntervalMs`、既定1500ms）
- obs-websocket 5.x challenge-response認証
- `GetVersion` / `GetStreamStatus` / `GetInputMute` / `SendStreamCaption`
- OBS未配信・マイクミュート時の送信停止
- OBSパスワードを`chrome.storage.session`にのみ保持（opt-inで端末内保存も選択可）
- Node.js unit testとGitHub Actions

## インストール

1. Google Chrome 138以降を用意します。
2. このリポジトリをcloneまたはZIP展開します。
3. `chrome://extensions`を開きます。
4. 「デベロッパーモード」をONにします。
5. 「パッケージ化されていない拡張機能を読み込む」でリポジトリルートを選びます。
6. 拡張アイコンを押してサイドパネルを開きます。

## OBS設定

1. OBS Studioの「ツール → WebSocketサーバー設定」を開きます。
2. WebSocketサーバーを有効にします。
3. パスワード認証を有効にします。
4. 既定では`127.0.0.1:4455`へ接続します。
5. 任意でOBS上のマイク入力名を指定すると、ミュート時の字幕送信を止められます。

## 使い方

1. 「更新・許可」でマイク利用を許可し、配信用マイクを選びます。初回は許可用の別タブが開くので、そちらで「許可」を選んでください。
2. 「認識言語」と「翻訳先」を一覧から選びます。既定値は`ja-JP -> en`です。一覧にない言語は「その他（手入力）」を選んで直接入力できます。⇄ボタンで両者を入れ替えられます。選んだ組み合わせの利用可否がその場に表示されます。
3. OBS WebSocketのパスワードを入力し「OBSへ接続」を押します。
4. OBSで配信を開始します。
5. 「テスト字幕」で接続経路を確認します。
6. 「CCを開始」を押します。
7. Twitchプレーヤー側でCCをONにします。

言語ペアがChrome Translator APIで利用できない場合は開始時にエラーを表示します。初回は対象言語のモデルダウンロードが必要になる場合があります。

OBSパスワードは既定でChromeセッション内だけに保持し、Chromeを再起動すると消えます。「このデバイスにパスワードを保存する」にチェックを入れた場合のみ、このデバイスに保存されChrome再起動後も再入力不要になります（表示される危険性の説明を読んでから有効にしてください。共有PCでは有効にしないでください）。認識原文と翻訳本文は永続保存しません。

## 現時点の制約

- サイドパネルを閉じると字幕処理も停止します。
- 通常のChrome音声認識では音声が認識サービスへ送信される場合があります。
- 選択した`MediaStreamTrack`を`SpeechRecognition.start(track)`へ渡しますが、Chrome実装が未対応の場合はブラウザ既定マイクへフォールバックします。
- 音声認識側で利用できる言語と、Translator API側で利用できる言語ペアはChrome環境に依存します。開始前の利用可否表示は目安であり、実際のエラーは開始時に別途表示されます。
- 拡張UI自体の表示言語はChromeの表示言語（`chrome://settings/languages`）に自動追従します。拡張内に言語切り替えUIはなく、切り替えの反映にはChromeの再起動が必要な場合があります。
- `maxCaptionChars=72`、`segmentIntervalMs=1500`、`interimFlushChars=40`は暫定値です。CEA-608/Twitch実機表示を確認して調整します。
- `interimFlushChars`による途中確定は低遅延と引き換えの精度トレードオフです。確定前の文で区切るため、Chrome側の認識訂正が起きると区切り付近の訳がまれに不自然・重複することがあります。
- 認識モードと自動句読点はChrome 138以降の拡張属性で、未対応バージョンでは無視されます。対応有無はサイドパネルの開始時の挙動で確認してください。
- 固有名詞置換は英訳後の字幕と認識原文（翻訳前）の両方に適用されます。翻訳後専用の置換を意図する場合は、認識原文にマッチしない表記（英字のみなど）を使ってください。
- Chrome Translator APIの初回モデル取得にはユーザー操作とネットワーク接続が必要です。
- TwitchのVODへ字幕が残るかは未確認です。
- Windows x64を第一対象とし、macOSは未検証です。

手動確認項目は[`docs/manual-test.md`](docs/manual-test.md)を参照してください。

## 開発

Node.js 20以降で実行します。

```bash
npm install
npm test
```

依存パッケージは現時点ではありません。拡張本体はビルド不要です。

## セキュリティ方針

- OBS接続先は`127.0.0.1`または`localhost`だけ
- `--disable-web-security`やremote debuggingを使用しない
- OBSパスワードを、ユーザーの明示的なopt-in（警告文への同意）なしに`chrome.storage.local`へ保存しない。`chrome.storage.sync`へはいかなる場合も保存しない
- Twitch権限、タブ権限、Cookie権限、閲覧履歴権限を要求しない
- 翻訳失敗時に認識原文をTwitchへ送らない
- OBS未配信・OBS切断・マイク状態取得失敗時は送信しない

## 関連

- GitHub Issue #1: MVP設計とPhase 0
- GitHub Issue #5: 長い発話を翻訳前に分割
- GitHub Issue #6: 多言語対応
