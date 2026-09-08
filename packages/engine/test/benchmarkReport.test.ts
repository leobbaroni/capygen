import { describe, expect, it } from "vitest";
import { PAIR_ORDERS, claudeSnapshot, difference, processed, summarize, type Cohort, type Counters } from "../../../scripts/benchmark/report.js";
const usage=(n:number):Counters=>({uncachedInput:n,cacheRead:0,cacheWrite:0,output:0,reasoning:null,costUsd:null});
function cohort(baselines=[100,100,100],apps=[110,110,110]):Cohort {
  return {schemaVersion:1,cohortId:"fixture",revision:"fixture",sourceHash:"s",fixtureHash:"f",promptsHash:"p",createdAt:"fixture",pairs:PAIR_ORDERS.map((order,i)=>({pair:i+1,order,lanes:order.map(lane=>({
    lane,settingsHash:"same",effectiveHash:"same",cliVersion:"2.1.261",sdkVersion:"0.3.261",model:"claude-sonnet-5",effort:"low",error:null,
    turns:Array.from({length:20},(_,t)=>({turn:t+1,status:"done",usage:usage(lane==="baseline"?baselines[i]!:apps[i]!),durationMs:1})),
  }))}))};
}
describe("benchmark accounting",()=>{
  it("differences cumulative snapshots and counts cached input once, with reasoning inside output",()=>{
    const snapshot=claudeSnapshot({"claude-sonnet-5":{inputTokens:100,cacheReadInputTokens:200,cacheCreationInputTokens:300,outputTokens:40,thinkingTokens:15,costUSD:0.01}});
    expect(processed(snapshot)).toBe(640);
    const delta=difference(snapshot,{...snapshot,uncachedInput:110,cacheRead:220,cacheWrite:330,output:44,reasoning:16,costUsd:0.02});
    expect(processed(delta)).toBe(64);
    expect(processed(difference(snapshot,snapshot))).toBe(0);
    expect(()=>difference(snapshot,{...snapshot,cacheRead:199})).toThrow(/reset/);
    expect(()=>claudeSnapshot({"claude-sonnet-5":{inputTokens:1,outputTokens:1}})).toThrow(/Incomplete/);
  });
  it("uses pooled token ratio rather than unweighted mean or cost savings",()=>{
    const report=summarize(cohort([100,100,1000],[90,90,1200]));
    expect(report.mean).toBeCloseTo(1);
    expect(report.pooledRatio).toBeCloseTo(1.15);
    expect(report.verdict).toBe("fail");
    expect(summarize(cohort()).verdict).toBe("pass");
    expect(summarize(cohort([100,100,100],[110,110,111])).verdict).toBe("fail");
  });
  it("keeps failures and unknown usage unavailable instead of dropping a lane/pair",()=>{
    const missing=cohort();missing.pairs[1]!.lanes[0]!.turns.pop();
    expect(summarize(missing)).toMatchObject({verdict:"unavailable",pooledRatio:null});
    const unknown=cohort();unknown.pairs[0]!.lanes[0]!.turns[0]!.usage=null;
    expect(summarize(unknown).verdict).toBe("unavailable");
    const mismatch=cohort();mismatch.pairs[2]!.lanes[0]!.effectiveHash="changed";
    expect(summarize(mismatch).verdict).toBe("unavailable");
    const failed=cohort();failed.pairs[1]!.lanes[0]!.error="provider failure";
    expect(summarize(failed)).toMatchObject({verdict:"unavailable",pairs:expect.arrayContaining([expect.objectContaining({pair:2})])});
  });
});
