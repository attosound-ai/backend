#!/bin/sh
set -e

# Default service URLs — Railway private network hostnames.
# Override via env vars if service names differ.
export USER_SERVICE_URL="${USER_SERVICE_URL:-http://user-service.railway.internal:8080}"
export SOCIAL_SERVICE_URL="${SOCIAL_SERVICE_URL:-http://social-service.railway.internal:3000}"
export CHAT_SERVICE_URL="${CHAT_SERVICE_URL:-http://chat-service.railway.internal:4000}"
export CONTENT_SERVICE_URL="${CONTENT_SERVICE_URL:-http://content-service.railway.internal:8081}"
export OTP_SERVICE_URL="${OTP_SERVICE_URL:-http://otp-service.railway.internal:8000}"
export PAYMENT_SERVICE_URL="${PAYMENT_SERVICE_URL:-http://payment-service.railway.internal:8000}"
export TELEPHONY_SERVICE_URL="${TELEPHONY_SERVICE_URL:-http://telephony-service.railway.internal:3009}"

# Generate kong.yml from template
envsubst < /etc/kong/kong.yml.template > /etc/kong/kong.yml

exec /docker-entrypoint.sh kong docker-start
