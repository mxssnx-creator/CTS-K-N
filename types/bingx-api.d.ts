declare module "bingx-api" {
  export interface RequestExecutorInterface {
    execute<T>(endpoint: unknown): Promise<T>
  }

  export class HttpRequestExecutor implements RequestExecutorInterface {
    execute<T>(endpoint: unknown): Promise<T>
  }

  export class ApiAccount {
    constructor(apiKey: string, secretKey: string)
    getApiKey(): string
    sign(parameters: unknown): unknown
  }

  export class BingxApiClient {
    constructor(requestExecutor: RequestExecutorInterface)
    getTradeService(): {
      tradeOrder(order: Record<string, unknown>, account: ApiAccount): Promise<any>
      cancelOrder(orderId: string, symbol: string, account: ApiAccount): Promise<any>
      switchLeverage(symbol: string, leverage: number, side: "LONG" | "SHORT", account: ApiAccount): Promise<any>
      switchMarginMode(symbol: string, marginType: string, account: ApiAccount): Promise<any>
      closeAllPositions(account: ApiAccount): Promise<any>
      cancelAllOrders(symbol: string, account: ApiAccount): Promise<any>
      getUserHistoryOrders(symbol: string, limit: number, startTime: Date, endTime: Date, account: ApiAccount): Promise<any>
    }
    getAccountService(): {
      getPerpetualSwapAccountAssetInformation(account: ApiAccount): Promise<any>
      getPerpetualSwapPositions(symbol: string, account: ApiAccount): Promise<any>
    }
  }
}
