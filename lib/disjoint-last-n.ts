import {checkBlockPolicy,type BlockPolicy} from "@/shared/cts-lastn/blocks";
export type StageBlockPolicies=Partial<Record<"base"|"main"|"real"|"live",BlockPolicy>>;
export function stageBlockPolicies(raw:unknown):StageBlockPolicies{
 if(raw==null||raw==="")return {};
 const value=typeof raw==="string"?JSON.parse(raw):raw;
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid Last-N block policies");
 const out:StageBlockPolicies={};
 for(const [stage,policy]of Object.entries(value)){
  if(!["base","main","real","live"].includes(stage))throw new Error("Unknown Last-N stage");
  checkBlockPolicy(policy as BlockPolicy);out[stage as keyof StageBlockPolicies]={...(policy as BlockPolicy)};
 }
 return out;
}
