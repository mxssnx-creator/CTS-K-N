# Live Trading System - Vercel Continuous Deployment Guide

## Branch Configuration
- **Production Branch**: `vercel`
- **Project**: cts-k-n (ID: prj_cpoasIpJ023ciFEucXZISHLXEPU1)
- **Organization**: mxssnx-creator
- **Repository**: CTS-K-N
- **Production URL**: https://cts-k-n-mxssnxx.vercel.app

## Required Environment Variables

### Critical for Live Trading (MUST SET)

1. **ALLOW_INLINE_REDIS_LIVE_TRADING**
   - Type: String
   - Value: `1`
   - Purpose: Enables live trading on single-process Vercel deployments
   - Impact: Without this, all positions will be simulated instead of live
   - **REQUIRED: YES**

2. **CRON_SECRET**
   - Type: String  
   - Value: Any string 16+ characters (e.g., `production-cron-secret-key-over-16-characters`)
   - Purpose: Authenticates requests to `/api/cron/generate-indications` endpoint
   - Impact: Required for automatic indication generation
   - **REQUIRED: YES**

### Pre-configured (Do not modify)
- `REDIS_URL`: Already set for Upstash Redis connection
- `BINGX_API_KEY`: Already set with BingX credentials
- `BINGX_API_SECRET`: Already set with BingX credentials

## How to Set Environment Variables

### Via Vercel Dashboard
1. Go to https://vercel.com/mxssnxx/cts-k-n/settings/environment-variables
2. Click "Add New" for each variable
3. Enter the variable name and value
4. Select which environments (Production, Preview, Development)
5. Click "Save"

### Via Vercel CLI
```bash
vercel env add ALLOW_INLINE_REDIS_LIVE_TRADING
vercel env add CRON_SECRET
```

## Continuous Deployment Workflow

### Automatic Deployment
- Any push to the `vercel` branch automatically triggers a deployment
- Previous deployments are preserved as preview URLs
- Deployments take ~2-3 minutes to complete

### Manual Deployment
```bash
# Build and deploy to production
vercel deploy --prod

# Or push to vercel branch
git push origin vercel
```

## Deployment Verification

### 1. Check Deployment Status
```bash
# Via Vercel CLI
vercel list

# Via Browser
# Visit: https://vercel.com/mxssnxx/cts-k-n/deployments
```

### 2. Verify Live Trading is Enabled
```bash
# Check if engine is in live_trading phase
curl https://cts-k-n-mxssnxx.vercel.app/api/trade-engine/progression

# Expected response:
# {
#   "connections": [{
#     "engineProgression": {
#       "phase": "live_trading"  # ← This should say "live_trading"
#     }
#   }]
# }
```

### 3. Test System Health
```bash
curl https://cts-k-n-mxssnxx.vercel.app/api/health

# Expected response:
# {
#   "checks": {
#     "redis": { "status": "ok" },
#     "database": { "status": "ok" }
#   }
# }
```

## Production Checklist

Before considering deployment production-ready:

- [ ] Environment variables set: `ALLOW_INLINE_REDIS_LIVE_TRADING=1`
- [ ] Environment variables set: `CRON_SECRET` (16+ chars)
- [ ] Vercel deployment shows "Ready" status
- [ ] `/api/health` endpoint returns all "ok" statuses
- [ ] `/api/trade-engine/progression` shows `phase: "live_trading"`
- [ ] Indications can be generated via `/api/cron/generate-indications`
- [ ] Positions are created and executed on BingX exchange

## Troubleshooting

### Live Trading Not Enabled
**Symptom**: Engine shows `phase: "main"` instead of `live_trading`
**Solution**: 
1. Verify `ALLOW_INLINE_REDIS_LIVE_TRADING=1` is set in environment variables
2. Redeploy with `git push origin vercel`
3. Wait 2-3 minutes for deployment to complete

### Indication Generation Fails
**Symptom**: `/api/cron/generate-indications` returns 403 or error
**Solution**:
1. Check `CRON_SECRET` is set in environment variables
2. Verify the secret matches what you're using in API calls
3. Re-check Vercel deployment completed successfully

### Redis Connection Issues
**Symptom**: `/api/health` shows Redis status not "ok"
**Solution**:
1. Verify `REDIS_URL` is configured
2. Check that Upstash Redis is active and not suspended
3. Contact support if connection persists

## Monitoring

### Real-time Monitoring
- Vercel Logs: https://vercel.com/mxssnxx/cts-k-n/logs
- Function Logs show real-time execution
- View trade-engine cycle logs and position creation

### Health Endpoint
Check every 5 minutes:
```bash
curl -s https://cts-k-n-mxssnxx.vercel.app/api/health | grep -o '"status":"[^"]*"'
```

### Indication Generation Status
```bash
curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://cts-k-n-mxssnxx.vercel.app/api/cron/generate-indications
```

## Important Notes

1. **Environment Variables**: Must be set BEFORE first deployment
2. **CRON_SECRET**: Use strong, unique value (at least 16 characters)
3. **Live Trading**: Once enabled, system will execute REAL trades on BingX
4. **Monitoring**: Regularly check deployment logs for errors
5. **Rollback**: If issues occur, previous deployments are available in Vercel dashboard

## Support

- Vercel Status: https://vercel.com/status
- BingX API Status: https://bingx.com/en-US/
- Check Vercel documentation: https://vercel.com/docs
- Review trade-engine logs for specific errors
