import {DEFAULT_STRATEGY_EXECUTION_POLICY,STRATEGY_PROCESSING_RANGES,normalizeStrategyExecutionPolicy,isStrategySetExecutionEnabled,isMainTrailingAllowed,normalizeStrategyProcessingByRange} from "@/lib/strategy-execution-policy"

describe("overall and exact coordination processing switches",()=>{
  test("both masters apply independently to every coordination and additional strategy",()=>{
    for(const range of STRATEGY_PROCESSING_RANGES)for(const normal of [false,true])for(const trailing of [false,true])for(const ownNormal of [false,true])for(const ownTrailing of [false,true]){
      const policy={...DEFAULT_STRATEGY_EXECUTION_POLICY,normalEnabled:normal,trailingEnabled:trailing,axisEnabled:true,blockEnabled:true,dcaEnabled:true,processingByRange:{[range]:{normal:ownNormal,trailing:ownTrailing}}}
      const row={strategyRange:range,indicationType:range==='signals'?'signal':'trend'}
      expect(isStrategySetExecutionEnabled(row,policy)).toBe(normal&&ownNormal)
      expect(isStrategySetExecutionEnabled({...row,trailingProfile:{mode:'fixed'}},policy)).toBe(normal&&ownNormal&&trailing&&ownTrailing)
      for(const variant of ['block','dca'])expect(isStrategySetExecutionEnabled({...row,variant},policy)).toBe(true)
      expect(isMainTrailingAllowed({...row,trailingMode:'signal_dynamic'},policy)).toBe(trailing&&ownTrailing)
    }
  })
  test("saved JSON switches retain false and a range never borrows another range",()=>{
    const map={main:{normal:false,trailing:false},signals:{normal:true,trailing:true}}
    const policy=normalizeStrategyExecutionPolicy({strategyProcessingByRange:JSON.stringify(map)})
    expect(policy.processingByRange).toEqual(map)
    expect(isStrategySetExecutionEnabled({strategyRange:'main'},policy)).toBe(false)
    expect(isStrategySetExecutionEnabled({strategyRange:'preset'},policy)).toBe(true)
    expect(normalizeStrategyProcessingByRange({main:{normal:'false',trailing:false}})).toEqual({main:{trailing:false}})
  })
})
