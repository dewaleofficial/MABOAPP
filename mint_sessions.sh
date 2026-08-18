#!/bin/bash
# Mints real Supabase sessions for a test customer and test partner,
# printing the access_token + refresh_token pairs needed for
# supabase.auth.setSession() in each app.

# SERVICE_ROLE_KEY / ANON_KEY default to the standard Supabase CLI
# local-dev demo values (the same on every developer's machine, printed
# by `supabase start` — iss: "supabase-demo"). They are never real
# secrets in a properly configured project; override via env vars if
# your local stack uses different keys.
SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU}"
ANON_KEY="${ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0}"
SUPABASE_URL="http://127.0.0.1:54321"
PASSWORD="pilot-ui-test-DO-NOT-USE-1234"

echo "=== Creating (or confirming) the customer user ==="
curl -s -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"ui-test-customer@example.test\",\"email_confirm\":true,\"password\":\"$PASSWORD\"}" > /tmp/customer_create.json

echo "=== Creating (or confirming) the partner user ==="
curl -s -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"ui-test-partner@example.test\",\"email_confirm\":true,\"password\":\"$PASSWORD\"}" > /tmp/partner_create.json

echo "=== Signing in as customer ==="
curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"ui-test-customer@example.test\",\"password\":\"$PASSWORD\"}" > /tmp/customer_session.json

echo "=== Signing in as partner ==="
curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"ui-test-partner@example.test\",\"password\":\"$PASSWORD\"}" > /tmp/partner_session.json

echo ""
echo "=== CUSTOMER session (for apps/customer) ==="
node -e "const s=JSON.parse(require('fs').readFileSync('/tmp/customer_session.json','utf8')); console.log('access_token:', s.access_token); console.log('refresh_token:', s.refresh_token); console.log('user.id:', s.user && s.user.id);"

echo ""
echo "=== PARTNER session (for apps/partner) ==="
node -e "const s=JSON.parse(require('fs').readFileSync('/tmp/partner_session.json','utf8')); console.log('access_token:', s.access_token); console.log('refresh_token:', s.refresh_token); console.log('user.id:', s.user && s.user.id);"
