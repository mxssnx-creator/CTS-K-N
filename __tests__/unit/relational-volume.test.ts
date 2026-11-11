import {relationalVolumeFactor,relationalVolumeSettings} from '@/shared/cts-volume/ratios.ts'
import {VolumeCalculator} from '@/lib/volume-calculator'
import {CommonSeriesContext} from '@/lib/common-indicators/context'
import {getCommonRule,commonRuleStates} from '@/lib/common-indicators/registry'
import {PORTED_CATALOG} from '@/shared/cts-indications/catalog.ts'

test('all relative type/range weights apply exactly once before venue rounding, independently from Block sizing',()=>{
 const raw={overall:1.2,indicationTypes:{inverse:2},strategies:{axis:.5},ranges:{main:1.5}}
 const context={indicationType:'inverse',strategy:'axis',range:'main',symbol:'SOL-USDT'}
 const factor=relationalVolumeFactor(raw,context)
 expect(factor).toBeCloseTo(1.8)
 expect(relationalVolumeSettings(JSON.stringify(raw),true).indicationTypes).toEqual({inverse:2})
 const base={accountBalance:10000,currentPrice:100,positionCostPercent:.1,positionsAverage:1,leverage:10,exchangeMinVolume:0,tradeMode:'main' as const,mainVolumeFactor:1,sizeMultiplier:2}
 const neutral=VolumeCalculator.calculatePositionVolume(base)
 const raised=VolumeCalculator.calculatePositionVolume({...base,relationalVolumeMultiplier:factor})
 expect(raised.intendedNotionalUsd!/neutral.intendedNotionalUsd!).toBeCloseTo(factor,10)
 expect(raised.sizeMultiplier).toBe(neutral.sizeMultiplier)
 expect(relationalVolumeFactor(raw,{...context,range:'preset'})).toBeCloseTo(1.2)
})
test('Tactic and Inverse remain opt-in independent Common rules, with exact source histories and no generic fallback',()=>{
 const rows=Array.from({length:120},(_,i)=>({timestamp:1700000040000+i*60000,open:100+i,high:100.5+i,low:99.5+i,close:100+i,volume:10}))
 const ctx=new CommonSeriesContext(rows,1),rule=getCommonRule('inverseAo')!
 const index=PORTED_CATALOG.filter(s=>s.kind==='inverse').findIndex(s=>s.id==='inverse-known-ema-9-21')
 const states=commonRuleStates(ctx,rule,{sourceIndex:index})
 expect(states.at(-1)).toBe(-1)
 expect(commonRuleStates(new CommonSeriesContext(rows.slice(0,100),1),rule,{sourceIndex:index})).toEqual(states.slice(0,100))
 expect(()=>rule.resolve({sourceIndex:1000000},14)).toThrow()
 expect(commonRuleStates(new CommonSeriesContext(rows.map((r,i)=>({...r,timestamp:i})),1),rule,{sourceIndex:index}).every(x=>x===0)).toBe(true)
})
