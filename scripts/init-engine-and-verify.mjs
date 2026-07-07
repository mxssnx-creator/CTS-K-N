#!/usr/bin/env node
/**
 * Engine Initialization & Verification Script
 * 
 * Performs complete startup sequence:
 * 1. Initialize Redis with clean progression state
 * 2. Start the trading engine
 * 3. Verify all stages are progressing
 * 4. Check stats API is returning proper counts
 */

import fetch from 'node-fetch';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3002';
const CONN_ID = process.env.CONN_ID || 'bingx-x01';
const MAX_WAIT = 120000; // 2 minutes
const POLL_INTERVAL = 2000;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForServer() {
  console.log('[init] Waiting for dev server...');
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    try {
      const res = await fetch(`${BASE_URL}/api/system/status`, { timeout: 5000 });
      if (res.ok) {
        console.log('[init] ✓ Server responding');
        return true;
      }
    } catch (e) {}
    await sleep(1000);
  }
  throw new Error('Server timeout');
}

async function initializeRedis() {
  console.log('[init] Initializing Redis progression state...');
  try {
    const res = await fetch(`${BASE_URL}/api/system/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: CONN_ID })
    });
    if (res.ok) {
      console.log('[init] ✓ Redis initialized');
      return true;
    }
    console.log('[init] Initialize returned', res.status);
    return false;
  } catch (e) {
    console.log('[init] Initialize error:', e.message);
    return false;
  }
}

async function startEngine() {
  console.log('[init] Starting trading engine...');
  try {
    const res = await fetch(`${BASE_URL}/api/trade-engine/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      console.log('[init] ✓ Engine started, phase:', data.phase || 'unknown');
      return true;
    }
    console.log('[init] Start returned', res.status);
    return false;
  } catch (e) {
    console.log('[init] Start error:', e.message);
    return false;
  }
}

async function checkStats() {
  console.log('[init] Checking stats API...');
  try {
    const res = await fetch(`${BASE_URL}/api/connections/progression/${CONN_ID}/stats`);
    if (!res.ok) {
      console.log('[init] Stats returned', res.status);
      return null;
    }
    const stats = await res.json();
    return {
      phase: stats.metadata?.phase,
      base: stats.breakdown?.strategies?.base || 0,
      main: stats.breakdown?.strategies?.main || 0,
      real: stats.breakdown?.strategies?.real || 0,
      live: stats.breakdown?.strategies?.live || 0,
      basePF: stats.strategyDetail?.base?.avgProfitFactor || 0,
      realPF: stats.strategyDetail?.real?.avgProfitFactor || 0,
      livePF: stats.strategyDetail?.live?.avgProfitFactor || 0,
    };
  } catch (e) {
    console.log('[init] Stats error:', e.message);
    return null;
  }
}

async function waitForProgression() {
  console.log('[init] Waiting for strategy progression...');
  const start = Date.now();
  let lastStats = null;
  
  while (Date.now() - start < MAX_WAIT) {
    const stats = await checkStats();
    if (stats) {
      lastStats = stats;
      console.log('[init] Stats cycle:', {
        phase: stats.phase,
        base: stats.base,
        main: stats.main,
        real: stats.real,
        live: stats.live,
      });
      
      // Success: at least base and main are progressing
      if (stats.phase === 'live_trading' && stats.real > 0) {
        console.log('[init] ✓ Progression active');
        return true;
      }
    }
    await sleep(POLL_INTERVAL);
  }
  
  console.log('[init] ⚠ Timeout waiting for progression, last stats:', lastStats);
  return false;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║         Trading Engine Initialization & Verification           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  
  try {
    await waitForServer();
    await sleep(2000);
    
    await initializeRedis();
    await sleep(1000);
    
    await startEngine();
    await sleep(3000);
    
    const success = await waitForProgression();
    
    if (success) {
      console.log('');
      console.log('✓ Engine initialization complete');
      console.log('✓ Progression pipeline active');
      console.log('✓ Stats API responding correctly');
      process.exit(0);
    } else {
      console.log('');
      console.log('⚠ Engine started but progression not yet detected');
      console.log('  (This may be normal during early startup)');
      process.exit(1);
    }
  } catch (e) {
    console.error('✗ Initialization failed:', e.message);
    process.exit(1);
  }
}

main();
