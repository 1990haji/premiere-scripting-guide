# Premiere Pro の ScriptUI:できること・限界(調査メモ)

**結論**:Premiere Pro の ExtendScript は ScriptUI を公式にサポートしていない(Adobe社員 Bruce Bullis 氏がフォーラムで回答)。ExtendScript 自体は動くが、`new Window(...)` のウィンドウ・ボタン・テキスト欄などは正式機能ではない。UIが必要なら今は UXP プラグインが基本。

## 使えるもの(ExtendScript標準ダイアログ)
- `alert("...")`:メッセージ表示
- `prompt("質問", "初期値")`:値を1つ入力。Bullis 氏が ScriptUI の代替として推奨
- `File.openDialog()` / `File.saveDialog()`:ファイル選択
- `Folder.selectDialog()`:フォルダ選択
- `confirm()` は標準機能だが、Premiere での動作報告は未確認

→「実行 → 値を1〜2個聞く → ファイル選択 → 処理」程度なら ScriptUI なしで作れる。

## できないこと・限界
- `Window("dialog")` / `Window("palette")`、ボタン、ドロップダウン、リスト、スライダーなどは非対応。バージョンによって一部表示できた報告もあるが保証はなく、配布ツールには使えない。
- After Effects の ScriptUI Panels のような、ドッキングできる常駐パネルは作れない。
- 入力は `prompt()` の繰り返ししかなく、複数項目のフォームは作れない。
- Premiere には「ファイル → スクリプト」メニューがなく、起動は CEP パネル/VS Code の ExtendScript Debugger/手間のかかるコマンドラインのいずれか。
- ExtendScript のサポートは2026年9月までとされる。新規に ScriptUI / ExtendScript 前提で作るのは避けるべき。

## 本格的なUIが必要な場合
| 方法 | 状況 |
|---|---|
| CEPパネル(HTML/JS UI+ExtendScript) | 従来の標準。Premiere 2026 では自動で読み込まれないとの報告あり。新規提出受付は2027年12月終了、2028年12月から初期状態で無効の予定 |
| UXPプラグイン(HTML/Spectrum UI+新しい Premiere API) | Premiere 2026 から正式。これから作るならこちら |

## まとめ
- 簡単な入力で済む → `prompt` / `alert` / ファイル選択で可(将来性はない)
- ボタンや一覧のある画面が必要 → UXP プラグイン。既存の CEP パネルは移行を計画する

※ Adobe フォーラム/開発者ブログは直接開けず、検索結果の要約をもとにまとめた。

## 参照
- https://community.adobe.com/questions-729/scriptui-1368691
- https://community.adobe.com/questions-729/creating-a-new-window-using-adobe-extendscript-in-premiere-1397431
- https://community.adobe.com/questions-729/making-a-simple-ui-in-premiere-pro-using-javascript-1368496
- https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications
- https://hyperbrew.co/blog/uxp-plugins-in-premiere-2026/
- https://github.com/tmoroney/auto-subs/issues/571
- https://developer.adobe.com/premiere-pro/uxp/ppro-reference/
- https://mapsoft.com/posts/adobe-ui-options.html
