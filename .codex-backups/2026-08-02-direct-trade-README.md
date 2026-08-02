# CTS-K-N Direct-Trade checkpoint

Local checkpoint commit: `326deb71050f0927817709ae7431d278711d9758`
Base commit: `82e7ad796bbad14d74724cfe77a75887a770e7c4`

This branch stores a Git bundle split into seven Base64 text fragments because the authenticated connector cannot push Git objects directly.

Restore:

```bash
cat .codex-backups/2026-08-02-direct-trade.bundle.base64.part-*-of-7 | base64 -d > cts-k-n-direct-trade.bundle
sha256sum cts-k-n-direct-trade.bundle
git clone cts-k-n-direct-trade.bundle CTS-K-N
```

Expected SHA-256:

```
4ccf9da15da5fff52c61b60b199116c85f3629befe58f99c65fa963082656899
```
