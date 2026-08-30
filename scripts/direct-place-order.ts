/**
 * Historical direct-order probe retired in favour of the supervised
 * `run-bingx-vst-live-soak.ts` lifecycle.  Keeping an executable that can
 * bypass the shared exposure ceiling and exact protection contract is unsafe,
 * even when guarded by an environment variable.  This file intentionally
 * exits before importing credentials or constructing a connector.
 */
function main(): never {
  console.error(
    "[test] Direct connector order placement is disabled. Use the supervised X02 BingX Prod-VST lifecycle with exact exposure and protection checks.",
  )
  process.exit(2)
}

main()
