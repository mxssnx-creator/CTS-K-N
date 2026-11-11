// Jest runs these tests as CommonJS. Preserve vendored ES-module source and
// compile its exports for this test process, without a production-code shim.
const ts=require('typescript');
module.exports={process(source,filename){return {code:ts.transpileModule(source,{fileName:filename.replace(/\.mjs$/,'.js'),compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,allowJs:true,esModuleInterop:true}}).outputText}}};
