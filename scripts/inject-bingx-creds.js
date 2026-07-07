const { initRedis, saveConnection } = require('../lib/redis-db')

async function main() {
  await initRedis()

  const connection = {
    id: 'bingx-x01',
    user_id: 1,
    name: 'BingX X01',
    exchange: 'bingx',
    exchange_id: 9,
    api_type: 'perpetual_futures',
    connection_method: 'rest',
    connection_library: 'rest',
    api_key: process.env.BINGX_API_KEY || 'REPLACE_WITH_KEY',
    api_secret: process.env.BINGX_API_SECRET || 'REPLACE_WITH_SECRET',
    api_passphrase: '',
    margin_type: 'cross',
    position_mode: 'hedge',
    is_testnet: true,
    is_enabled: true,
    is_live_trade: true,
    is_preset_trade: false,
    is_active: true,
    is_predefined: false,
    volume_factor: 0.1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  await saveConnection(connection)
  console.log('Injected connection bingx-x01 into Redis (credentials read from env if set)')
}

main().catch(e => { console.error(e); process.exit(1) })
