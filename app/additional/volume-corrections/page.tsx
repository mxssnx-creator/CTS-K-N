"use client"
export const dynamic = "force-dynamic"


import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CheckCircle2, XCircle, AlertTriangle, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function VolumeCorrectionsPage() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Volume Calculation Corrections</h1>
          <p className="text-muted-foreground mt-2">
            Understanding the correct architecture for pseudo positions and volume calculations
          </p>
        </div>
        <Button variant="outline" asChild>
          <a href="/VOLUME_CALCULATION_CORRECTIONS.md" download>
            <FileText className="mr-2 h-4 w-4" />
            Download Full Documentation
          </a>
        </Button>
      </div>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <strong>Critical Architecture Principle:</strong> BASE, MAIN, and REAL pseudo positions do NOT use volume
          calculations. They use position counts and ratios only. Volume is calculated exclusively at the EXCHANGE
          level.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="progression">Progression</TabsTrigger>
          <TabsTrigger value="strategies">Strategies</TabsTrigger>
          <TabsTrigger value="examples">Examples</TabsTrigger>
          <TabsTrigger value="mistakes">Common Mistakes</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-destructive" />
                  Incorrect Approach (Old)
                </CardTitle>
                <CardDescription>Volume calculated at Base/Main/Real levels</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                  {`// ❌ WRONG
const basePosition = {
  volume: calculateVolume(
    baseVolumeFactor
  ),
  entryPrice: 50000,
  quantity: volume / entryPrice
}`}
                </pre>
                <p className="mt-4 text-sm text-muted-foreground">
                  This approach incorrectly calculates volume before reaching the Exchange level, coupling strategy
                  logic with account balance.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  Correct Approach (New)
                </CardTitle>
                <CardDescription>Volume only at Exchange level</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                  {`// ✅ CORRECT
const basePseudoPosition = {
  positionCost: 0.1, // 10%
  ratio: 1.0,
  entryPrice: 50000
  // NO volume field
}

// Later at Exchange:
const volume = calculate(
  positionCost,
  accountBalance
)`}
                </pre>
                <p className="mt-4 text-sm text-muted-foreground">
                  This approach keeps pseudo positions independent of account balance, calculating volume only when
                  executing on the exchange.
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Key Principles</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
                <div>
                  <p className="font-medium">Pseudo Positions Use Ratios</p>
                  <p className="text-sm text-muted-foreground">
                    Base/Main/Real levels work with position cost ratios (0.01-1.0) representing percentages
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
                <div>
                  <p className="font-medium">Volume Only at Exchange</p>
                  <p className="text-sm text-muted-foreground">
                    Actual volume calculation happens exclusively when executing orders on exchanges
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
                <div>
                  <p className="font-medium">Strategies Use Factors</p>
                  <p className="text-sm text-muted-foreground">
                    Block and DCA strategies adjust ratios and factors, not volumes
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
                <div>
                  <p className="font-medium">Account Size Independent</p>
                  <p className="text-sm text-muted-foreground">
                    Pseudo positions work the same regardless of account balance
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="progression" className="space-y-4">
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>BASE Level</CardTitle>
                <CardDescription>Foundation calculation without limits</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <p className="font-medium text-sm">What it uses:</p>
                    <ul className="list-disc list-inside text-sm text-muted-foreground">
                      <li>Position counts</li>
                      <li>Ratios (positionCost: 0.01-1.0)</li>
                      <li>Entry price</li>
                      <li>TP/SL factors</li>
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium text-sm">What it does NOT use:</p>
                    <ul className="list-disc list-inside text-sm text-destructive">
                      <li>Volume</li>
                      <li>Quantity</li>
                      <li>Account balance</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>MAIN Level</CardTitle>
                <CardDescription>Filter by strategy signals using step counts</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <p className="font-medium text-sm">What it uses:</p>
                    <ul className="list-disc list-inside text-sm text-muted-foreground">
                      <li>Step counts based on positionCost</li>
                      <li>Cost ratios</li>
                      <li>Signal validation</li>
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium text-sm">What it does NOT use:</p>
                    <ul className="list-disc list-inside text-sm text-destructive">
                      <li>Volume calculations</li>
                      <li>Actual quantities</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>REAL Level</CardTitle>
                <CardDescription>Validate affordability using ratios</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <p className="font-medium text-sm">What it uses:</p>
                    <ul className="list-disc list-inside text-sm text-muted-foreground">
                      <li>Position cost validation</li>
                      <li>Ratio checks</li>
                      <li>Affordability assessment</li>
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium text-sm">What it does NOT use:</p>
                    <ul className="list-disc list-inside text-sm text-destructive">
                      <li>Actual volume until exchange execution</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-green-200">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  EXCHANGE Level
                </CardTitle>
                <CardDescription>Execute actual orders with real volume</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <p className="font-medium text-sm text-green-600">First time volume appears:</p>
                    <ul className="list-disc list-inside text-sm text-muted-foreground">
                      <li>Account balance (real)</li>
                      <li>Volume calculation: positionCost × accountBalance / (entryPrice × leverage)</li>
                      <li>Quantity: volume / entryPrice</li>
                      <li>Margin used (real calculation)</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="strategies" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Block Strategy</CardTitle>
                <CardDescription>Works with ratios, not volume</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                  {`// ✅ CORRECT
function applyBlockAdjustment(
  positions: Position[],
  baseRatio: number,
  blockSize: number,
  adjustmentRatio: number
): number {
  const blocks = group(
    positions, 
    blockSize
  )
  const lastBlock = blocks[
    blocks.length - 1
  ]
  
  const profitFactor = 
    calculateAvg(lastBlock)
  
  if (profitFactor < 0) {
    // Increase RATIO
    return baseRatio * 
      (1 + adjustmentRatio)
  }
  
  return baseRatio
}`}
                </pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>DCA Strategy</CardTitle>
                <CardDescription>Works with factors, not volume</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                  {`// ✅ CORRECT
function applyDCAdjustment(
  positions: Position[],
  currentFactor: number,
  dcaLevels: number
): number {
  const lossPositions = 
    positions.filter(
      p => p.profit_factor < 0
    )
  
  if (lossPositions.length > 0) {
    const lossRatio = 
      lossPositions.length / 
      positions.length
      
    // Adjust FACTOR
    return currentFactor * 
      (1 + lossRatio)
  }
  
  return currentFactor
}`}
                </pre>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="examples" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Complete Flow Example</CardTitle>
              <CardDescription>From Base to Exchange execution</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <p className="font-medium text-sm">1. BASE Level (Pseudo Position)</p>
                <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                  {`{
  symbol: "BTC/USDT",
  positionCost: 0.1,        // 10% ratio
  entryPrice: 50000,
  takeprofitFactor: 2.0,
  stoplossRatio: 0.5
  // NO volume field
}`}
                </pre>
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">2. MAIN Level (Strategy Filter)</p>
                <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                  {`{
  ...basePosition,
  stepCount: 3,             // 3 cost steps
  costRatio: 1.0,           // Base ratio
  // Still NO volume
}`}
                </pre>
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm">3. REAL Level (Validation)</p>
                <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                  {`{
  ...mainPosition,
  isAffordable: true,       // Can handle 10% cost
  validated: true
  // Still NO volume
}`}
                </pre>
              </div>

              <div className="space-y-2">
                <p className="font-medium text-sm text-green-600">4. EXCHANGE Level (Execution)</p>
                <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                  {`// NOW calculate volume:
const accountBalance = 10000  // $10,000
const leverage = 125

const investAmount = 
  accountBalance * 0.1        // $1,000

const positionSize = 
  investAmount * leverage     // $125,000

const volume = 
  positionSize / 50000        // 2.5 BTC

const quantity = 
  volume / 50000              // 0.00005 BTC

// Create exchange order:
{
  ...realPosition,
  volume: 2.5,
  quantity: 0.00005,
  leverage: 125,
  marginUsed: 1000
}`}
                </pre>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mistakes" className="space-y-4">
          <div className="grid gap-4">
            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-destructive" />
                  Mistake #1: Volume in Pseudo Positions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-destructive mb-2">❌ Wrong:</p>
                  <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                    {`const pseudoPosition = {
  symbol: "BTC/USD",
  volume: 2.5,        // NO!
  entryPrice: 50000
}`}
                  </pre>
                </div>
                <div>
                  <p className="text-sm font-medium text-green-600 mb-2">✅ Correct:</p>
                  <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                    {`const pseudoPosition = {
  symbol: "BTC/USD",
  positionCost: 0.1,  // Ratio only
  entryPrice: 50000
}`}
                  </pre>
                </div>
              </CardContent>
            </Card>

            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-destructive" />
                  Mistake #2: Volume-based Strategy Adjustments
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-destructive mb-2">❌ Wrong:</p>
                  <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                    {`function adjust(
  baseVolume: number,
  adjustment: number
): number {
  return baseVolume * adjustment
}`}
                  </pre>
                </div>
                <div>
                  <p className="text-sm font-medium text-green-600 mb-2">✅ Correct:</p>
                  <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                    {`function adjust(
  baseRatio: number,
  adjustment: number
): number {
  return baseRatio * adjustment
}`}
                  </pre>
                </div>
              </CardContent>
            </Card>

            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-destructive" />
                  Mistake #3: Account Balance Before Exchange
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-destructive mb-2">❌ Wrong:</p>
                  <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                    {`const basePosition = {
  accountBalance: 10000,  // NO!
  volume: calculate(
    accountBalance, price
  )
}`}
                  </pre>
                </div>
                <div>
                  <p className="text-sm font-medium text-green-600 mb-2">✅ Correct:</p>
                  <pre className="bg-muted p-3 rounded text-xs overflow-x-auto">
                    {`const basePosition = {
  positionCost: 0.1  // Just ratio
  // balance at Exchange
}`}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>Implementation Checklist</CardTitle>
          <CardDescription>Ensure your code follows these principles</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">Base pseudo positions use positionCost (ratio) only</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">Main filtering uses step counts, not volume</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">Real validation checks affordability via ratios</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">Volume calculated ONLY at Exchange level</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">Block strategy adjusts ratios, not volumes</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">DCA strategy adjusts factors, not volumes</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">No account balance references before Exchange</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">No quantity calculations before Exchange</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">Position cost always in ratio format (0.01-1.0)</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-1" />
              <span className="text-sm">Exchange level converts ratios to actual volumes</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
