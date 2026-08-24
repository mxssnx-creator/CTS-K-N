const {
  backfillLegacyDirectTradeLegControlIds,
  legacyControlIdForLeg,
} = require("../../lib/direct-trade-ledger-recovery.cjs")

describe("Direct-Trade legacy exchange-accounting recovery", () => {
  test("restores deterministic controls for an already closed entry and Block leg", () => {
    const position = {
      id: "dt_BTCUSDT_short_5m_1787552262576",
      symbol: "BTCUSDT",
      mode: "live",
      status: "closed",
      openControlId: "dtopen_dt_BTCUSDT_short_5m_1787552262576",
      openOrderId: "2091771924816547840",
      positionLegs: [
        { blockCount: 0, orderId: "2091771924816547840", quantity: 0.001 },
        { blockCount: 1, orderId: "2091772189074477056", quantity: 0.001 },
      ],
      blockLegs: [
        { blockCount: 0, orderId: "2091771924816547840", quantity: 0.001 },
        { blockCount: 1, orderId: "2091772189074477056", quantity: 0.001 },
      ],
    }

    const recovered = backfillLegacyDirectTradeLegControlIds(position)

    expect(recovered).not.toBe(position)
    expect(recovered.status).toBe("closed")
    expect(recovered.positionLegs).toEqual([
      expect.objectContaining({
        orderId: "2091771924816547840",
        controlId: "dtopen_dt_BTCUSDT_short_5m_1787552262576",
      }),
      expect.objectContaining({
        orderId: "2091772189074477056",
        controlId: "dtblk_DT_short_5m_1787552262576_1_0",
      }),
    ])
    expect(recovered.blockLegs.map((leg: any) => leg.controlId)).toEqual(
      recovered.positionLegs.map((leg: any) => leg.controlId),
    )
    expect(position.positionLegs.every((leg) => !("controlId" in leg))).toBe(true)
  })

  test("uses the matching DCA lineage and never invents a control without an exchange order", () => {
    const position = {
      id: "dt_SOLUSDT_long_15m_1787552999999",
      mode: "live",
      status: "open",
      openControlId: "dtopen_SOL_existing",
      openOrderId: "entry-order",
      blockLegs: [
        { blockCount: 0, orderId: "entry-order" },
        { step: 2, orderId: "dca-order" },
        { step: 3, quantity: 5 },
      ],
      dcaLegs: [
        { step: 2, orderId: "dca-order" },
        { step: 3, quantity: 5 },
      ],
    }

    const recovered = backfillLegacyDirectTradeLegControlIds(position)

    expect(recovered.positionLegs).toHaveLength(3)
    expect(recovered.positionLegs[0].controlId).toBe("dtopen_SOL_existing")
    expect(recovered.positionLegs[1].controlId).toBe(
      legacyControlIdForLeg(position, { step: 2, orderId: "dca-order" }),
    )
    expect(recovered.positionLegs[2].controlId).toBeUndefined()
    expect(recovered.dcaLegs[1].controlId).toBeUndefined()
  })

  test("leaves pseudo ledgers and unrelated initial order ids untouched", () => {
    const pseudo = { mode: "pseudo", positionLegs: [{ blockCount: 1, orderId: "paper" }] }
    expect(backfillLegacyDirectTradeLegControlIds(pseudo)).toBe(pseudo)

    expect(legacyControlIdForLeg({
      id: "position-1",
      openControlId: "dtopen_position-1",
      openOrderId: "initial-order",
    }, {
      blockCount: 0,
      orderId: "different-order",
    })).toBeNull()
  })
})
