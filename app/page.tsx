import type { Metadata } from "next";
import { ArrowRight, ArrowUpRight, Check, MessageSquare, Network, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CREATOR_NAME, DATA_NOTICE } from "@/lib/public-data";

export const metadata:Metadata={title:"横浜の政策を考えるプロジェクト「ヨコハマの声」",description:"横浜の政策について意見と賛否を集め、異なる立場にも共通する考えを探すプロジェクト。Polisの仕組みと活用例を紹介します。"};

function JoinButton({className=""}:{className?:string}){
  return <Button asChild className={`landing-join ${className}`}><a href="/participate">自分も意見を表明する！<ArrowRight size={19}/></a></Button>;
}

function CommonGroundDiagram(){
  return <figure className="common-ground-diagram">
    <div className="diagram-heading"><Network size={20}/><span>違う立場にも、共通する考えがある</span></div>
    <svg viewBox="0 0 450 225" role="img" aria-label="回答の傾向が違う3つのグループから、共通して支持される意見を探す仕組みの図">
      <g fill="none" strokeWidth="1.5"><rect x="16" y="18" width="122" height="111" rx="14" fill="#eef3ff" stroke="#ccdafb"/><rect x="164" y="18" width="122" height="111" rx="14" fill="#eef7f5" stroke="#c5e0d9"/><rect x="312" y="18" width="122" height="111" rx="14" fill="#fff3eb" stroke="#edd4c1"/></g>
      <g fill="#2455dd"><circle cx="49" cy="52" r="7"/><circle cx="80" cy="45" r="7"/><circle cx="105" cy="65" r="7"/><circle cx="63" cy="78" r="7"/><circle cx="93" cy="91" r="7"/></g>
      <g fill="#168978"><circle cx="192" cy="64" r="7"/><circle cx="220" cy="44" r="7"/><circle cx="253" cy="56" r="7"/><circle cx="217" cy="84" r="7"/><circle cx="249" cy="91" r="7"/></g>
      <g fill="#bc5b2d"><circle cx="343" cy="51" r="7"/><circle cx="375" cy="46" r="7"/><circle cx="405" cy="69" r="7"/><circle cx="356" cy="85" r="7"/><circle cx="389" cy="92" r="7"/></g>
      <g fill="none" stroke="#a9b9d7" strokeWidth="1.5"><path d="M77 129 V152 H225 V174"/><path d="M225 129 V174"/><path d="M373 129 V152 H225"/></g>
      <rect x="82" y="174" width="286" height="43" rx="10" fill="#2455dd"/><text x="225" y="201" textAnchor="middle" fill="white" fontSize="15" fontWeight="600">グループをまたぐ共通点</text>
    </svg>
    <figcaption>回答の傾向からグループを作り、それぞれのグループで支持される意見を探します。<span>図は仕組みのイメージです。</span></figcaption>
  </figure>;
}

export default function Home(){return <main className="landing-page">
  <header className="site-header landing-header"><a className="brand" href="/"><span className="brand-mark" aria-hidden="true">声</span>ヨコハマの声</a><nav aria-label="トップページの案内"><a href="#about-polis">Polisとは</a><a href="#cases">活用例</a><span className="prototype">β版</span></nav></header>
  <div className="landing-content">
    <section className="landing-hero" aria-labelledby="project-title">
      <div className="landing-hero-copy"><h1 id="project-title"><span className="landing-project-description">横浜の政策を考えるプロジェクト</span>「ヨコハマの声」</h1><p className="landing-lead">同じ横浜で暮らしていても、困っていることや優先したいことは人それぞれ。</p><p className="landing-lead">ヨコハマの声は、政策についての意見と賛否を集め、立場の違いをこえて共有できる考えを探すプロジェクトです。</p><div className="landing-entry"><JoinButton/><p>回答だけでも参加できます。いつでも終えられます。</p></div></div>
      <CommonGroundDiagram/>
    </section>
    <section className="landing-purpose" aria-labelledby="purpose-title"><div className="landing-section-heading"><p className="landing-kicker">このプロジェクトでやりたいこと</p><h2 id="purpose-title">意見の違いと、<br className="desktop-break"/>一緒に考えられることを知る。</h2></div><div className="landing-purpose-copy"><p>子育て、交通、医療・福祉、まちづくり。身近な政策について、まずはそれぞれの考えを持ち寄ります。</p><p>回答が集まると、どこで意見が分かれるのか、異なる立場でもどの意見を支持できるのかが見えてきます。そうした共通点を、次の対話や政策を考える手がかりにしたいと考えています。</p></div></section>
    <section id="about-polis" className="landing-polis" aria-labelledby="polis-title"><div className="landing-section-heading"><p className="landing-kicker">使っている技術</p><h2 id="polis-title">Polis</h2><p>Polisは、短い意見とそれに対する賛否から、人々の考えのまとまりや共通点を探すオープンソースの技術です。</p></div><ol className="polis-steps"><li><span className="step-icon"><MessageSquare size={25}/></span><span className="landing-step-number">01</span><h3>意見を持ち寄る</h3><p>用意された意見に答えるだけでなく、自分の意見も投稿できます。</p></li><li><span className="step-icon"><Check size={25}/></span><span className="landing-step-number">02</span><h3>賛成・反対・パスで答える</h3><p>ほかの参加者の意見を読み、自分の考えに近い回答を選びます。わからない意見はパスできます。</p></li><li><span className="step-icon"><ScanLine size={25}/></span><span className="landing-step-number">03</span><h3>立場をまたぐ共通点を探す</h3><p>回答の似たグループを見つけ、それぞれのグループから支持される意見を探します。</p></li></ol><div className="polis-implementation"><p>ヨコハマの声では、Polisの公開コードを参考にした集計を使っています。回答の違いを図にまとめるPCAと、似た回答をグループに分けるk-meansが基本です。</p><div className="landing-source-links"><a href="/technology">技術解説はこちら<ArrowRight size={16}/></a><a href="https://compdemocracy.org/polis/" target="_blank" rel="noreferrer">Polisの公式説明<ArrowUpRight size={15}/></a></div></div></section>
    <section id="cases" className="landing-cases" aria-labelledby="cases-title"><div className="landing-section-heading"><p className="landing-kicker">これまでの活用例</p><h2 id="cases-title">集まった意見を、実際の議論へ。</h2><p>Polisは、行政のルールづくりや、市民が政策を話し合う場で使われてきました。</p></div><div className="polis-case-grid"><article className="polis-case"><p className="case-place">台湾 <span>2015年</span></p><h3>Uberをめぐるルールづくり</h3><p className="case-organization">vTaiwan</p><p>Polisに集まった意見から、公開協議で話し合う論点を整理。オンラインの回答と対面の議論を組み合わせ、共通して支持された内容を行政の制度検討につなげました。</p><a className="case-source" href="https://info.vtaiwan.tw/" target="_blank" rel="noreferrer">vTaiwanによる事例紹介<ArrowUpRight size={15}/></a></article><article className="polis-case"><p className="case-place">オーストリア <span>2022年</span></p><h3>気候政策を考える市民会議</h3><p className="case-organization">Klimarat</p><p>Polisで全国から意見を募集。約6,000人の回答や提案を、その後の議論と提言の見直しに生かしました。市民会議は最終的に93の政策提言を公表しました。</p><div className="case-source-group"><a className="case-source" href="https://klimarat.org/wp-content/uploads/20220515_PA_BilanzWE5.pdf" target="_blank" rel="noreferrer">参加結果の報告（PDF）<ArrowUpRight size={15}/></a><a className="case-source" href="https://klimarat.org/wp-content/uploads/20220704_PA_Praesentation-der-Empfehlungen.pdf" target="_blank" rel="noreferrer">政策提言の公表（PDF）<ArrowUpRight size={15}/></a></div></article></div><p className="case-context">いずれも、Polisでの意見収集を、対面の議論や政策検討につなげた取り組みです。</p></section>
    <section className="landing-invitation" aria-labelledby="invitation-title"><div><h2 id="invitation-title">あなたは、どう考えますか。</h2><p>まずは、いくつかの意見に答えてみてください。<br/>回答を終えたあとに、自分の意見を投稿することもできます。</p></div><JoinButton/></section>
    <footer className="landing-footer"><span>作成・運営：{CREATOR_NAME}</span><a href="/technology">技術解説はこちら</a><p className="public-data-notice footer-notice">{DATA_NOTICE} <a href="/research">保存する情報と研究利用について</a></p></footer>
  </div>
</main>;}
