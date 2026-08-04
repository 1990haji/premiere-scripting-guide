/**
 * RestoreClipGap.jsx
 * ------------------------------------------------------------------------
 * Premiere Pro ExtendScript
 *
 * 目的:
 *   同一ソースメディアが「編集点」で前後に分かれているとき（例: ソース 2s-3s を
 *   リップル削除して 0-2s / 3-10s の2クリップになった状態）、その欠落区間を
 *   タイムライン上で自動復元し、後続クリップを右へリップルする。
 *   Undo ではなく、編集済みシーケンス上で必要な編集点だけを復元する。
 *
 * 実行条件（すべて満たす場合のみ実行。満たさない場合は理由を表示）:
 *   - 左右クリップが同一ソース（同一 ProjectItem）である
 *   - スピード 100%（getSpeed() === 1）
 *   - リバースなし（isSpeedReversed() が false/0）
 *   - タイムリマップなし（best-effort 判定。後述の制約を参照）
 *   - ネスト / マルチカム / 統合クリップ / 調整レイヤーではない
 *   - タイムライン上で隣接（L.end == R.start）し、ソース上に欠落区間がある
 *     （R.inPoint > L.outPoint）
 *
 * 実装の根拠 API（Premiere Pro Scripting Guide 準拠。After Effects API は不使用）:
 *   Sequence.getSelection()           選択中クリップ配列（時間順）
 *   Sequence.insertClip(pItem,t,v,a)  リップル挿入（後続を右へシフト）
 *   Track.clips                       トラック内 TrackItem 配列（時間順）
 *   TrackItem.start / end             シーケンス上の位置（Time, read/write）
 *   TrackItem.inPoint / outPoint      ソース基準の IN/OUT（Time, read/write）
 *   TrackItem.projectItem             参照元 ProjectItem
 *   TrackItem.parentTrackIndex        所属トラック index（公式サンプルで使用）
 *   TrackItem.getSpeed()              速度倍率（1 = 等速）
 *   TrackItem.isSpeedReversed()       リバース判定
 *   TrackItem.isAdjustmentLayer()     調整レイヤー判定
 *   TrackItem.components/...          エフェクト成分（タイムリマップ検出に使用）
 *   ProjectItem.nodeId                ソース同一性の識別子
 *   ProjectItem.getMediaPath()        メディアパス（同一性の補助判定）
 *   ProjectItem.isSequence()          ネスト判定
 *   ProjectItem.isMulticamClip()      マルチカム判定
 *   ProjectItem.isMergedClip()        統合クリップ判定
 *   ProjectItem.setInPoint/OutPoint   挿入するソース区間の指定（ticks）
 *   Sequence.timebase                 1フレームあたりの ticks
 *
 * 既知の制約 / 代替（詳細は scripts/README.md）:
 *   - 「編集点」そのものを選択・取得する API は存在しない。getSelection() は
 *     TrackItem を返すため、選択クリップと Track.clips の時間順から編集点を導出する。
 *   - クリップ端を「リップルトリムで延長」する専用 API は無い。.end/.outPoint は
 *     read/write だが隣接を上書きし挙動保証が弱いため、本スクリプトは
 *     Sequence.insertClip()（欠落区間をソースから挿入し後続を右へリップル）で復元する。
 *   - タイムリマップの直接判定 API は無い。components 走査による best-effort 判定。
 * ------------------------------------------------------------------------
 */

// @target premierepro

(function () {
    'use strict';

    // ---- 設定 ----------------------------------------------------------
    var CONFIG = {
        // 同一ソース判定にメディアパスも併用する（nodeId に加えて）
        USE_MEDIA_PATH_CHECK: true,
        // 速度比較の許容誤差
        SPEED_EPSILON: 0.0001,
        // 音声も復元対象にする（linked A/V を想定）
        RESTORE_AUDIO: true,
        // ログを alert 表示する
        SHOW_ALERT: true
    };

    var TICKS_PER_SECOND = 254016000000; // Time オブジェクト定義（Scripting Guide）

    // ---- ログ ----------------------------------------------------------
    var _log = [];
    function log(msg) { _log.push(String(msg)); }
    function flush(title) {
        var text = (title ? (title + '\n\n') : '') + _log.join('\n');
        if (CONFIG.SHOW_ALERT) { alert(text); }
        $.writeln(text);
    }

    // ---- ticks ヘルパ --------------------------------------------------
    // Time.ticks は String。通常のタイムライン長（~9時間未満）は Number(double)
    // で正確に扱える（< 2^53）。
    function ticksOf(timeObj) { return Number(timeObj.ticks); }
    function ticksToSec(t) { return t / TICKS_PER_SECOND; }

    // ---- 判定ヘルパ ----------------------------------------------------
    function sameSource(a, b) {
        var pa = a.projectItem, pb = b.projectItem;
        if (!pa || !pb) { return false; }
        if (String(pa.nodeId) !== String(pb.nodeId)) { return false; }
        if (CONFIG.USE_MEDIA_PATH_CHECK) {
            try {
                var ma = pa.getMediaPath(), mb = pb.getMediaPath();
                if (ma && mb && String(ma) !== String(mb)) { return false; }
            } catch (e) { /* getMediaPath 非対応メディアは nodeId のみで判定 */ }
        }
        return true;
    }

    // タイムリマップの best-effort 検出。
    // components/properties を走査し、名称がタイムリマップに該当し、かつ
    // isTimeVarying() が true のパラメータがあれば「リマップあり」とみなす。
    function hasTimeRemap(clip) {
        try {
            var comps = clip.components;
            if (!comps) { return false; }
            for (var i = 0; i < comps.numItems; i++) {
                var comp = comps[i];
                var props = comp.properties;
                if (!props) { continue; }
                for (var j = 0; j < props.numItems; j++) {
                    var p = props[j];
                    var nm = '';
                    try { nm = String(p.displayName || ''); } catch (e0) { nm = ''; }
                    var isRemap =
                        /time\s*remap/i.test(nm) ||
                        /タイム\s*リマップ/.test(nm) ||
                        /Zeitverlauf/i.test(nm);
                    if (isRemap) {
                        try {
                            if (p.isTimeVarying && p.isTimeVarying()) { return true; }
                        } catch (e1) { /* 判定不能なら無視 */ }
                    }
                }
            }
        } catch (e) { /* components 取得不能なら判定不能 */ }
        return false;
    }

    // クリップ単体の実行条件チェック。NG 理由を配列で返す（空なら OK）。
    function validateClip(clip, label) {
        var reasons = [];
        var pItem = clip.projectItem;

        try {
            if (Math.abs(clip.getSpeed() - 1) > CONFIG.SPEED_EPSILON) {
                reasons.push(label + ': スピードが 100% ではありません（' +
                    clip.getSpeed() + '）');
            }
        } catch (e) { reasons.push(label + ': getSpeed() を取得できません'); }

        try {
            if (clip.isSpeedReversed()) {
                reasons.push(label + ': クリップがリバース（逆再生）されています');
            }
        } catch (e) { /* 取得不能時はスキップ */ }

        try {
            if (clip.isAdjustmentLayer && clip.isAdjustmentLayer()) {
                reasons.push(label + ': 調整レイヤーです');
            }
        } catch (e) { /* 非対応バージョンは無視 */ }

        if (hasTimeRemap(clip)) {
            reasons.push(label + ': タイムリマップが適用されています');
        }

        if (pItem) {
            try { if (pItem.isSequence()) { reasons.push(label + ': ネスト（シーケンス）です'); } } catch (e) {}
            try { if (pItem.isMulticamClip && pItem.isMulticamClip()) { reasons.push(label + ': マルチカムクリップです'); } } catch (e) {}
            try { if (pItem.isMergedClip && pItem.isMergedClip()) { reasons.push(label + ': 統合クリップです'); } } catch (e) {}
        } else {
            reasons.push(label + ': projectItem を参照できません（合成メディア等）');
        }

        return reasons;
    }

    // ---- 編集点（隣接ペア）検出 ---------------------------------------
    // 選択クリップと Track.clips の時間順から、少なくとも一方が選択されている
    // 隣接ペア (L,R) を探す。同一ソースかつタイムライン隣接のもののみ。
    function findPairsFromSelection(seq, selection) {
        // 選択クリップを nodeId+start で高速判定できるよう key 化
        var selKeys = {};
        for (var s = 0; s < selection.length; s++) {
            var c = selection[s];
            selKeys[clipKey(c)] = true;
        }

        var pairs = [];
        var allTracks = collectTracks(seq);
        for (var t = 0; t < allTracks.length; t++) {
            var track = allTracks[t].track;
            var mediaType = allTracks[t].mediaType; // 'Video' | 'Audio'
            var clips = track.clips;
            for (var i = 0; i < clips.numItems - 1; i++) {
                var L = clips[i], R = clips[i + 1];
                var oneSelected = selKeys[clipKey(L)] || selKeys[clipKey(R)];
                if (!oneSelected) { continue; }
                if (!sameSource(L, R)) { continue; }
                if (!timelineAdjacent(seq, L, R)) { continue; }
                pairs.push({
                    L: L, R: R, track: track, mediaType: mediaType,
                    boundaryTicks: ticksOf(L.end)
                });
            }
        }
        return pairs;
    }

    function clipKey(clip) {
        var nid = '';
        try { nid = String(clip.projectItem.nodeId); } catch (e) {}
        return nid + '@' + String(clip.start.ticks) + '#' + String(clip.mediaType);
    }

    function collectTracks(seq) {
        var out = [];
        var i;
        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            out.push({ track: seq.videoTracks[i], mediaType: 'Video' });
        }
        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            out.push({ track: seq.audioTracks[i], mediaType: 'Audio' });
        }
        return out;
    }

    function timelineAdjacent(seq, L, R) {
        var halfFrame = frameTicks(seq) / 2;
        return Math.abs(ticksOf(L.end) - ticksOf(R.start)) <= halfFrame;
    }

    function frameTicks(seq) {
        var fb = Number(seq.timebase);
        if (!fb || fb <= 0) { fb = TICKS_PER_SECOND / 30; } // フォールバック 30fps
        return fb;
    }

    // ---- メイン --------------------------------------------------------
    function main() {
        if (typeof app === 'undefined' || !app.project) {
            log('プロジェクトが開かれていません。'); return flush('復元スクリプト');
        }
        var seq = app.project.activeSequence;
        if (!seq) { log('アクティブシーケンスがありません。'); return flush('復元スクリプト'); }

        var selection = seq.getSelection();
        if (!selection || !selection.length) {
            log('クリップ（編集点の左右）が選択されていません。');
            log('復元したい編集点の左右いずれか、または両方のクリップを選択してから実行してください。');
            return flush('復元スクリプト');
        }

        // 1) 選択から隣接ペアを検出
        var pairs = findPairsFromSelection(seq, selection);
        if (!pairs.length) {
            log('同一ソースで隣接している編集点が選択内に見つかりません。');
            log('・左右のクリップが同一ソースか / タイムライン上で隣接しているかを確認してください。');
            return flush('復元スクリプト');
        }

        // 2) 編集点は1つに限定（複数の異なる境界がある場合は中止）
        var boundarySet = {};
        var boundaryList = [];
        for (var p = 0; p < pairs.length; p++) {
            var bt = String(Math.round(pairs[p].boundaryTicks));
            if (!boundarySet[bt]) { boundarySet[bt] = []; boundaryList.push(bt); }
            boundarySet[bt].push(pairs[p]);
        }
        if (boundaryList.length !== 1) {
            log('複数の編集点が選択されています（' + boundaryList.length + '箇所）。');
            log('1つの編集点だけを選択して実行してください。');
            return flush('復元スクリプト');
        }
        var groupPairs = boundarySet[boundaryList[0]];

        // 3) 実行条件チェック（各ペアの L/R）
        var reasons = [];
        var gapRef = null;
        var fT = frameTicks(seq);
        for (var g = 0; g < groupPairs.length; g++) {
            var pr = groupPairs[g];
            var lbl = pr.mediaType + 'トラック' + (pr.L.parentTrackIndex + 1);

            reasons = reasons.concat(validateClip(pr.L, lbl + ' 左'));
            reasons = reasons.concat(validateClip(pr.R, lbl + ' 右'));

            // 欠落区間（ソース上）: gap = R.inPoint - L.outPoint
            var gapTicks = ticksOf(pr.R.inPoint) - ticksOf(pr.L.outPoint);
            // フレームスナップ
            var gapFrames = Math.round(gapTicks / fT);
            var gapSnap = gapFrames * fT;

            if (gapSnap <= 0) {
                reasons.push(lbl + ': ソース上に欠落区間がありません（既に連続、または重複）。' +
                    ' 左OUT=' + fmtSec(ticksOf(pr.L.outPoint)) +
                    ' 右IN=' + fmtSec(ticksOf(pr.R.inPoint)));
            }
            pr.gapTicks = gapSnap;

            if (gapRef === null) { gapRef = gapSnap; }
            else if (Math.abs(gapRef - gapSnap) > fT / 2) {
                reasons.push('ビデオ/オーディオで欠落区間の長さが一致しません。' +
                    ' 同期が崩れる恐れがあるため中止します。');
            }
        }

        if (reasons.length) {
            log('実行条件を満たさないため復元を中止しました。理由:');
            log('');
            for (var r = 0; r < reasons.length; r++) { log('  - ' + reasons[r]); }
            return flush('復元スクリプト');
        }

        // 4) 挿入トラックの決定
        var videoPair = pickPair(groupPairs, 'Video');
        var audioPair = pickPair(groupPairs, 'Audio');
        var vIdx = videoPair ? videoPair.L.parentTrackIndex : 0;
        var aIdx = audioPair ? audioPair.L.parentTrackIndex : 0;

        // 5) 挿入するソース区間を projectItem に設定して insertClip でリップル挿入
        //    区間 = [L.outPoint, R.inPoint]（欠落していたソース範囲）
        var refPair = videoPair || audioPair;
        var pItem = refPair.L.projectItem;
        var inTicks = ticksOf(refPair.L.outPoint);
        var outTicks = ticksOf(refPair.R.inPoint);
        var boundaryTicks = Math.round(refPair.boundaryTicks);

        try {
            // mediaType: 4 = 全メディア
            pItem.setInPoint(String(Math.round(inTicks)), 4);
            pItem.setOutPoint(String(Math.round(outTicks)), 4);
        } catch (e) {
            log('ソース IN/OUT の設定に失敗しました: ' + e);
            return flush('復元スクリプト');
        }

        var ok = false;
        try {
            // Sequence.insertClip(projectItem, time, vTrackIndex, aTrackIndex)
            ok = seq.insertClip(pItem, String(boundaryTicks), vIdx, aIdx);
        } catch (e2) {
            log('insertClip でエラー: ' + e2);
            return flush('復元スクリプト');
        }

        if (ok === false) {
            log('insertClip が false を返しました（挿入に失敗）。');
            log('ソース側に該当フレームが存在するか、トラックがロックされていないか確認してください。');
            return flush('復元スクリプト');
        }

        var restoredSec = ticksToSec(refPair.gapTicks);
        log('復元しました。');
        log('  編集点: ' + fmtSec(boundaryTicks) + '（シーケンス）');
        log('  復元したソース区間: ' + fmtSec(inTicks) + ' – ' + fmtSec(outTicks) +
            '（長さ ' + restoredSec.toFixed(3) + ' 秒）');
        log('  ビデオ: ' + (videoPair ? ('V' + (vIdx + 1)) : '対象なし') +
            ' / オーディオ: ' + (audioPair && CONFIG.RESTORE_AUDIO ? ('A' + (aIdx + 1)) : '対象なし'));
        log('  後続クリップは右へ ' + restoredSec.toFixed(3) + ' 秒リップルされました。');
        if (videoPair && !audioPair) {
            log('');
            log('※ 注意: 選択内に音声側の編集点が見つかりませんでした。ソースに音声が');
            log('   含まれる場合、リンクした音声編集点も一緒に選択して実行してください。');
        }
        return flush('復元スクリプト');
    }

    function pickPair(list, mediaType) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].mediaType === mediaType) { return list[i]; }
        }
        return null;
    }

    function fmtSec(ticks) { return ticksToSec(ticks).toFixed(3) + 's'; }

    // ---- 実行 ----------------------------------------------------------
    try {
        main();
    } catch (err) {
        _log.push('予期しないエラー: ' + err + (err.line ? (' (line ' + err.line + ')') : ''));
        flush('復元スクリプト');
    }
})();
