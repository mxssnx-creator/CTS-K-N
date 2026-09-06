"use strict"

// Lossless representation change only. Keep the original key until every
// value and its ordering have been verified; never touch live/order keys.
const REPACK_INDICATION_LIST_SCRIPT = `
local key = KEYS[1]
local temporary = KEYS[2]
if string.sub(key, 1, 15) ~= 'indication_set:' then return redis.error_reply('unsupported source namespace') end
if string.sub(temporary, 1, 23) ~= 'cts:maintenance:repack:' then return redis.error_reply('unsupported temporary namespace') end
if redis.call('TYPE', key).ok ~= 'list' then return {0,0,0,0} end
if redis.call('EXISTS', temporary) ~= 0 then return redis.error_reply('temporary key already exists') end
local count = redis.call('LLEN', key)
local before = redis.call('MEMORY','USAGE',key,'SAMPLES',0) or 0
if count > 4096 or before > 2097152 or before < 16384 then return {0,before,before,count} end
-- Lua can continue allocating after read commands even when maxmemory has
-- already been exceeded. Reserve space explicitly before creating a copy.
local memory = redis.call('INFO','memory')
local used = tonumber(string.match(memory,'used_memory:(%d+)')) or 0
local maximum = tonumber(string.match(memory,'maxmemory:(%d+)')) or 0
if maximum > 0 and used + before * 3 + 65536 > maximum then return {0,before,before,count} end
local expiry = redis.call('PEXPIRETIME',key)
local original = redis.call('LRANGE',key,0,-1)
-- RESTORE retains the serialized listpack boundaries. Rebuild from the exact
-- values so current listpack sizing applies as well as compression. The source
-- remains intact throughout this bounded, atomic operation.
redis.call('RPUSH',temporary,unpack(original))
redis.call('PEXPIRE',temporary,60000)
local rebuilt = redis.call('LRANGE',temporary,0,-1)
local equal = #original == #rebuilt
if equal then for i=1,#original do if original[i] ~= rebuilt[i] then equal=false;break end end end
if not equal then redis.call('DEL',temporary); return redis.error_reply('lossless comparison failed') end
local after = redis.call('MEMORY','USAGE',temporary,'SAMPLES',0) or before
if after >= before then redis.call('DEL',temporary);return {0,before,before,count} end
if expiry >= 0 then redis.call('PEXPIREAT',temporary,expiry) else redis.call('PERSIST',temporary) end
redis.call('RENAME',temporary,key)
return {1,before,after,count}
`

module.exports = { REPACK_INDICATION_LIST_SCRIPT }
