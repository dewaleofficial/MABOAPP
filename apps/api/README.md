# @provia/api

NestJS API — orders, ledger, Paystack webhook handling. See the root `CLAUDE.md` for the architecture this serves.

## Local development

```
pnpm --filter @provia/api build
DATABASE_URL=... SUPABASE_JWT_SECRET=... PAYSTACK_SECRET_KEY=... PAYSTACK_WEBHOOK_SECRET=... pnpm --filter @provia/api start
```

## Stopping the server

`pnpm --filter @provia/api stop` kills whatever is listening on `PORT` (default `3000`) directly, rather than the `pnpm`/`node` process tree — necessary because `pnpm run start` wraps `node dist/main.js` in an intermediate shell, and on Windows, killing that wrapper does not kill the `node` child underneath it. **To stop the server, verify with a live request (e.g. `curl` the API), don't trust the stop command's own success message alone** — confirmed directly during the auth/transition attack suite, where `TaskStop` reported success while the server kept serving requests.

On Windows, the working manual fallback if the script above doesn't apply to your situation:
```
netstat -ano | findstr :3000
taskkill /PID <pid> /F
```

The POSIX path in `scripts/stop.js` requires `lsof` to be installed.
