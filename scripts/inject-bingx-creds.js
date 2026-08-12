const { initRedis, saveConnection } = require('../lib/redis-db')

async function main() {
  await initRedis()

  // Credentials authenticate both environments. Selection is explicit so a
  // credential rotation cannot silently turn a virtual-funds connection into
  // a real-funds connection.
  const environmentAliases = {
    'prod-live': 'prod-live', live: 'prod-live', mainnet: 'prod-live', production: 'prod-live',
    'prod-vst': 'prod-vst', vst: 'prod-vst', demo: 'prod-vst', testnet: 'prod-vst',
  }
  const rawEnvironment = String(process.env.BINGX_ENVIRONMENT || 'prod-live').trim().toLowerCase()
  const environment = environmentAliases[rawEnvironment]
  if (!environment) {
    throw new Error(`Unsupported BINGX_ENVIRONMENT '${rawEnvironment}'; expected prod-live or prod-vst`)
  }
  const isDemo = environment === 'prod-vst'
  const connectionId = isDemo ? 'bingx-x02' : 'bingx-x01'
  const apiKey = isDemo
    ? (process.env.BINGX_X02_API_KEY || '')
    : (process.env.BINGX_API_KEY || '')
  const apiSecret = isDemo
    ? (process.env.BINGX_X02_API_SECRET || '')
    : (process.env.BINGX_API_SECRET || '')
  
  const connection = {
    id: connectionId,
    user_id: 1,
    name: isDemo ? 'BingX X02 (Prod-VST Demo)' : 'BingX X01',
    exchange: 'bingx',
    exchange_id: 9,
    api_type: 'perpetual_futures',
    connection_method: 'library',
    connection_library: 'sdk',
    api_key: apiKey,
    api_secret: apiSecret,
    api_passphrase: '',
    margin_type: 'cross',
    position_mode: 'hedge',
    is_testnet: isDemo,
    is_enabled: true,
    is_live_trade: true,
    is_preset_trade: false,
    is_active: true,
    is_predefined: isDemo,
    volume_factor: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Validate credentials before saving (prevents silent simulation fallback)
  const hasValidCreds = connection.api_key.length >= 10 && connection.api_secret.length >= 10
  const banned = /PLACEHOLDER|00998877|^test/i
  if (!hasValidCreds || banned.test(connection.api_key) || banned.test(connection.api_secret)) {
    console.warn('[inject-bingx-creds] WARNING: No valid API credentials provided - authenticated execution is unavailable')
    console.warn(`[inject-bingx-creds] Set ${isDemo ? 'BINGX_X02_API_KEY and BINGX_X02_API_SECRET' : 'BINGX_API_KEY and BINGX_API_SECRET'} in the runtime environment`)
  }

  await saveConnection(connection)
  console.log(`Injected connection ${connectionId} into Redis (${environment}, ${isDemo ? 'virtual funds' : 'real funds'}, credentials from env)`)
}

main().catch(e => { console.error(e); process.exit(1) })
