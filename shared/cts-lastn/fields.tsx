"use client";
import * as React from "react";
import {DEFAULT_BLOCK_POLICY,LONG_COUNTS,SHORT_COUNTS,MINIMAL_COUNTS,blockRequired,type BlockPolicy} from "./blocks.ts";
const SHORT_OPTIONS = [0, 4, 8, 12, 16, 20, 24, 28, 30, ...SHORT_COUNTS];
/** Settings only: enabling a policy never enables exchange trading. */
export function BlockPolicyFields({value,onChange,label="Disjoint Last-N blocks"}:{value?:BlockPolicy;onChange:(v:BlockPolicy|undefined)=>void;label?:string}){
 const p=value??DEFAULT_BLOCK_POLICY;
 const count=(name:"long"|"short"|"minimal",grid:readonly number[])=><label style={{display:"grid",gap:4}}>{name} closes<select aria-label={label+" "+name} value={p[name]} onChange={e=>{const next={...p,[name]:Number(e.target.value)};if(blockRequired(next)>0)onChange(next)}}>{[...new Set([...grid,p[name]])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n===0?"Omit":n}</option>)}</select></label>;
 const sign=(name:"shortPolarity"|"minimalPolarity")=><label style={{display:"grid",gap:4}}>{name==="shortPolarity"?"Short":"Minimal"} condition<select aria-label={label+" "+name} value={p[name]} onChange={e=>onChange({...p,[name]:e.target.value as "positive"|"negative"})}><option value="positive">Positive</option><option value="negative">Negative</option></select></label>;
 return <fieldset style={{border:"1px solid currentColor",borderRadius:8,padding:12,marginBlock:12}}><legend>{label}</legend><label><input type="checkbox" checked={Boolean(value)} onChange={e=>onChange(e.target.checked?{...DEFAULT_BLOCK_POLICY}:undefined)}/> Use separate consecutive blocks</label>{value&&<><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:12,marginTop:12}}>{count("long",[0,...LONG_COUNTS])}{count("short",SHORT_OPTIONS)}{count("minimal",[0,...MINIMAL_COUNTS])}{sign("shortPolarity")}{sign("minimalPolarity")}</div><p style={{fontSize:12,marginTop:10}}>{blockRequired(p)} completed positions across Long, Short and Last. Each block must meet its own condition. The stage PF uses the entire window.</p></>}</fieldset>;
}
