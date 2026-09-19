/**
 * Deterministic, synthetic edge cases for the actual local Polis implementation.
 * Run: node scripts/simulate-polis-edges.ts
 *
 * The original scenarios freeze the legacy behavior, including its limitations;
 * they are not endorsements of that behavior. No database or network is used.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AnalysisAccumulator,
  analyzeAccumulated,
  DEFAULT_ANALYSIS_OPTIONS,
  type Analysis,
  type AnalysisOptions,
  type Vote,
} from "../lib/polis-math.ts";

import { LEGACY_ANALYSIS_OPTIONS } from "./simulate-polis.ts";

const opinionIds = Array.from({ length: 40 }, (_, i) => `edge-opinion-${i}`);
const sessionId = (i: number) => `edge-session-${String(i).padStart(4, "0")}`;
const summarize = (analysis: Analysis) => ({
  status: analysis.status,
  message: analysis.message,
  eligible: analysis.eligible,
  plottedSessions: analysis.points.length,
  groupSizes: analysis.groups.map(group => group.size),
  silhouette: analysis.silhouette ?? null,
  explained: analysis.explained ?? null,
  bridges: analysis.bridges,
});
function run(votes: Vote[], ids = opinionIds, options:AnalysisOptions=LEGACY_ANALYSIS_OPTIONS) {
  const { analysis, diagnostics } = analyzeAccumulated(
    new AnalysisAccumulator(ids).add(votes),
    options,
  );
  return { analysis, diagnostics };
}
function denseFixture(count: number, value: (session: number, opinion: number) => number): Vote[] {
  return Array.from({ length: count }, (_, session) =>
    opinionIds.map((opinion_id, opinion) => ({
      session_id: sessionId(session), opinion_id, value: value(session, opinion),
    })),
  ).flat();
}

// 999 connected participants form two exact, opposed profiles with four shared
// agreements. The newcomer meets eligibility using six substantive answers,
// but four of those opinions have no other responses and are dropped as columns.
const connectedVotes = denseFixture(999, (session, opinion) =>
  opinion < 4 ? -1 : session < 500 ? (opinion % 2 ? -1 : 1) : (opinion % 2 ? 1 : -1),
);
const baseline = run(connectedVotes);
assert.equal(baseline.analysis.status, "ready");
assert.deepEqual(baseline.analysis.groups.map(group => group.size).sort((a, b) => a - b), [499, 500]);
assert.equal(baseline.analysis.points.length, 999);
assert.equal(baseline.diagnostics.overlapConnected, true);
const privateOpinionIds = Array.from({ length: 4 }, (_, i) => `edge-new-opinion-${i}`);
const newcomerVotes = [...opinionIds.slice(0, 2), ...privateOpinionIds].map(opinion_id => ({
  session_id: sessionId(999), opinion_id, value: -1,
}));
const disconnected = run([...connectedVotes, ...newcomerVotes], [...opinionIds, ...privateOpinionIds]);
assert.equal(disconnected.analysis.eligible, 1_000);
assert.equal(disconnected.analysis.status, "collecting");
assert.equal(disconnected.analysis.points.length, 0);
assert.equal(disconnected.analysis.groups.length, 0);
assert.equal(disconnected.diagnostics.overlapConnected, false);
assert.equal(disconnected.diagnostics.filteredOpinions, 4);

// A near-perfect 997/3 separation says nothing about how reliable a 2/3 observed
// agreement is in the smaller group. Both count and rate gates currently pass.
const minorityVotes = denseFixture(1_000, (session, opinion) =>
  opinion === 0 ? (session === 999 ? 1 : -1) : (session < 997 ? -1 : 1),
);
const minority = run(minorityVotes);
assert.equal(minority.analysis.status, "ready");
assert.deepEqual(minority.analysis.groups.map(group => group.size).sort((a, b) => a - b), [3, 997]);
assert.ok((minority.analysis.silhouette ?? 0) > .99);
const minorityBridge = minority.analysis.bridges.find(bridge => bridge.id === opinionIds[0]);
assert.ok(minorityBridge);
assert.ok(minorityBridge.groups.some(group => group.seen === 3 && group.agree === 2 && group.rate === 2 / 3));
assert.ok(minorityBridge.groups.some(group => group.seen === 997 && group.agree === 997));

// Every substantive answer has exactly the same direction. Only the use of
// pass differs: 500 people agree to all 40; 500 agree to six and pass on 34.
const passStyleVotes = denseFixture(1_000, (session, opinion) =>
  opinion < 6 || session < 500 ? -1 : 0,
);
const passStyle = run(passStyleVotes);
assert.equal(passStyle.analysis.status, "ready");
assert.equal(passStyle.analysis.eligible, 1_000);
assert.deepEqual(passStyle.analysis.groups.map(group => group.size), [500, 500]);
assert.ok(Math.abs((passStyle.analysis.silhouette ?? 0) - 1) < 1e-10);
assert.equal(passStyleVotes.filter(vote => vote.value === 1).length, 0);
assert.equal(passStyle.analysis.bridges.length, 6);

/** Exact finite-binomial sum, evaluated in floating point (n <= 30 here). */
function binomialTail(n: number, p: number, minimumSuccesses: number): number {
  let combination = 1;
  let probability = 0;
  for (let successes = 0; successes <= n; successes++) {
    if (successes >= minimumSuccesses) {
      probability += combination * p ** successes * (1 - p) ** (n - successes);
    }
    combination *= (n - successes) / (successes + 1);
  }
  return probability;
}
const illustrativeBinomial = [3, 10, 20, 30].map(responsesPerGroup => {
  const minimumAgreements = Array.from({ length: responsesPerGroup + 1 }, (_, n) => n)
    .find(n => n / responsesPerGroup >= LEGACY_ANALYSIS_OPTIONS.minBridgeAgreement)!;
  const oneGroupPassProbability = binomialTail(responsesPerGroup, .5, minimumAgreements);
  const twoGroupPassProbability = oneGroupPassProbability ** 2;
  return {
    responsesPerGroup,
    minimumAgreements,
    oneGroupPassProbability,
    twoGroupPassProbability,
    expectedAcceptedStatementsOutOf40: 40 * twoGroupPassProbability,
  };
});
assert.equal(illustrativeBinomial[0].expectedAcceptedStatementsOutOf40, 10);
assert.ok(Math.abs(illustrativeBinomial[1].oneGroupPassProbability - 386 / 1024) < 1e-12);


// Re-evaluate the same fixtures with the actual app defaults. Keep the original
// scenarios schema intact so the historical report renderer remains readable.
const currentBaseline=run(connectedVotes,opinionIds,DEFAULT_ANALYSIS_OPTIONS);
const currentDisconnected=run([...connectedVotes,...newcomerVotes],[...opinionIds,...privateOpinionIds],DEFAULT_ANALYSIS_OPTIONS);
const currentMinority=run(minorityVotes,opinionIds,DEFAULT_ANALYSIS_OPTIONS);
const currentPassStyle=run(passStyleVotes,opinionIds,DEFAULT_ANALYSIS_OPTIONS);
assert.equal(currentBaseline.analysis.status,"ready");
assert.equal(currentDisconnected.analysis.status,"collecting");
assert.equal(currentDisconnected.diagnostics.overlapConnected,false);
assert.equal(currentMinority.analysis.status,"ready");
assert.deepEqual(currentMinority.analysis.groups.map(g=>g.size).sort((a,b)=>a-b),[3,997]);
assert.equal(currentMinority.analysis.bridges.length,0);
assert.equal(currentPassStyle.analysis.status,"ready");
assert.deepEqual(currentPassStyle.analysis.groups.map(g=>g.size),[500,500]);
const comparison=(id:string,before:ReturnType<typeof run>,after:ReturnType<typeof run>,interpretation:string)=>({
 id,before:{...summarize(before.analysis),diagnostics:before.diagnostics},after:{...summarize(after.analysis),diagnostics:after.diagnostics},interpretation,
});
const currentComparisons=[
 comparison("one-disconnected-eligible-session",disconnected,currentDisconnected,"接続性条件は据え置き。1人の疎な回答で全体の分類を保留する問題は残る。"),
 comparison("three-person-minority-bridge",minority,currentMinority,"明瞭な3人の小群は残すが、2/3賛成による共通点は除外する。少数派を復元する一般的な保証ではない。"),
 comparison("agreement-versus-pass-style",passStyle,currentPassStyle,"パスの使い方だけによる分類は残る。今回の閾値調整の範囲外。"),
];

const report = {
  schemaVersion: 2,
  currentComparisons,
  currentOptions: DEFAULT_ANALYSIS_OPTIONS,
  syntheticOnly: true,
  title: "Polis local synthetic edge cases",
  reproducibility: {
    command: "node scripts/simulate-polis-edges.ts",
    deterministic: true,
    implementation: "lib/polis-math.ts",
    options: LEGACY_ANALYSIS_OPTIONS,
    profile: "frozen-legacy-before-tuning",
    databaseUsed: false,
    networkUsed: false,
  },
  scenarios: [
    {
      id: "one-disconnected-eligible-session",
      title: "回答の重なりが少ない1人の追加で999人の分類も保留になる",
      construction: "999人が40意見に回答し、500人と499人の明確な2群を形成。追加の1人は既存2意見と新規4意見に賛成し、6件回答の資格を満たす。新規4意見は回答数不足で分析列から除外される。",
      before: { ...summarize(baseline.analysis), diagnostics: baseline.diagnostics },
      after: { ...summarize(disconnected.analysis), diagnostics: disconnected.diagnostics },
      interpretation: "全対象セッションの接続を要求する現行仕様により、疎な1セッションが全体の分類を止める。",
    },
    {
      id: "three-person-minority-bridge",
      title: "997人対3人の分類で少数群の2/3賛成が共通点に入る",
      construction: "39意見で997人と3人が正反対に回答。残り1意見には大群997人全員と小群3人中2人が賛成。",
      result: { ...summarize(minority.analysis), diagnostics: minority.diagnostics },
      interpretation: "群の分離は明確でも、3回答による共通点の賛成率には大きな不確実性がある。",
    },
    {
      id: "agreement-versus-pass-style",
      title: "実質的な賛否の方向が同じでもパスの使い方で2群になる",
      construction: "500人は40意見すべて賛成。500人は最初の6意見に賛成して残り34意見をパス。反対票は0件。",
      result: { ...summarize(passStyle.analysis), diagnostics: passStyle.diagnostics },
      interpretation: "パスを観測値0としてPCAに含めるため、回答態度の違いも群を作る。これは現行仕様に由来する。",
    },
  ],
  illustrativeBinomial: {
    label: "固定した2群での二項分布による説明用計算。実データのFDR推定ではない。",
    assumptions: [
      "群は事前に固定し、群分けの推定・選択の影響を含めない。",
      "各群・各意見の真の賛成確率は50%。各群の回答は独立なベルヌーイ試行。",
      "群間の回答は独立。各意見は2群のそれぞれで表記した一定数の回答を得る。",
      "パス・欠損・提示方式の偏りは含めない。",
      "40意見それぞれについて両群の観測賛成率60%以上を条件とする。",
      "表の回答数を最低回答数として用いても、その数ちょうどの意見には示した誤通過確率が残る。",
      "真の賛成率が60%未満なのに条件を通過する件数の期待値。実運用のfalse discovery rateを意味しない。",
    ],
    groups: 2,
    statements: 40,
    trueAgreementProbability: .5,
    observedAgreementThreshold: LEGACY_ANALYSIS_OPTIONS.minBridgeAgreement,
    rows: illustrativeBinomial,
  },
};

const outputDirectory = new URL("../outputs/polis-simulation/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
const outputFile = new URL("edges.json", outputDirectory);
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`PASS: 3 legacy edge scenarios + 3 current-default comparisons; output ${fileURLToPath(outputFile)}`);
console.log(JSON.stringify({
  disconnected: { before: baseline.analysis.status, after: disconnected.analysis.status, eligible: disconnected.analysis.eligible },
  minority: { groups: minority.analysis.groups.map(group => group.size), silhouette: minority.analysis.silhouette, bridge: minorityBridge.groups },
  passStyle: { groups: passStyle.analysis.groups.map(group => group.size), silhouette: passStyle.analysis.silhouette },
  currentComparisons:currentComparisons.map(r=>({id:r.id,status:r.after.status,groups:r.after.groupSizes,bridges:r.after.bridges.length})),
  binomial: illustrativeBinomial,
}, null, 2));
