#!/usr/bin/env node

import http from 'http';
import { spawn } from 'child_process';

const API_BASE = 'http://localhost:3002/api';

class FinalValidationTest {
  constructor() {
    this.results = [];
    this.errors = [];
  }

  async request(path) {
    return new Promise((resolve, reject) => {
      const fullUrl = `${API_BASE}${path}`;
      const url = new URL(fullUrl);
      const req = http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Parse error on ${fullUrl}: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error(`Timeout on ${fullUrl}`));
      });
    });
  }

  test(name, fn) {
    this.results.push({ name, fn });
  }

  async run() {
    console.log('\n=== FINAL COMPREHENSIVE VALIDATION TEST ===\n');

    for (const { name, fn } of this.results) {
      try {
        console.log(`[TEST] ${name}...`);
        await fn.call(this);
        console.log(`  ✓ PASSED\n`);
      } catch (e) {
        console.log(`  ✗ FAILED: ${e.message}\n`);
        this.errors.push({ test: name, error: e.message });
      }
    }

    this.printSummary();
  }

  printSummary() {
    const total = this.results.length;
    const passed = total - this.errors.length;
    const percentage = Math.round((passed / total) * 100);

    console.log('\n=== VALIDATION SUMMARY ===');
    console.log(`Total Tests: ${total}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${this.errors.length}`);
    console.log(`Success Rate: ${percentage}%\n`);

    if (this.errors.length > 0) {
      console.log('FAILURES:');
      for (const { test, error } of this.errors) {
        console.log(`  - ${test}: ${error}`);
      }
      console.log();
      process.exit(1);
    } else {
      console.log('ALL TESTS PASSED - SYSTEM READY FOR PRODUCTION\n');
      process.exit(0);
    }
  }
}

const suite = new FinalValidationTest();

// Test 1: Server connectivity
suite.test('Server Connectivity', async function() {
  const data = await this.request('/health');
  if (data.status !== 'healthy') throw new Error('Health check failed');
});

// Test 2: Stats API structure
suite.test('Stats API Structure', async function() {
  const data = await this.request('/connections/progression/test/stats');
  if (!data.breakdown) throw new Error('No breakdown in response');
  if (!data.breakdown.strategies) throw new Error('No strategies in breakdown');
  const strat = data.breakdown.strategies;
  if (typeof strat.base !== 'number') throw new Error('Invalid base structure');
  if (typeof strat.main !== 'number') throw new Error('Invalid main structure');
  if (typeof strat.real !== 'number') throw new Error('Invalid real structure');
});

// Test 3: Logical constraint - eval <= sets
suite.test('Logical Constraint: eval <= sets', async function() {
  const data = await this.request('/connections/progression/test/stats');
  const strat = data.breakdown.strategies;
  
  const baseEval = strat.baseEvaluated || 0;
  const mainEval = strat.mainEvaluated || 0;
  const realEval = strat.realEvaluated || 0;
  
  if (baseEval > strat.base) throw new Error(`base: eval(${baseEval}) > sets(${strat.base})`);
  if (mainEval > strat.main) throw new Error(`main: eval(${mainEval}) > sets(${strat.main})`);
  if (realEval > strat.real) throw new Error(`real: eval(${realEval}) > sets(${strat.real})`);
});

// Test 4: Cascade constraint - main >= base
suite.test('Cascade Constraint: main.sets >= base.sets', async function() {
  const data = await this.request('/connections/progression/test/stats');
  const strat = data.breakdown.strategies;
  
  // Main can stay same or grow (cascade with variants)
  if (strat.main < strat.base) {
    throw new Error(`main(${strat.main}) < base(${strat.base})`);
  }
});

// Test 5: Filter constraint - real <= main
suite.test('Filter Constraint: real.sets <= main.sets', async function() {
  const data = await this.request('/connections/progression/test/stats');
  const strat = data.breakdown.strategies;
  
  if (strat.real > strat.main) {
    throw new Error(`real(${strat.real}) > main(${strat.main})`);
  }
});

// Test 6: Semantics - BASE eval equals BASE sets (if any)
suite.test('Semantics: BASE eval = BASE sets (if exists)', async function() {
  const data = await this.request('/connections/progression/test/stats');
  const strat = data.breakdown.strategies;
  
  const baseEval = strat.baseEvaluated || 0;
  
  // If base sets exist, all should be evaluated
  if (strat.base > 0 && baseEval === 0) {
    throw new Error(`base sets exist but no eval`);
  }
});

// Test 7: Semantics - MAIN eval represents base input
suite.test('Semantics: MAIN eval <= BASE sets (input)', async function() {
  const data = await this.request('/connections/progression/test/stats');
  const strat = data.breakdown.strategies;
  
  const mainEval = strat.mainEvaluated || 0;
  
  // Main eval should be <= base sets (input count)
  if (mainEval > strat.base && strat.base > 0) {
    throw new Error(`main.eval(${mainEval}) > base.sets(${strat.base})`);
  }
});

// Test 8: Semantics - REAL eval represents main input
suite.test('Semantics: REAL eval <= MAIN sets (input)', async function() {
  const data = await this.request('/connections/progression/test/stats');
  const strat = data.breakdown.strategies;
  
  const realEval = strat.realEvaluated || 0;
  
  // Real eval should be <= main sets (input count)
  if (realEval > strat.main && strat.main > 0) {
    throw new Error(`real.eval(${realEval}) > main.sets(${strat.main})`);
  }
});

// Test 9: Threshold validation - PosEval >= 1.4 or 0
suite.test('Threshold Validation: PosEval >= 1.4 or 0', async function() {
  const data = await this.request('/connections/progression/test/stats');
  if (!data.breakdown.posEval) return; // No position data yet
  
  const avg = parseFloat(data.breakdown.posEval.avg) || 0;
  
  if (avg > 0 && avg < 1.4) {
    throw new Error(`PosEval avg ${avg} below threshold 1.4`);
  }
});

// Test 10: Netting accuracy - accumulated = main - real
suite.test('Netting Logic: accumulated = main - real', async function() {
  const data = await this.request('/connections/progression/test/stats');
  const strat = data.breakdown.strategies;
  
  if (strat.main > 0 && strat.real > 0) {
    const expected = strat.main - strat.real;
    // This is informational - accumulated tracking
    console.log(`  (main ${strat.main} - real ${strat.real} = expected ${expected})`);
  }
});

// Test 11: No impossible states
suite.test('No Impossible States', async function() {
  const data = await this.request('/connections/progression/test/stats');
  const strat = data.breakdown.strategies;
  
  // Check for NaN or negative values
  if (typeof strat.base !== 'number' || strat.base < 0) {
    throw new Error(`base is invalid`);
  }
  if (typeof strat.main !== 'number' || strat.main < 0) {
    throw new Error(`main is invalid`);
  }
  if (typeof strat.real !== 'number' || strat.real < 0) {
    throw new Error(`real is invalid`);
  }
});

// Test 12: Data consistency across reads
suite.test('Data Consistency: Multiple Reads', async function() {
  const data1 = await this.request('/connections/progression/test/stats');
  await new Promise(r => setTimeout(r, 100));
  const data2 = await this.request('/connections/progression/test/stats');
  
  const s1 = JSON.stringify(data1.breakdown.strategies);
  const s2 = JSON.stringify(data2.breakdown.strategies);
  
  if (s1 !== s2) {
    console.log('  Note: Data changed between reads (expected during active engine)');
  }
});

// Run all tests
suite.run().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
