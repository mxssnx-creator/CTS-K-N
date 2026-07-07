export interface PositionCalculation {
  category: string
  subcategory: string
  configurations: number
  positions_per_config: number
  total_positions: number
  limit_applied: number
  description: string
}

export interface SymbolAnalysis {
  symbol: string
  total_configurations: number
  total_theoretical_positions: number
  total_actual_positions: number
  categories: PositionCalculation[]
  summary: {
    indication_types: number
    strategy_types: number
    database_entries_per_minute: number
    storage_requirements_mb: number
  }
}

export class PositionCalculator {
  constructor(
    private settings?: {
      indicationRangeMin: number
      indicationRangeMax: number
      indicationRangeStep: number
      takeProfitRangeDivisor: number
    },
  ) {}

  calculateSymbolPositions(symbol: string): SymbolAnalysis {
    const categories: PositionCalculation[] = []

    // 1. INDICATION CALCULATIONS
    // Direction Indications
    const directionConfigs = this.calculateIndicationConfigs("direction")
    categories.push({
      category: "Indications",
      subcategory: "Direction Change",
      configurations: directionConfigs.configs,
      positions_per_config: 1, // Max 1 active position per configuration
      total_positions: directionConfigs.configs * 1,
      limit_applied: 1,
      description: `${directionConfigs.ranges} ranges × ${directionConfigs.price_ratios} price ratios × ${directionConfigs.variations} variations (1 active per config, TP coordinated)`,
    })

    // Move Indications
    const moveConfigs = this.calculateIndicationConfigs("move")
    categories.push({
      category: "Indications",
      subcategory: "Move Detection",
      configurations: moveConfigs.configs,
      positions_per_config: 1, // Max 1 active position per configuration
      total_positions: moveConfigs.configs * 1,
      limit_applied: 1,
      description: `${moveConfigs.ranges} ranges × ${moveConfigs.price_ratios} price ratios × ${moveConfigs.variations} variations (1 active per config, TP coordinated)`,
    })

    // Active Indications
    const activeConfigs = this.calculateIndicationConfigs("active")
    categories.push({
      category: "Indications",
      subcategory: "Active Trading",
      configurations: activeConfigs.configs,
      positions_per_config: 1, // Max 1 active position per configuration
      total_positions: activeConfigs.configs * 1,
      limit_applied: 1,
      description: `${activeConfigs.price_ratios} active thresholds (1.0%-3.0%) × ${activeConfigs.variations} time variations (1 active per config, TP coordinated)`,
    })

    // 2. STRATEGY CALCULATIONS
    // Base Strategies
    const baseStrategies = this.calculateStrategyConfigs("base")
    categories.push({
      category: "Strategies",
      subcategory: "Base Strategy",
      configurations: baseStrategies.configs,
      positions_per_config: 1, // Max 1 active position per configuration
      total_positions: baseStrategies.configs * 1,
      limit_applied: 1,
      description: `${baseStrategies.tp_factors} TP factors × ${baseStrategies.sl_ratios} SL ratios × ${baseStrategies.trailing_combos} trailing combos (1 active per config)`,
    })

    // Main Strategies
    const mainStrategies = this.calculateStrategyConfigs("main")
    categories.push({
      category: "Strategies",
      subcategory: "Main Strategy",
      configurations: mainStrategies.configs,
      positions_per_config: 1, // Max 1 active position per configuration
      total_positions: mainStrategies.configs * 1,
      limit_applied: 1,
      description: `Won/Loss analysis with ${mainStrategies.position_counts} position count variations (1 active per config)`,
    })

    // Real Strategies (2, 4 positions)
    const realStrategies = this.calculateStrategyConfigs("real")
    categories.push({
      category: "Strategies",
      subcategory: "Real Strategy",
      configurations: realStrategies.configs,
      positions_per_config: 1, // Max 1 active position per configuration
      total_positions: realStrategies.configs * 1,
      limit_applied: 1,
      description: `2 count variations (2,4) × ${realStrategies.base_configs} base configurations (1 active per config)`,
    })

    // Block Strategies
    const blockStrategies = this.calculateStrategyConfigs("block")
    categories.push({
      category: "Strategies",
      subcategory: "Block Strategy",
      configurations: blockStrategies.configs,
      positions_per_config: 1, // Max 1 active position per configuration
      total_positions: blockStrategies.configs * 1,
      limit_applied: 1,
      description: `2 block sizes × ${blockStrategies.increase_factors} increase factors × ${blockStrategies.base_configs} base configs (1 active per config)`,
    })

    // DCA Strategies
    const dcaStrategies = this.calculateStrategyConfigs("dca")
    categories.push({
      category: "Strategies",
      subcategory: "DCA Strategy",
      configurations: dcaStrategies.configs,
      positions_per_config: 1, // Max 1 active position per configuration
      total_positions: dcaStrategies.configs * 1,
      limit_applied: 1,
      description: `2 DCA levels (3,5) × ${dcaStrategies.base_configs} base configurations (1 active per config)`,
    })

    // 3. ACTIVE TRADING POSITIONS
    // These are real positions opened based on validated strategies
    categories.push({
      category: "Active Trading",
      subcategory: "Live Positions",
      configurations: 1,
      positions_per_config: 100, // Maximum concurrent live positions
      total_positions: 100,
      limit_applied: 100,
      description: "Real trading positions opened when strategies validate (mirrored from pseudo positions)",
    })

    const totalConfigs = categories.reduce((sum, cat) => sum + cat.configurations, 0)
    const totalTheoretical = categories.reduce((sum, cat) => sum + cat.configurations * cat.positions_per_config, 0)
    const totalActual = categories.reduce((sum, cat) => sum + cat.total_positions, 0)

    return {
      symbol,
      total_configurations: totalConfigs,
      total_theoretical_positions: totalTheoretical,
      total_actual_positions: totalActual,
      categories,
      summary: {
        indication_types: 3, // Direction, Move, Active
        strategy_types: 5, // Base, Main, Real, Block, DCA
        database_entries_per_minute: this.calculateDatabaseEntries(totalActual),
        storage_requirements_mb: this.calculateStorageRequirements(totalActual),
      },
    }
  }

  private calculateIndicationConfigs(type: "direction" | "move" | "active") {
    const ranges = this.getConfigurableRanges()
    const priceRatios =
      type === "active"
        ? [1.0, 1.5, 2.0, 2.5, 3.0] // 5 active thresholds
        : [0.2, 0.4, 0.6, 0.8, 1.0] // 5 price change ratios

    const variations = type === "active" ? 2 : 6 // 6 time/direction variations

    const validConfigs = this.filterConfigsByTakeProfitCoordination(ranges, type)

    return {
      ranges: validConfigs.length,
      price_ratios: priceRatios.length,
      variations,
      configs: validConfigs.length * priceRatios.length * variations,
    }
  }

  private getConfigurableRanges(): number[] {
    const settings = this.settings || {
      indicationRangeMin: 2,
      indicationRangeMax: 30,
      indicationRangeStep: 1,
      takeProfitRangeDivisor: 3,
    }

    const ranges = []
    for (let i = settings.indicationRangeMin; i <= settings.indicationRangeMax; i += settings.indicationRangeStep) {
      ranges.push(i)
    }
    return ranges
  }

  private filterConfigsByTakeProfitCoordination(ranges: number[], type: string): number[] {
    const settings = this.settings || {
      indicationRangeMin: 2,
      indicationRangeMax: 30,
      indicationRangeStep: 1,
      takeProfitRangeDivisor: 3,
    }

    return ranges.filter((range) => {
      const minTakeProfitRange = Math.max(1, Math.floor(range / settings.takeProfitRangeDivisor))
      // Only include ranges where minimum takeprofit is reasonable (at least 1)
      return minTakeProfitRange >= 1 && minTakeProfitRange <= range / 2
    })
  }

  private calculateStrategyConfigs(type: "base" | "main" | "real" | "block" | "dca") {
    const tpFactors = 5 // 2-20
    const slRatios = 5 // 0.5-2.5 (step 0.5)
    const trailingCombos = 3 // 3 trail_start × 3 trail_stop + 1 no-trailing = 3

    const baseConfigs = Math.min(tpFactors * slRatios * trailingCombos, 25) // Limited to 25 as per code

    switch (type) {
      case "base":
        return {
          tp_factors: tpFactors,
          sl_ratios: slRatios,
          trailing_combos: trailingCombos,
          configs: baseConfigs,
        }
      case "main":
        return {
          position_counts: 3, // Different main position counts
          configs: baseConfigs * 3,
        }
      case "real":
        return {
          base_configs: baseConfigs,
          configs: baseConfigs * 2, // 2 count variations (2,4)
        }
      case "block":
        return {
          base_configs: baseConfigs,
          increase_factors: 2, // Different increase factors
          configs: baseConfigs * 2 * 2, // 2 block sizes × 2 increase factors
        }
      case "dca":
        return {
          base_configs: baseConfigs,
          configs: baseConfigs * 2, // 2 DCA levels (3,5)
        }
      default:
        return { configs: 0 }
    }
  }

  private calculateDatabaseEntries(totalPositions: number): number {
    // Each position updates every second when active
    // Plus new positions created based on indications
    return totalPositions + totalPositions * 0.1 // 10% new positions per minute
  }

  private calculateStorageRequirements(totalPositions: number): number {
    // Each position record ~1KB, plus logs and statistics
    const positionData = totalPositions * 1 // 1KB per position
    const logData = totalPositions * 0.5 // 0.5KB per position for logs
    const statisticsData = totalPositions * 0.2 // 0.2KB per position for stats

    return (positionData + logData + statisticsData) / 1024 // Convert to MB
  }

  // Calculate for multiple symbols
  calculateMultiSymbolPositions(symbols: string[]): {
    symbols: SymbolAnalysis[]
    totals: {
      configurations: number
      positions: number
      database_entries_per_minute: number
      storage_mb: number
    }
  } {
    const symbolAnalyses = symbols.map((symbol) => this.calculateSymbolPositions(symbol))

    const totals = symbolAnalyses.reduce(
      (acc, analysis) => ({
        configurations: acc.configurations + analysis.total_configurations,
        positions: acc.positions + analysis.total_actual_positions,
        database_entries_per_minute: acc.database_entries_per_minute + analysis.summary.database_entries_per_minute,
        storage_mb: acc.storage_mb + analysis.summary.storage_requirements_mb,
      }),
      { configurations: 0, positions: 0, database_entries_per_minute: 0, storage_mb: 0 },
    )

    return {
      symbols: symbolAnalyses,
      totals,
    }
  }
}
