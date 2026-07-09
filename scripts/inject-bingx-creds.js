const { initRedis, saveConnection } = require('../lib/redis-db')

async function main() {
  await initRedis()

  // Production mode: is_testnet=false for REAL exchange orders
  // Credentials MUST be set via BINGX_API_KEY and BINGX_API_SECRET env vars
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1'
  
  const connection = {
    id: 'bingx-x01',
    user_id: 1,
    name: 'BingX X01',
    exchange: 'bingx',
    exchange_id: 9,
    api_type: 'perpetual_futures',
    connection_method: 'library',
    connection_library: 'sdk',
    api_key: process.env.BINGX_API_KEY || '',
    api_secret: process.env.BINGX_API_SECRET || '',
    api_passphrase: '',
    margin_type: 'cross',
    position_mode: 'hedge',
    is_testnet: false, // PRODUCTION: false = real mainnet trading
    is_enabled: true,
    is_live_trade: true,
    is_preset_trade: false,
    is_active: true,
    is_predefined: false,
    volume_factor: 0.1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Validate credentials before saving (prevents silent simulation fallback)
  const hasValidCreds = connection.api_key.length >= 10 && connection.api_secret.length >= 10
  const banned = /PLACEHOLDER|00998877|^test/i
  if (!hasValidCreds || banned.test(connection.api_key) || banned.test(connection.api_secret)) {
    console.warn('[inject-bingx-creds] WARNING: No valid API credentials provided - connection will run in simulation mode')
    console.warn('[inject-bingx-creds] Set BINGX_API_KEY and BINGX_API_SECRET environment variables for real trading')
  }

  await saveConnection(connection)
  console.log('Injected connection bingx-x01 into Redis (mainnet mode, credentials from env)')
}

main().catch(e => { console.error(e); process.exit(1) })
