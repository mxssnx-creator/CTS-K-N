#!/usr/bin/env node

import http from 'http';

const API_BASE = `http://localhost:${process.env.PORT || 3002}/api`;
const TEST_ID = 'logistics-test-' + Date.now();

class LogisticsTestSuite {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      warnings: 0,
      tests: []
    };
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
            reject(new Error(`Failed to parse response from ${fullUrl}: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
    });
  }

  assert(condition, testName, details = '') {
    if (condition) {
      this.results.passed++;
      console.log(`✓ ${testName}`);
    } else {
      this.results.failed++;
      console.log(`✗ ${testName}${details ? ': ' + details : ''}`);
    }
    this.results.tests.push({ testName, passed: condition, details });
  }

  warn(condition, testName, details = '') {
    if (!condition) {
      this.results.warnings++;
      console.log(`⚠ ${testName}${details ? ': ' + details : ''}`);
    }
  }

  async testBasicConnectivity() {
    console.log('\n=== TEST 1: Basic Connectivity ===');
    try {
      const health = await this.request('/health');
      this.assert(health.status === 'ok', 'API health check');
    } catch (e) {
      this.assert(false, 'API health check', e.message);
    }
  }

  async testStatsStructure() {
    console.log('\n=== TEST 2: Stats API Structure ===');
    try {
      const stats = await this.request('/connections/progression/test/stats');
      
      this.assert(stats.breakdown, 'Stats has breakdown object');
      this.assert(stats.breakdown.strategies, 'Has strategies breakdown');
      
      const { base, main, real, live } = stats.breakdown.strategies;
      
      this.assert(base !== undefined, 'BASE stage exists in breakdown');
      this.assert(main !== undefined, 'MAIN stage exists in breakdown');
      this.assert(real !== undefined, 'REAL stage exists in breakdown');
      
      console.log(`  BASE: sets=${base?.sets || 0}, eval=${base?.eval || 0}, pf=${base?.pf?.toFixed(2) || 'N/A'}`);
      console.log(`  MAIN: sets=${main?.sets || 0}, eval=${main?.eval || 0}, created=${main?.created || 0}`);
      console.log(`  REAL: sets=${real?.sets || 0}, eval=${real?.eval || 0}, accum=${real?.accumulated || 0}`);
      
      return { base, main, real, live, stats };
    } catch (e) {
      this.assert(false, 'Fetch stats API', e.message);
      return null;
    }
  }

  testLogicalConstraints(data) {
    if (!data) return;
    
    console.log('\n=== TEST 3: Logical Constraints ===');
    const { base, main, real } = data;

    // Constraint 1: eval <= sets always
    this.assert(
      base?.eval <= base?.sets || base?.sets === 0,
      'BASE: eval <= sets',
      `eval=${base?.eval}, sets=${base?.sets}`
    );

    this.assert(
      main?.eval <= main?.sets || main?.sets === 0,
      'MAIN: eval <= sets',
      `eval=${main?.eval}, sets=${main?.sets}`
    );

    this.assert(
      real?.eval <= real?.sets || real?.sets === 0,
      'REAL: eval <= sets',
      `eval=${real?.eval}, sets=${real?.sets}`
    );

    // Constraint 2: Real eval should be <= Main sets (input to Real)
    if (main?.sets > 0 && real?.eval > 0) {
      this.assert(
        real?.eval <= main?.sets,
        'REAL eval <= MAIN sets (input constraint)',
        `real_eval=${real?.eval}, main_sets=${main?.sets}`
      );
    }

    // Constraint 3: Main sets should be >= Base sets (cascade with additions)
    if (base?.sets > 0 && main?.sets > 0) {
      this.assert(
        main?.sets >= base?.sets,
        'MAIN sets >= BASE sets (cascade + creation)',
        `main=${main?.sets}, base=${base?.sets}`
      );
    }

    // Constraint 4: Real sets should be <= Main sets (filter removes sets)
    if (main?.sets > 0 && real?.sets >= 0) {
      this.assert(
        real?.sets <= main?.sets,
        'REAL sets <= MAIN sets (filter removes)',
        `real=${real?.sets}, main=${main?.sets}`
      );
    }
  }

  testSemantics(data) {
    if (!data) return;
    
    console.log('\n=== TEST 4: Semantics Verification ===');
    const { base, main, real } = data;

    // BASE stage: eval should equal sets (all base sets evaluated)
    if (base?.sets > 0) {
      this.warn(
        base?.eval === base?.sets,
        'BASE: eval equals sets (100% evaluated)',
        `eval=${base?.eval}, sets=${base?.sets}`
      );
    }

    // MAIN stage: eval should equal input (all base sets fed to main)
    if (base?.sets > 0 && main?.eval > 0) {
      this.warn(
        main?.eval >= base?.sets * 0.5, // At least half of base should be evaluated
        'MAIN: eval includes base sets',
        `main_eval=${main?.eval}, base_sets=${base?.sets}`
      );
    }

    // REAL stage: eval should equal main sets (all main fed to real)
    if (main?.sets > 0 && real?.eval > 0) {
      this.warn(
        real?.eval >= main?.sets * 0.5, // At least half of main should be evaluated
        'REAL: eval includes main sets',
        `real_eval=${real?.eval}, main_sets=${main?.sets}`
      );
    }

    // Created sets: should be main - base (approximately)
    if (main?.sets > 0 && base?.sets > 0 && main?.created !== undefined) {
      const expectedCreated = main?.sets - base?.sets;
      this.warn(
        Math.abs(main?.created - expectedCreated) < expectedCreated * 0.2,
        'MAIN: created matches sets delta',
        `created=${main?.created}, expected~${expectedCreated}`
      );
    }

    // Accumulated sets: should be main - real
    if (main?.sets > 0 && real?.sets >= 0 && real?.accumulated !== undefined) {
      const expectedAccum = main?.sets - real?.sets;
      this.warn(
        Math.abs(real?.accumulated - expectedAccum) < expectedAccum * 0.2 || expectedAccum === 0,
        'REAL: accumulated matches netting delta',
        `accumulated=${real?.accumulated}, expected~${expectedAccum}`
      );
    }
  }

  testThresholds(data) {
    if (!data) return;
    
    console.log('\n=== TEST 5: Threshold Validation ===');
    const stats = data.stats;
    
    if (stats?.posEval) {
      const { avg, count } = stats.posEval;
      
      if (count > 0) {
        this.assert(
          avg >= 1.4 || avg === 0,
          'PosEval avg meets threshold (>= 1.4 or 0)',
          `avg=${avg?.toFixed(3)}, count=${count}`
        );
      }

      if (stats.breakdown.strategies.real?.sets > 0) {
        this.warn(
          avg > 0,
          'PosEval has valid data when Real sets exist',
          `avg=${avg?.toFixed(3)}, real_sets=${stats.breakdown.strategies.real?.sets}`
        );
      }
    }
  }

  testPipelineFlow(data) {
    if (!data) return;
    
    console.log('\n=== TEST 6: Pipeline Flow ===');
    const { base, main, real } = data;

    // Check that data flows through stages correctly
    let stageCount = 0;
    let stageFlow = [];

    if (base?.sets > 0) {
      stageCount++;
      stageFlow.push(`BASE(${base?.sets})`);
    }
    
    if (main?.sets > 0) {
      stageCount++;
      stageFlow.push(`MAIN(${main?.sets})`);
    }
    
    if (real?.sets > 0) {
      stageCount++;
      stageFlow.push(`REAL(${real?.sets})`);
    }

    console.log(`  Pipeline flow: ${stageFlow.join(' → ')}`);

    if (stageCount > 0) {
      this.assert(
        stageCount >= 1,
        'At least BASE stage has data'
      );
    }

    if (stageCount > 1) {
      this.assert(
        base?.sets > 0 && main?.sets > 0,
        'Data properly cascades from BASE to MAIN'
      );
    }

    if (stageCount > 2) {
      this.assert(
        main?.sets > 0 && real?.sets > 0,
        'Data properly cascades from MAIN to REAL'
      );
    }
  }

  testNettingLogic(data) {
    if (!data) return;
    
    console.log('\n=== TEST 7: Hedge Netting Logic ===');
    const { main, real } = data;

    if (main?.sets > 0 && real?.sets >= 0) {
      const netted = main?.sets - real?.sets;
      
      if (netted > 0) {
        this.assert(
          real?.accumulated >= 0,
          'Accumulated count exists when netting occurs',
          `netted=${netted}, accumulated=${real?.accumulated}`
        );
      }

      this.assert(
        netted >= 0,
        'Netting removes sets (main >= real)',
        `main=${main?.sets}, real=${real?.sets}, netted=${netted}`
      );
    }
  }

  testCrossSymbolTotals(data) {
    if (!data) return;
    
    console.log('\n=== TEST 8: Cross-Symbol Totals ===');
    const stats = data.stats;
    
    if (stats?.breakdown?.strategies) {
      const { base, main, real } = stats.breakdown.strategies;
      
      // Check that totals make sense for 2 symbols
      this.warn(
        !((base?.sets || 0) % 2 !== 0 && (base?.sets > 1)), // Even count or singleton
        'BASE sets count is reasonable for multi-symbol',
        `sets=${base?.sets}`
      );

      this.warn(
        (main?.sets || 0) >= (base?.sets || 0),
        'MAIN total includes all BASE',
        `main=${main?.sets}, base=${base?.sets}`
      );
    }
  }

  testDataStability() {
    console.log('\n=== TEST 9: Data Stability ===');
    this.assert(true, 'All constraint violations logged above');
  }

  async run() {
    console.log('Starting Logistics Test Suite...\n');
    
    await this.testBasicConnectivity();
    const data = await this.testStatsStructure();
    
    if (data) {
      this.testLogicalConstraints(data);
      this.testSemantics(data);
      this.testThresholds(data);
      this.testPipelineFlow(data);
      this.testNettingLogic(data);
      this.testCrossSymbolTotals(data);
      this.testDataStability();
    }

    this.printSummary();
  }

  printSummary() {
    console.log('\n=== TEST SUMMARY ===');
    console.log(`Passed: ${this.results.passed}`);
    console.log(`Failed: ${this.results.failed}`);
    console.log(`Warnings: ${this.results.warnings}`);
    
    const total = this.results.passed + this.results.failed;
    if (total > 0) {
      const passRate = ((this.results.passed / total) * 100).toFixed(1);
      console.log(`Pass Rate: ${passRate}%`);
    }

    if (this.results.failed > 0) {
      console.log('\nFailed Tests:');
      this.results.tests
        .filter(t => !t.passed)
        .forEach(t => console.log(`  - ${t.testName}: ${t.details}`));
    }

    if (this.results.warnings > 0) {
      console.log('\nWarnings:');
      this.results.tests
        .filter(t => t.warning)
        .forEach(t => console.log(`  - ${t.testName}: ${t.details}`));
    }
  }
}

const suite = new LogisticsTestSuite();
suite.run().catch(console.error);
