// Step-Based Indicators Calculator
// Calculates indicators (MA, RSI, MACD, BB) for each position cost step (2-30)
// This aligns indicators with your strategy's position sizing steps

export class StepBasedIndicators {
  static calculateAll(candles: any[], steps: number[] = Array.from({length: 28}, (_, i) => i + 3)) {
    const results: any = {}
    
    for (const step of steps) {
      results[step] = {
        ma: this.calculateMA(candles, step),
        rsi: this.calculateRSI(candles, step),
        macd: this.calculateMACD(candles, step),
        bb: this.calculateBollinger(candles, step),
      }
    }
    
    return results
  }
  
  static calculateMA(candles: any[], period: number) {
    if (candles.length < period) return 0
    let sum = 0
    for (let i = 0; i < period; i++) {
      sum += Number(candles[i].close) || 0
    }
    return sum / period
  }
  
  static calculateRSI(candles: any[], period: number) {
    if (candles.length < period + 1) return 50
    let gains = 0, losses = 0
    for (let i = 0; i < period; i++) {
      const change = (Number(candles[i].close) || 0) - (Number(candles[i+1].close) || 0)
      if (change > 0) gains += change
      else losses += Math.abs(change)
    }
    const rs = gains > 0 && losses > 0 ? gains / losses : 0
    return 100 - (100 / (1 + rs))
  }
  
  static calculateMACD(candles: any[], period: number) {
    const ma12 = this.calculateMA(candles, Math.min(12, period))
    const ma26 = this.calculateMA(candles, Math.min(26, period))
    return { macd: ma12 - ma26, signal: (ma12 - ma26) * 0.66 }
  }
  
  static calculateBollinger(candles: any[], period: number) {
    if (candles.length < period) return { upper: 0, middle: 0, lower: 0 }
    const ma = this.calculateMA(candles, period)
    let variance = 0
    for (let i = 0; i < period; i++) {
      const diff = (Number(candles[i].close) || 0) - ma
      variance += diff * diff
    }
    const stdDev = Math.sqrt(variance / period)
    return { upper: ma + (2 * stdDev), middle: ma, lower: ma - (2 * stdDev) }
  }
}
