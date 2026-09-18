import type { Metadata } from "next";
import { CREATOR_NAME, DATA_REPOSITORY } from "@/lib/public-data";

export const metadata: Metadata = {title: "技術解説｜ヨコハマの声", description: "回答をPCAで図にし、k-meansでグループに分け、共通する意見を探す方法を説明します。"};

function ClusterExample(){
  return <figure className="technical-figure"><svg viewBox="0 0 560 230" role="img" aria-label="計算例。左の2点の中心は0,1。右の2点の中心は8,1。左右がそれぞれ1グループになる。">
    <path d="M65 25 V190 H515" fill="none" stroke="#c4cfe2"/>
    <ellipse cx="140" cy="100" rx="57" ry="77" fill="#eaf0ff"/><ellipse cx="425" cy="100" rx="57" ry="77" fill="#fceee7"/>
    {[{x:140,y:45,label:"(0, 2)",color:"#2455dd"},{x:140,y:155,label:"(0, 0)",color:"#2455dd"},{x:425,y:45,label:"(8, 2)",color:"#b85b37"},{x:425,y:155,label:"(8, 0)",color:"#b85b37"}].map(p=><g key={p.label}><circle cx={p.x} cy={p.y} r="7" fill={p.color}/><text x={p.x+14} y={p.y+5} fontSize="15" fill="#34486b">{p.label}</text></g>)}
    <path d="M131 100 H149 M140 91 V109 M416 100 H434 M425 91 V109" stroke="#172b50" strokeWidth="3"/>
    <text x="90" y="220" fontSize="15" fill="#34486b">中心 (0, 1)</text><text x="375" y="220" fontSize="15" fill="#34486b">中心 (8, 1)</text>
  </svg><figcaption>k=2の説明用の例。実際の参加データではありません。</figcaption></figure>;
}

export default function Technology(){return <main className="technical-page">
  <header className="site-header"><a className="brand" href="/"><span className="brand-mark" aria-hidden="true">声</span>ヨコハマの声</a><a className="back-link" href="/participate">意見への回答に進む</a></header>
  <article className="technical-content">
    <h1>技術解説</h1><p className="technical-lead">回答の違いを図にし、似た回答をまとめ、グループをまたいで賛成される意見を探します。</p>
    <ol className="analysis-flow"><li><b>1</b>回答の表</li><li><b>2</b>PCAで図にする</li><li><b>3</b>k-meansで分類</li><li><b>4</b>共通点を探す</li></ol>
    <section><h2>1. 回答を表にする</h2><p>1セッションを1行、1件の意見を1列にした表を作ります。同じ人がもう一度参加すると、別の行になります。</p>
      <table className="technical-table"><thead><tr><th>回答</th><th>計算上の扱い</th></tr></thead><tbody><tr><td>賛成</td><td>−1</td></tr><tr><td>反対</td><td>＋1</td></tr><tr><td>パス</td><td>0</td></tr><tr><td>未回答</td><td>値なし</td></tr><tr><td>無関係</td><td>賛否の分析から除外</td></tr></tbody></table>
      <p>「無関係」は賛否とは別に記録します。PCA、グループ分け、共通点の賛成率では未回答と同じ扱いにします。</p>
      <p>パスは実際に選ばれた回答として0を使います。未回答は、PCAの計算時に、その意見への回答の平均で埋めます。たとえば「−1、−1、＋1」の平均は−1/3です。未回答の欄には計算上この平均を使うので、0を選んだパスとは異なります。保存済みのデータは書き換えません。</p>
    </section>
    <section><h2>2. PCA：回答の違いを2つの軸にまとめる</h2><p>PCAは「主成分分析」の略です。意見が40件あれば、1セッションには最大40個の回答があります。その違いを図にするため、2つの数値にまとめます。</p>
      <p>まず、回答のばらつきが最も大きくなる方向を探します。次に、その方向と直角で、残りのばらつきを最もよく表す方向を探します。この2方向を横軸と縦軸にして、各セッションを点で描きます。</p>
      <p>多くの意見に似た賛否をつけたセッションは、図でも近くに置かれやすくなります。ただし、元の回答の違いをすべて2つの軸に残せるわけではありません。</p>
      <p>軸に「保守・革新」などの意味はあらかじめ付けていません。回答が増えると、軸や点の位置も変わります。</p>
    </section>
    <section><h2>3. k-means：近くにある点をまとめる</h2><p>k-meansのkは、作るグループの数です。中心を仮に置き、各点を最も近い中心へ割り当てます。次に、グループ内の点の平均へ中心を動かします。割り当てが落ち着くまで、この操作を繰り返します。</p><ClusterExample/>
      <p>このサイトでは2〜4グループを試します。グループ内の点が近く、別のグループとは離れている分け方を「シルエット係数」という指標で選びます。十分に分かれていなければ、グループを表示しません。参加が多い場合、この指標の計算だけ一部の点を使って近似します。PCA、各点のグループ分け、共通点の集計には対象全員を含めます。</p>
      <p>分類は、このサイトに集まった回答についてのものです。本人の固定的な性格や所属を表すものではありません。</p>
    </section>
    <section><h2>4. グループをまたぐ共通点を探す</h2><p>グループを作ったら、意見ごとの賛成率を各グループで調べます。すべてのグループで3件以上の回答があり、賛成が60%以上の意見を共通点の候補にします。</p>
      <p>候補の順番には、各グループの「(賛成数＋1) ÷ (回答数＋2)」を掛け合わせた値を使います。回答数にはパスを含め、未回答と「無関係」は含めません。</p>
      <p>たとえば「5件中4件が賛成」と「5件中3件が賛成」の2グループなら、値は5/7 × 4/7 ≒ 0.408です。この値は並べ替えのための指標です。40.8%の人が合意している、という意味ではありません。</p>
    </section>
    <details className="technical-details"><summary>表示条件と、この実装について</summary>
      <ul><li>賛成・反対を6件以上答えたセッションが8件以上。</li><li>分析対象から3件以上の回答がある意見が6件以上。</li><li>共通する3件以上の意見に賛否を答えたセッション同士をたどって、分析対象の全セッションがつながること。</li><li>各グループに3セッション以上あり、シルエット係数が0.2以上。</li></ul>
      <p>Polisの公開コードのうち、PCAとグループをまたぐ賛成度の計算を参考にしています。PCAでは各意見の平均を引き、100回の反復で軸を求めます。2軸目の前に1軸目の成分を取り除き、点の座標には回答数に応じた補正をかけます。</p>
      <p>Polis本体にある、事前に小さな集団へまとめる処理や、更新前後の動きをなめらかにする処理は省いています。このサイトはPolis本体との完全互換ではありません。</p>
      <p>同じ人の再参加や参加者の偏りの影響を受けるため、横浜市民全体の世論調査としては扱えません。共通点の表示は、意見の正しさや実現可能性を保証しません。対象の全セッションを分析に使います。分析結果は共有して保存し、回答が増えた場合は約1分ごとに更新します。</p>
    </details>
    <section><h2>意見を表示する順番</h2><p>サーバーで無作為に選びます。まだ表示の少ない政策分野を優先し、その分野の中では、通常のランダム抽選を30%、賛否が割れる意見を優先する抽選を40%、回答が少ない意見を優先する抽選を30%混ぜています。全員一致に近い意見にも表示の機会を残します。</p><p>この比率は運用上の初期設定で、最適な比率と検証されたものではありません。表示のたびに、対象となった意見、抽選に使った件数、選ばれる確率、表示順と本文を保存します。確率はその時点の抽選条件に基づくもので、市民全体を代表するための重みではありません。</p><p>配信した記録と、画面に表示されたとブラウザから通知された記録を区別します。読まれたことまでは確認できません。<a href="/research">保存する情報と研究利用について</a></p></section><section><h2>データを使って分析する</h2><p>投稿と回答データは、運営者が公開候補を確認した後、版を付けて公開します。公開済みの最新版をGitHubとこのサイトから取得できます。「無関係」を含む回答の種類は区別して保存しています。</p>
      <div className="technical-links">{DATA_REPOSITORY&&<a href={DATA_REPOSITORY} target="_blank" rel="noreferrer">GitHubの公開データ・分析例</a>}<a href="/api/export" target="_blank" rel="noreferrer">公開済みデータ（JSON）</a><a href="/source.zip" download>サイトのソースコード</a><a href="/methodology.md" target="_blank" rel="noreferrer">集計仕様</a></div>
    </section>
    <section className="technical-sources"><h2>参考資料</h2><ul><li><a href="https://compdemocracy.org/polis-opinion-matrix/" target="_blank" rel="noreferrer">Polis：回答データの表</a></li><li><a href="https://compdemocracy.org/pca/" target="_blank" rel="noreferrer">Polis：PCAの説明</a></li><li><a href="https://scikit-learn.org/stable/modules/clustering.html#k-means" target="_blank" rel="noreferrer">scikit-learn：k-meansの解説</a></li><li><a href="https://github.com/compdemocracy/polis/tree/28b427324f751c8f1e42ab5df3d5111fe9f26db0/math/src/polismath/math" target="_blank" rel="noreferrer">参照したPolisのコード（pca.clj・conversation.clj）</a></li></ul></section>
    <footer><span>作成・運営：{CREATOR_NAME}</span><a href="/participate">意見への回答に進む</a></footer>
  </article>
</main>;}
