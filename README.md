# English CC Extension

日本語のマイク音声をChromeで認識し、Chrome内蔵Translator APIで英訳して、OBS WebSocket経由でTwitch公式クローズドキャプションへ送るManifest V3拡張です。

> 現在は初期実装です。純粋な字幕処理・OBSプロトコル処理は自動テスト済みですが、Chromeの音声認識、Translator API、OBS実機、Twitch CC表示はローカル環境でPhase 0確認が必要です。

## 目標

```text
配信用マイク
  -> Chrome Web Speech API (ja-JP)
  -> Chrome Translator API (ja -> en)
  -> OBS WebSocket SendStreamCaption
  -> OBS配信出力
  -> Twitch公式CC
```

- Twitchへ送るのは英訳済み字幕だけ
- 映像への字幕焼き込みなし
- Whisper / LocalVocal / CUDAなし
- dociaiやローカル中継サーバーなし
- DeepLやGoogle Cloud TranslationのAPIキーなし
- Twitch OAuth、Cookie、Twitchタブ操作なし

## 実装済み

- Manifest V3 / Side Panel UI
- マイク許可・入力デバイス列挙
- `SpeechRecognition` / `webkitSpeechRecognition`による日本語認識
- interimはプレビューのみ、finalだけ翻訳キューへ投入
- Chrome Translator APIの利用可否確認、初回ダウンロード進捗、日英翻訳
- 有界FIFO字幕キュー、期限切れ・重複・日本語混入の破棄
- 固有名詞置換と英単語境界での長文分割
- obs-websocket 5.x challenge-response認証
- `GetVersion` / `GetStreamStatus` / `GetInputMute` / `SendStreamCaption`
- OBS未配信・マイクミュート時の送信停止
- OBSパスワードを`chrome.storage.session`にのみ保持
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

1. 「更新・許可」でマイク利用を許可し、配信用マイクを選びます。
2. OBS WebSocketのパスワードを入力し「OBSへ接続」を押します。
3. OBSで配信を開始します。
4. 「テスト字幕」で接続経路を確認します。
5. 「英語CCを開始」を押します。
6. Twitchプレーヤー側でCCをONにします。

OBSパスワードはChromeセッション内だけに保持し、Chromeを再起動すると消えます。認識原文と英訳本文は永続保存しません。

## 現時点の制約

- サイドパネルを閉じると字幕処理も停止します。
- 通常のChrome音声認識では音声が認識サービスへ送信される場合があります。
- 選択した`MediaStreamTrack`を`SpeechRecognition.start(track)`へ渡しますが、Chrome実装が未対応の場合はブラウザ既定マイクへフォールバックします。
- `maxCaptionChars=72`は暫定値です。CEA-608/Twitch実機表示を確認して調整します。
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
- OBSパスワードを`chrome.storage.local`へ保存しない
- Twitch権限、タブ権限、Cookie権限、閲覧履歴権限を要求しない
- 翻訳失敗時に日本語原文をTwitchへ送らない
- OBS未配信・OBS切断・マイク状態取得失敗時は送信しない

## 関連

- GitHub Issue #1: MVP設計とPhase 0
- `azumag/dociai` Issue #282: dociaiへ統合する別実装
