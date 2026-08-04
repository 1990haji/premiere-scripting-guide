# RestoreClipGap — 同一ソース編集点の欠落区間 自動復元スクリプト

Premiere Pro の ExtendScript で、**同じソースクリップが編集点で前後に分かれている箇所**を
選択して実行すると、**リップル削除で抜けたソース区間を自動復元し、後続クリップを右へ
リップルシフト**するスクリプトです。Undo ではなく、編集済みタイムライン上で
**必要な編集点だけ**を復元します。

> 例: `A.mov`（ソース 0–10s）を編集中、ソース 2–3s をリップル削除 →
> タイムラインは「0–2s」と「3–10s」の 2 クリップに。
> 編集点を選択して実行 → ソース 2–3s を復元して後続を右へ 1 秒シフト。

- スクリプト本体: [`RestoreClipGap.jsx`](./RestoreClipGap.jsx)

---

## 1. 事前調査の結論（Premiere Pro ExtendScript で確認済みの事実）

以下はすべて **本リポジトリ（Premiere Pro Scripting Guide 公式ドキュメント）に記載された
Premiere Pro の API** に基づく事実で、**After Effects の API は使用していません**。
各行の「根拠」は本リポジトリ内 `docs/...` の該当ページです。

| 要件 | 可否 | 使用 API / 事実 | 根拠 |
|---|---|---|---|
| 編集点から左右のクリップを取得できるか | ✅ 可能 | `Track.clips` はトラック内 TrackItem の**時間順配列**。隣接 index が編集点の左右。 | `docs/sequence/track.md` |
| 選択中の編集点を取得できるか | △ 間接的 | **「編集点」オブジェクトは存在しない**。`Sequence.getSelection()` は選択中の **TrackItem 配列**（時間順）を返す。選択クリップ＋`Track.clips`の順序から編集点を導出する。 | `docs/sequence/sequence.md` |
| 左右クリップのソース IN/OUT を取得できるか | ✅ 可能 | `TrackItem.inPoint` / `TrackItem.outPoint`（Time, **ソース基準**, read/write）。`TrackItem.start` / `end` は**シーケンス基準**。 | `docs/item/trackitem.md` |
| ソースのタイムコードを取得できるか | ✅ 可能（相対）／⚠️ 一部制約 | ソース相対の秒/ticks は `inPoint/outPoint`（`Time.seconds`/`Time.ticks`）で取得可。表示用タイムコード文字列は `Time.getFormatted()`。**メディア埋め込みの絶対開始タイムコード（Start TC）を直接返す専用 API は無い**（XMP 経由の限定手段のみ）。本用途は IN/OUT 差分で判定できるため絶対 TC は不要。 | `docs/other/time.md`, `docs/item/projectitem.md` |
| クリップ端をプログラムから延長できるか | △ 制約あり | `TrackItem.end` / `outPoint` は read/write だが、**「リップルトリムで延長」する専用 API は無い**。値の直接書き換えは隣接クリップを上書きする恐れがあり挙動保証が弱い。→ **代替として `Sequence.insertClip()` を採用**（下記）。 | `docs/item/trackitem.md` |
| 後続クリップをまとめて右へ移動できるか | ✅ 可能 | `Sequence.insertClip()` は**挿入した分だけ後続を右へリップル**。個別移動は `TrackItem.move(newInPoint)`。 | `docs/sequence/sequence.md`, `docs/item/trackitem.md` |
| リップルエディット相当をスクリプトで実行できるか | ✅ 可能（挿入/削除）／△ トリムは間接 | **挿入リップル** = `Sequence.insertClip()`（後続右シフト）。**削除リップル** = `TrackItem.remove(inRipple=1, ...)`（後続左詰め）。**トリムのリップル**専用 API は無いため、本スクリプトは「欠落区間をソースから挿入」で復元する。 | `docs/sequence/sequence.md`, `docs/item/trackitem.md` |

### 判定条件に使う API（すべて実在を確認済み）

| 判定 | API | 根拠 |
|---|---|---|
| 同一ソースか | `ProjectItem.nodeId`（同一メディアへの参照を区別する一意 ID）＋補助で `ProjectItem.getMediaPath()` | `docs/item/projectitem.md` |
| スピード 100% か | `TrackItem.getSpeed()` … 等速なら `1` | `docs/item/trackitem.md` |
| リバースなしか | `TrackItem.isSpeedReversed()` … 反転なら `1` | `docs/item/trackitem.md` |
| タイムリマップなしか | **直接判定 API は無い**。`TrackItem.components` → `ComponentParam.isTimeVarying()` を走査する **best-effort** 判定 | `docs/sequence/component.md`, `docs/sequence/componentparam.md` |
| ネストではないか | `ProjectItem.isSequence()`（＋`isMulticamClip()` / `isMergedClip()` / `TrackItem.isAdjustmentLayer()`） | `docs/item/projectitem.md`, `docs/item/trackitem.md` |
| 所属トラック取得 | `TrackItem.parentTrackIndex`（公式サンプル `nestSelection()` で使用） | `docs/sequence/sequence.md` |
| フレーム長 | `Sequence.timebase`（1 フレームあたりの ticks） | `docs/sequence/sequence.md` |

---

## 2. API 制約と代替案（重要）

推測ではなく、ドキュメントで確認できた制約と、その回避策です。

### 制約 1: 「編集点」を選択・取得する API が無い
- **取得できる情報**: 選択中の `TrackItem`（`getSelection()`）、各トラックの `clips` 時間順配列。
- **取得できない情報**: 「編集点」という単独オブジェクト、選択された編集点そのもの。
- **理由**: スクリプティングモデルはクリップ（TrackItem）単位で、編集点はクリップ境界として暗黙的に表現される。
- **代替案（採用）**: ユーザーが編集点の**左右いずれか／両方のクリップ**を選択 → `Track.clips` の
  時間順から隣接ペア (L, R) を求め、`L.end == R.start`（隣接）かつ `L.projectItem == R.projectItem`
  （同一ソース）で編集点を確定する。

### 制約 2: 「リップルトリムで端を延長」する専用 API が無い
- **取得できる情報**: `start/end/inPoint/outPoint`（read/write）。
- **できないこと**: 「クリップ端を伸ばして後続を自動リップル」する 1 コールの API。
  属性を直接書き換える方法は隣接を上書きするリスクがあり、公式にリップル保証がない。
- **代替案（採用）**: 欠落区間 `[L.outPoint, R.inPoint]` を **`ProjectItem.setInPoint/OutPoint` で指定**し、
  **`Sequence.insertClip()` で編集点の位置（`L.end`）に挿入**する。insertClip は挿入分だけ後続を
  右へリップルするため、「復元＋後続右シフト」が 1 操作で成立する。
  結果は L・復元クリップ・R が**フレーム連続（スルー編集）**で並ぶ。

### 制約 3: タイムリマップの直接判定 API が無い
- `getSpeed()` は**均一速度**を返すため、可変速（タイムリマップ）でも `1` を返し得る。
- **代替案（採用・best-effort）**: `components`→`properties` を走査し、名称がタイムリマップに
  該当し `isTimeVarying()` が `true` のパラメータがあれば「リマップあり」と判定して中止。
- **限界**: パラメータ名はローカライズ/バージョン依存。確実性が必要なら運用でカバー（下記）。

### 制約 4: リンク音声（A/V）の同期
- 本スクリプトはビデオ側ペアと**同一境界・同一長**のオーディオ側ペアが選択にあれば、
  `insertClip(pItem, time, vIdx, aIdx)` で**両方を同時にリップル挿入**して同期を保つ。
- 音声付きソースで音声側編集点が選択に含まれない場合は、同期崩れ防止のため**警告**を表示する。

---

## 3. 復元アルゴリズム

1. `activeSequence.getSelection()` で選択クリップを取得（空なら中止）。
2. 全トラックの `clips`（時間順）から、**片方でも選択されている**隣接ペア (L, R) で
   **同一ソース**かつ**タイムライン隣接**のものを列挙。
3. 検出した編集点（境界 `L.end` の ticks）が **1 箇所のみ**であることを確認（複数なら中止）。
4. 各ペアの L/R について実行条件を検査:
   等速 `getSpeed()==1` / 非リバース / 非タイムリマップ / 非ネスト・非マルチカム・非統合・非調整レイヤー /
   欠落区間 `gap = R.inPoint − L.outPoint > 0`（フレームスナップ）。V/A で gap 長が一致すること。
   1 つでも NG なら**理由を列挙して中止**。
5. 挿入するソース区間 `[L.outPoint, R.inPoint]` を `ProjectItem.setInPoint/OutPoint`（ticks, mediaType=4）で設定。
6. `Sequence.insertClip(projectItem, L.end(ticks), vTrackIndex, aTrackIndex)` を実行 →
   欠落区間を編集点に挿入し、後続を右へリップル。
7. 結果（復元区間・長さ・対象トラック・シフト量）をログ表示。

---

## 4. 使い方

1. Premiere Pro でシーケンスを開く。
2. 復元したい編集点の**左右いずれか／両方のクリップ**を選択（リンク A/V はまとめて選択）。
3. スクリプトを実行:
   - `File > Scripts`（ExtendScript を実行できる環境）から `RestoreClipGap.jsx` を実行、または
   - CEP/UXP パネルや ExtendScript Toolkit / VS Code の ExtendScript 実行環境から評価。
   - 実行方法の一般手順は `docs/introduction/how-to-execute-scripts.md` を参照。
4. ダイアログに結果、または中止理由が表示される。

### 設定（`RestoreClipGap.jsx` 冒頭 `CONFIG`）
| キー | 既定 | 説明 |
|---|---|---|
| `USE_MEDIA_PATH_CHECK` | `true` | 同一ソース判定に `getMediaPath()` を併用 |
| `SPEED_EPSILON` | `0.0001` | 速度比較の許容誤差 |
| `RESTORE_AUDIO` | `true` | リンク音声も同期復元する |
| `SHOW_ALERT` | `true` | 結果を `alert` 表示（`false` で `$.writeln` のみ） |

---

## 5. 制限事項・注意

- **タイムリマップ検出は best-effort**（名称＋`isTimeVarying()`）。重要案件では目視確認を推奨。
- **音声分離編集**（V だけ／A だけを個別トリム）には未対応。V/A の編集点は一致している前提。
- **トランジション**が編集点に掛かっている場合の挙動は未検証（事前に外すことを推奨）。
- `insertClip` の時間引数はドキュメント表記に揺れがあるため、本実装は **ticks 文字列**で渡している。
  環境により挙動が異なる場合は README のこの節を参照して調整のこと。
- 実行前に**プロジェクトのバックアップ**を推奨（本スクリプトは Undo グループを作らない）。

---

## 6. 動作確認チェックリスト（実機推奨）

- [ ] 単一ビデオトラック、音声なしソースでの復元
- [ ] リンク A/V（V1+A1）での同期復元
- [ ] 速度変更クリップ → 「スピードが 100% ではありません」で中止
- [ ] リバースクリップ → 中止
- [ ] ネスト/マルチカム/統合/調整レイヤー → 中止
- [ ] 異なるソースの隣接 → 「同一ソースで隣接する編集点が見つかりません」
- [ ] 欠落なし（連続）→ 「ソース上に欠落区間がありません」
