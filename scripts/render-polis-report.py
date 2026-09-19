"""Render the saved local synthetic benchmark. Requires matplotlib; no network."""
import html
import json
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / os.environ.get("SIMULATION_OUTPUT", "outputs/polis-simulation")
data = json.loads((OUT / "results.json").read_text())
repeats = data["repetitions"]
edges = json.loads((OUT / "edges.json").read_text())
summary = {s["id"]: s for s in data["summary"]}
examples = {s["scenario"]: s for s in data["examples"]}
colors = ["#2455dd", "#ba542a", "#7753ad", "#238877", "#b18926", "#a33f6e"]
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False})

panels = [("three", "Planted 3 groups"), ("weak", "Weak 3 groups"), ("random", "Random independent votes"),
          ("biased", "Item preferences; no groups"), ("continuous", "Continuous 2D; no groups"), ("continuous_line", "Continuous 1D; no groups")]
fig, axes = plt.subplots(2, 3, figsize=(12, 7.8), layout="constrained")
for ax, (key, title) in zip(axes.flat, panels):
    a = examples[key]["analysis"]
    for g in a["groups"]:
        points = [p for p in a["points"] if p["group"] == g["id"]]
        ax.scatter([p["x"] for p in points], [p["y"] for p in points], s=7, alpha=.5, color=colors[g["id"]], linewidths=0)
    ax.set(title=f'{title}\nselected k={len(a["groups"])}, silhouette={a["silhouette"]:.3f}', xlabel="PCA 1 (scaled, arbitrary units)", ylabel="PCA 2 (scaled, arbitrary units)")
    ax.grid(alpha=.14)
fig.suptitle("1,000 synthetic participants per panel | frozen legacy settings | colors = inferred groups", fontsize=13)
fig.savefig(OUT / "opinion-maps.png", dpi=170)
plt.close(fig)

fig, ax = plt.subplots(figsize=(10.8, 5.8), layout="constrained")
score_panels = panels[:2] + [("four", "Planted 4 groups"), ("minority2", "98:2 minority")] + panels[2:]
for i, (key, title) in enumerate(score_panels):
    values = [r["silhouette"] for r in data["baseline"] if r["scenario"] == key]
    offsets = [(j-(len(values)-1)/2)*.025 for j in range(len(values))]
    ax.scatter(values, [i+v for v in offsets], s=26, alpha=.8, color=colors[0])
ax.axvline(.2, color="#7d8798", linestyle="--", label="Legacy gate 0.20")
ax.axvline(.4, color=colors[1], linestyle="--", label="Tuned gate 0.40")
ax.set_yticks(range(len(score_panels)), [p[1] for p in score_panels])
ax.invert_yaxis()
ax.set(xlabel="Best silhouette after selecting k and initialization", title="A higher silhouette does not establish discrete groups")
ax.grid(axis="x", alpha=.15)
ax.legend(loc="lower right")
fig.savefig(OUT / "silhouette-sensitivity.png", dpi=170)
plt.close(fig)

example = examples["minority2"]
truth = {s["id"]: s["group"] for s in example["truth"]}
pts = example["analysis"]["points"]
known = [truth[s] for s in example["sessionIds"]]
fig, axes = plt.subplots(1, 2, figsize=(10, 4.3), sharex=True, sharey=True, layout="constrained")
for ax, labels, title in [(axes[0], known, "Planted truth: 980 vs 20"), (axes[1], [p["group"] for p in pts], "Inferred: 3 groups")]:
    for g in sorted(set(labels)):
        selected = [p for p, label in zip(pts, labels) if label == g]
        ax.scatter([p["x"] for p in selected], [p["y"] for p in selected], s=16 if g == 1 else 7, color=colors[g], alpha=.75, linewidths=0, label=f"Group {g+1}: {len(selected)}")
    ax.set(title=title, xlabel="PCA 1 (scaled, arbitrary units)", ylabel="PCA 2 (scaled, arbitrary units)")
    ax.legend(fontsize=9)
fig.suptitle("Minority check: identical coordinates, truth vs inferred membership", fontsize=12)
fig.savefig(OUT / "minority-recovery.png", dpi=170)
plt.close(fig)

def f(value, digits=3):
    return "—" if value is None else f"{value:.{digits}f}"

def table(headers, rows):
    def row(values, tag):
        return "<tr>" + "".join(f"<{tag}>{html.escape(str(v))}</{tag}>" for v in values) + "</tr>"
    return '<div class="table-wrap"><table><thead>' + row(headers, "th") + "</thead><tbody>" + "".join(row(r, "td") for r in rows) + "</tbody></table></div>"

baseline_rows = [[s["name"], f'{s["ready"]}/{s["runs"]}', ", ".join(f"{k}群×{v}回" for k, v in s["kCounts"].items()), f(s["eligible"]["mean"], 0), f(s["silhouette"]["mean"]), f(s["ari"]["mean"]), f(s["bridgePrecision"]["mean"]), f(s["bridgeRecall"]["mean"])] for s in data["summary"]]
keys = ["three", "weak", "random", "biased", "continuous", "continuous_line"]
threshold_rows = []
for t in data["thresholdSweep"]:
    counts = {s["scenario"]: s for s in t["scenarios"]}
    threshold_rows.append([t["threshold"]] + [f'{counts[k]["accepted"]}/{counts[k]["total"]}' for k in keys])
validation_rows = []
for threshold in [.2, .4, .45, .5, .6]:
    validation_rows.append([threshold] + [f'{sum(r["silhouette"] is not None and r["silhouette"] >= threshold for r in data["validation"] if r["scenario"] == k)}/5' for k in keys])
parameter_rows = [
    ["表示のsilhouette", "0.2", "現状は緩い。0.4は今回のランダム対照を抑える暫定候補だが、群の存在を保証しない。1次元の連続分布は通過する。"],
    ["対象者の最低賛否回答数", "6", "暫定維持。8回答のケースでは6→8にすると対象が962→430人となり、一致度は改善しなかった（同一seed）。"],
    ["探索する群数", "2〜4", "明瞭な2〜4群は再現。6まで増やしてもランダム回答への群付けは解消しない。5群以上の正解は未検証。"],
    ["各群の最低人数", "3", "大きくすればよいとは言えない。100人の少数派は回復、20人の少数派は現状でほぼ失敗。割合による切り捨ては避けて別途評価。"],
    ["PCAの反復回数", "100", "維持。明瞭・弱い3群では25/100/250回で分類一致。ランダム対照のPCAは変わるが誤分類問題の解決にはならない。"],
    ["初期化回数", "4", "維持。今回の比較条件で1/4/12回による改善は見られない。"],
    ["silhouette近似", "256対象・128比較点/群", "維持候補。3条件で全点計算との差は最大約0.0012。弱い3群の分類ARIは近似と全点間で0.991。"],
    ["共通点の必要回答数", "各群3", "不足しうる。2/3賛成でも表示される。群の表示と共通点の証拠量を分け、賛成率の不確実性を評価する。"],
    ["共通点の賛成率", "60%", "閾値だけでは確実性を表せない。少数派の分類失敗で、少数派が反対する意見も共通点になる。"],
]
sampling_rows = [[summary[s["scenario"]]["name"], f(s["approximate"]["silhouette"]), f(s["exact"]["silhouette"]), f(s["labelARI"]), f(s["approximate"]["elapsedMs"], 0), f(s["exact"]["elapsedMs"], 0)] for s in data["samplingComparisons"]]
preview_path = ROOT / ".wrangler/simulations/run-MXtvQm/verification.json"
preview = json.loads(preview_path.read_text()) if preview_path.exists() else None
if preview:
    (OUT / "preview-verification.json").write_text(json.dumps(preview, ensure_ascii=False, indent=2))

content = f"""
<p class="eyebrow">ローカル検証 / 人工データのみ / {data['createdAt'][:10]}</p>
<h1>1,000人の反応で、どこまで正しく見えるか</h1>
<p class="lead">明瞭な意見群の再現は良好。ただし調整前の固定設定は無構造の回答にもグループを付けるため、そのまま妥当とは言えません。</p>
<p>{len(data["summary"])}条件×各{repeats}試行（1試行1,000人）。現在の40意見に、実装中の抽選処理で通常1人20回答を生成しました。追加で{len(data['sensitivity'])}通りの設定比較と35試行の別seed検証を実施。実際の市民の回答・属性・世論予測は含みません。乱数seedと全設定は保存済みです。</p>
<p><a href="http://127.0.0.1:5185/participate">人工データを入れたローカル画面</a> →「共通する意見を見る」。1,000人・20,000回答、335/332/333人の3群、共通点8件を確認。分析APIはローカル初回177ms、全40意見の回答カウンターも一致。本番環境の速度保証ではありません。</p>
<h2>設定の調整だけでは解けない2つの問題</h2>
<p>集団差を入れていないランダム回答は、調整前の閾値0.2では{repeats}/{repeats}回「3群」になりました。0.4で今回のランダム対照は0/{repeats}回になります。一方、意見が滑らかに連続する1次元の集団は平均silhouette={f(summary['continuous_line']['silhouette']['mean'])}で2群になり、0.4でも{repeats}/{repeats}回通過します。群の表示を離散的な集団の存在と同一視できません。</p>
<p>90対10の少数派はほぼ再現しましたが、98対2ではARI平均={f(summary['minority2']['ari']['mean'])}と失敗。多数派を複数群に割って少数派を混ぜるため、誤った「共通点」も増えます。シルエット係数だけの選択では少数派の保護になりません。</p>
<figure><img src="silhouette-sensitivity.png" alt="各条件10回のシルエット係数。ランダム約0.34、弱い3群約0.46、連続1次元約0.59。"><figcaption>点は別の乱数による試行。0.4を超えていても、離散群を仕込んでいない条件があります。</figcaption></figure>
<h2>調整前の設定についての評価</h2>
{table(['設定','調整前の値','今回の判断'], parameter_rows)}
<p>このレポートは調整前の設定を固定した比較用記録です。現在の既定値は対象80セッション、分離度0.45、各群10回答、観測賛成率60%以上、Wilson下限が50%を超えるです。変更前後の比較は <a href="../polis-tuning/REPORT.md">調整レポート</a> を参照してください。最適値・検定済みの基準とは扱いません。</p>
<h2>人工の意見地図</h2>
<figure><img src="opinion-maps.png" alt="明瞭な群、弱い群、無構造、連続分布の地図を比較。"><figcaption>色は調整前設定による分類です。軸は補正後のPCA座標で、図ごとにスケールが異なります。政策的な左右を表しません。</figcaption></figure>
<figure><img src="minority-recovery.png" alt="98対2の少数派について、真の群と推定群の対応を比較。"><figcaption>同じ座標を、仕込んだ群（左）と処理結果（右）で色分け。20人の少数派が多数派と混ざります。</figcaption></figure>
<h2>全{len(data["summary"])}条件の結果</h2>
<p>ARIは群の一致度（1=完全一致、0≈偶然）。表示回数と各指標は{repeats}試行の結果。precisionは表示した共通点のうち正解だった割合、recallは正解の共通点のうち表示できた割合。正解は各潜在群の期待賛成率が60%以上の意見です。パスは分母に含み、無関係は除外します。「—」は定義できない値です。</p>
{table(['条件','表示回数','群数','対象人数平均','silhouette平均','ARI平均','共通点precision','共通点recall'], baseline_rows)}
<p>共通点precisionの平均は候補が1件以上ある試行のみが対象。パス35%の条件では仕込んだ共通意見も期待賛成率約58%となり、60%の正解集合は空になります。意見別賛成率・連続分布など、離散群を仕込まない条件の共通点精度は算出していません。</p>
<h2>表示閾値の比較</h2>
<p>同じ候補のスコアに表示条件だけを適用。分数は表示された試行数です。</p>
{table(['閾値']+[summary[k]['name'] for k in keys], threshold_rows)}
<h3>別のseedによる追加検証</h3>
{table(['閾値']+[summary[k]['name'] for k in keys], validation_rows)}
<p>5回や10回で0件でも、真の誤判定確率が0と証明されたわけではありません。閾値の一般化には生成仮定を変えた検証と実データでの確認が必要です。</p>
<h2>境界ケース</h2>
<ul><li><b>1人が全体の分類を止める：</b>999人で明瞭な2群があっても、共通意見2件＋独自意見4件に答えた1人を加えると全体が集計待ちになることを再現。全員の回答項目の接続を必須にしているためです。</li>
<li><b>3人群の2人賛成が共通点になる：</b>997対3人の2群で、997/997人と2/3人が賛成する意見が候補になります。高いsilhouetteは賛成率の確かさを保証しません。</li>
<li><b>パスの仕方だけでも2群になる：</b>500人は全件賛成、500人は6件賛成＋34件パス。実質的な賛否の方向が同じでもsilhouette=1で2群。パス=0という仕様の帰結です。</li></ul>
<p>各群3回答という閾値を増やすだけでは不十分です。例として真の賛成確率50%、固定された2群、40意見という独立な二項モデルでは、各群3回答の2/3以上ルールで偶然の共通点が平均10件になります。これは説明用計算であり、このサイトの実データの誤発見率推定ではありません。詳細はedges.jsonに記録。</p>
<h2>近似・安定性・速度</h2>
{table(['条件','近似スコア','全点スコア','近似と全点の分類ARI','近似ms','全点ms'], sampling_rows)}
<p>同じseedで再生成した結果と回答の読み込み順を逆にした結果は完全一致。明瞭な3群から10%の回答を決定的に間引いても、分類のARIは元との比較で{f(data['robustness']['removeTenPercent']['labelARI'])}でした。通常1,000人・40意見の計算はローカルNodeで概ね35〜80ms。Cloudflare本番のCPU・メモリ制限や同時アクセス性能はこの計測からは判断できません。</p>
<h2>データ生成と再現</h2>
<p>各人に潜在的な2次元の意見と40意見への回答を先に生成し、実際の抽選処理tag-mixture-v2で回答項目を選びます。回答候補は賛成・反対・パス・無関係。一般の条件はパス8%・無関係2%、8意見に共通支持を仕込み、残りは意見の方向と潜在位置によるロジスティック確率で賛否を作ります。意見文の内容をモデルで読んだものではなく、番号に沿って人工の確率を割り当てています。</p>
<p>通常のDBと別の新しいローカルD1/R2へ投入し、APIと画面を確認しました。投稿・回答の本番保存、GitHubへの送信、サイトの公開は行っていません。</p>
<pre>npm run simulate:polis\n# 画面を再作成（既に起動中なら別ポート）\nnpx vinext build\nnpm run preview:simulation -- outputs/polis-simulation/fixture-three.json --port 5185</pre>
<p>TypeScriptを直接実行できるNodeとPythonのmatplotlibが必要（今回のNode: {data["node"]}）。出力先は環境変数SIMULATION_OUTPUT、反復数はSIMULATION_REPEATS。図の色と軸の向きに政治的な意味はありません。設定比較の多くは固定seed1本であり、数値最適化や実データへの適合を保証しません。</p>
<p class="files"><a href="results.json">全結果・設定・実装SHA-256</a> / <a href="fixture-three.json">1,000人の人工回答</a> / <a href="edges.json">境界ケース</a> / <a href="preview-verification.json">ローカルAPI検証</a></p>
"""
page = """<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polis機能の人工回答検証</title><style>
*{box-sizing:border-box}body{margin:0;color:#17253c;background:#f7f9fc;font-family:system-ui,-apple-system,sans-serif;line-height:1.85}main{max-width:1180px;margin:auto;padding:44px 28px 70px}h1{font-size:32px;line-height:1.5;max-width:850px}h2{margin:50px 0 15px;font-size:23px;border-top:1px solid #d8e0ec;padding-top:24px}h3{font-size:18px}p{max-width:1000px}.lead{font-size:20px;max-width:950px}.eyebrow{color:#315c99;font-weight:600}a{color:#2455dd}figure{margin:28px 0}img{width:100%;display:block;background:#fff}figcaption{font-size:13px;color:#4c5d76;margin-top:8px}table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}th,td{padding:11px 13px;border-bottom:1px solid #dce3ed;text-align:left;vertical-align:top}th{background:#edf2fa;font-weight:600}td{font-variant-numeric:tabular-nums}.table-wrap{overflow-x:auto}pre{padding:18px;background:#edf2fa;white-space:pre-wrap;overflow-wrap:anywhere}li{margin:12px 0}.files{border-top:1px solid #cbd6e6;padding-top:20px}@media(max-width:600px){main{padding:26px 16px}h1{font-size:25px}.lead{font-size:17px}td,th{padding:9px}h2{font-size:21px}}@media print{body{background:white}main{padding:0}h2{break-after:avoid}figure,table{break-inside:avoid}}
</style></head><body><main>""" + content + "</main></body></html>"
(OUT / "report.html").write_text(page)
# Preserve a concise, readable text entrypoint alongside the full tables.
intro = """# 1,000人の人工回答でPolis機能を検証

明瞭な2〜4群はよく再現できたが、調整前のsilhouette閾値0.2では無構造の回答にも3群を作る。0.4は今回のランダム対照を抑える試験用候補。連続的な1次元の意見はそれでも2群となり、閾値だけで離散的な集団の存在は判定できない。98対2の少数派の回復にも失敗した。このレポートは調整前の固定設定。現在の既定値との比較は [調整レポート](../polis-tuning/REPORT.md) を参照。

詳細・全結果・設定評価・図は [検証レポート](report.html) を参照。

ローカル画面: http://127.0.0.1:5185/participate →「共通する意見を見る」。1,000人・20,000回答、3群、共通点8件。すべて人工データ。

調整前の固定設定を再実行: `npm run simulate:polis`。現在の設定との比較: `npm run tune:polis`。通常DBとは別のローカル状態で検証。本番・GitHubへの送信なし。
"""
(OUT / "REPORT.md").write_text(intro)
print(f"Rendered: {OUT / 'report.html'}")
