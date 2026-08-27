export function isRecoverableNextFilesystemRace(output) {
  const providerPath = /(?:ENOENT|ENOTEMPTY):[\s\S]{0,800}(?:\.next|pages-manifest|nft\.json|routes-manifest|prerender-manifest|\/export)/i
  // stdout and stderr are captured independently and joined only after the
  // child exits, so their textual order is not reliable. Require the complete
  // Next lifecycle signature without assuming which stream flushed first.
  const truncatedManifest =
    /(?=[\s\S]*Compiled successfully)(?=[\s\S]*Collecting page data)(?=[\s\S]*Unexpected end of JSON input)/i
  const postbuildRoutesManifestRace =
    /(?=[\s\S]*Compiled successfully)(?=[\s\S]*Collecting build traces)(?=[\s\S]*\[next-env\][\s\S]*routes-manifest\.json is missing or is not valid JSON)/i
  const missingBuildIdDuringExport =
    /(?=[\s\S]*Compiled successfully)(?=[\s\S]*Collecting page data)(?=[\s\S]*Could not find a production build in ["'][^"']*\.next[^"']*["'])(?=[\s\S]*next-export-no-build-id)/i
  const sourceFailure = /Failed to compile|webpack errors|Merge conflict marker|Syntax Error|Type error/i

  return (
    providerPath.test(output) ||
    truncatedManifest.test(output) ||
    postbuildRoutesManifestRace.test(output) ||
    missingBuildIdDuringExport.test(output)
  ) && !sourceFailure.test(output)
}
