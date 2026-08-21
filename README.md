# Audio Playlist

GitHub Pagesで動作する、個人利用向けの簡易音声プレイリスト編集アプリです。

## 対応機能

- MP3 / WAV / AAC / M4A のファイル追加
- 再生・一時停止・停止・シーク
- 再生位置の数値入力（0.05秒単位）
- 曲ごとの開始 / 終了位置の保持
- 選択範囲の試聴
- 曲順変更（上下移動 / ドラッグ＆ドロップ）
- リピート: オフ / リスト / 1曲 / 末尾のみ1曲
- ローカル保存（IndexedDB + localStorage）
- ZIP保存 / ZIP読み込み
- ZIPには playlist.json と使用中の音声ファイルを同梱
- 同一音声ファイルをプレイリスト内で複数回参照可能

## GitHub Pages

このフォルダをGitHubリポジトリに配置し、GitHub Pagesの公開対象にすれば利用できます。

`index.html` が入口です。

## 外部ライブラリ

ZIP処理に JSZip 3.10.1 をCDNから読み込みます。

## JSON形式

トップレベルに以下を持ちます。

- `format`
- `version`
- `playlist`
- `settings`
- `assets`
- `tracks`

`assets` が実体としての音声ファイル、`tracks` がプレイリスト上の登場位置です。trim情報は `tracks[].trim` に保持します。

## 注意

音声の再生可否はブラウザのデコーダ対応にも依存します。特にAAC/M4Aはブラウザ環境差があります。
