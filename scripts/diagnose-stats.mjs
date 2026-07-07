#!/usr/bin/env node
/**
 * Comprehensive Statistics Diagnostics
 * 
 * Checks all data sources that feed the stats API:
 * 1. strategies_active hash (coordinator live snapshot)
 * 2. progression hash (state manager counters)
 * 3. Stats API output (final result)
 */

import fetch from 'node-fetch';
import { createClient } from 'redis';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3002';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CONN_ID = process.env.CONN_ID || 'bingx-x01';

async function checkRedis() {
  console.log('=== Redis Direct Check ===');
  try {
    const client = createClient({ url: REDIS_URL });
    client.on('error', e => console.log('[redis] Error:', e.message));
    await client.connect();
    
    // Check strategies_active hash
    const stratActive = await client.hgetAll(`strategies_active:${CONN_ID}`);
    console.log('[redis] strategies_active fields:', Object.keys(stratActive).length);
    if (Object.keys(stratActive).length > 0) {
      for (const [key, val] of Object.entries(stratActive).slice(0, 10)) {
        console.log(`  ${key} = ${val}`);
      }
    } else {
      console.log('  (empty - coordinator not writing)');
    }
    
    // Check progression hash
    const prog = await client.hgetAll(`progression:${CONN_ID}`);
    console.log('[redis] progression hash fields:', Object.keys(prog).length);
    const progKeys = ['strategies_base_total', 'strategies_main_total', 'strategies_real_total', 'cycles_completed'];
    for (const key of progKeys) {
      console.log(`  ${key} = ${prog[key] || '0'}`);
    }
    
    await client.quit();
  } catch (e) {
    console.log('[redis] Connection failed:', e.message);
  }
}

async function checkAPI() {
  console.log('\\n=== Stats API Check ===');
  try {
    const res = await fetch(`${BASE_URL}/api/connections/progression/${CONN_ID}/stats`);
    if (!res.ok) {
      console.log(`[api] Error: ${res.status}`);
      return;
    }
    const stats = await res.json();
    console.log('[api] Phase:', stats.metadata?.phase);
    console.log('[api] Strategies breakdown:', stats.breakdown?.strategies);
    console.log('[api] Strategy detail (base):', stats.strategyDetail?.base);
    console.log('[api] Strategy detail (real):', stats.strategyDetail?.real);
    console.log('[api] Strategy detail (live):', stats.strategyDetail?.live);
  } catch (e) {
    console.log('[api] Request failed:', e.message);
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║              Statistics Diagnostics Tool                       ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\\n');
  
  await checkRedis();
  await checkAPI();
  
  console.log('\\n=== Summary ===');
  console.log('If Redis shows 0 strategies_active fields:');
  console.log('  → Coordinator has not run yet (engine not active)');
  console.log('  → This is normal if phase is "stopped"');
  console.log('');
  console.log('If progression hash shows 0 cycles_completed:');
  console.log('  → Engine has not completed any cycles yet');
  console.log('  → Wait for engine to stabilize');
  console.log('');
  console.log('If Stats API shows all zeros:');
  console.log('  → Normal when engine is stopped');
  console.log('  → Check engine phase and restart if needed');
}

main();
