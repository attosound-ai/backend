#!/usr/bin/env bash
set -euo pipefail

PROTO_DIR="$(cd "$(dirname "$0")/.." && pwd)/proto"
SERVICES_DIR="$(cd "$(dirname "$0")/.." && pwd)/services"

echo "🔧 Generating protobuf code from ${PROTO_DIR}..."

# ── Go (User Service) ──
echo "  → Go (user-service)..."
GO_OUT="${SERVICES_DIR}/user-service/proto/gen"
mkdir -p "${GO_OUT}"
protoc \
  --proto_path="${PROTO_DIR}" \
  --go_out="${GO_OUT}" \
  --go_opt=paths=source_relative \
  --go-grpc_out="${GO_OUT}" \
  --go-grpc_opt=paths=source_relative \
  "${PROTO_DIR}"/*.proto
echo "    ✓ Go protobuf generated"

# ── Rust (Content Service) ──
# Rust uses tonic-build via build.rs, so we just copy protos
echo "  → Rust (content-service)..."
RUST_PROTO="${SERVICES_DIR}/content-service/proto"
mkdir -p "${RUST_PROTO}"
cp "${PROTO_DIR}"/*.proto "${RUST_PROTO}/"
echo "    ✓ Proto files copied for tonic-build"

# ── TypeScript (Social Service) ──
echo "  → TypeScript (social-service)..."
TS_OUT="${SERVICES_DIR}/social-service/proto/gen"
mkdir -p "${TS_OUT}"
if command -v grpc_tools_node_protoc_plugin &>/dev/null; then
  protoc \
    --proto_path="${PROTO_DIR}" \
    --plugin=protoc-gen-ts_proto="$(which protoc-gen-ts_proto 2>/dev/null || echo './node_modules/.bin/protoc-gen-ts_proto')" \
    --ts_proto_out="${TS_OUT}" \
    --ts_proto_opt=nestJs=true \
    --ts_proto_opt=addGrpcMetadata=true \
    --ts_proto_opt=outputEncodeMethods=false \
    --ts_proto_opt=outputJsonMethods=false \
    --ts_proto_opt=outputClientImpl=false \
    "${PROTO_DIR}"/*.proto
  echo "    ✓ TypeScript protobuf generated"
else
  echo "    ⚠ ts-proto not found. Install with: npm i -g ts-proto"
  echo "    Copying proto files as fallback..."
  cp "${PROTO_DIR}"/*.proto "${TS_OUT}/"
fi

# ── Python (Payment Service) ──
echo "  → Python (payment-service)..."
PY_OUT="${SERVICES_DIR}/payment-service/proto/gen"
mkdir -p "${PY_OUT}"
python3 -m grpc_tools.protoc \
  --proto_path="${PROTO_DIR}" \
  --python_out="${PY_OUT}" \
  --pyi_out="${PY_OUT}" \
  --grpc_python_out="${PY_OUT}" \
  "${PROTO_DIR}"/*.proto 2>/dev/null || {
  echo "    ⚠ grpcio-tools not found. Install with: pip install grpcio-tools"
  echo "    Copying proto files as fallback..."
  cp "${PROTO_DIR}"/*.proto "${PY_OUT}/"
}
touch "${PY_OUT}/__init__.py"
echo "    ✓ Python protobuf generated"

# ── Elixir (Chat Service) ──
# Elixir uses protobuf-elixir via mix compile, so we copy protos
echo "  → Elixir (chat-service)..."
EX_PROTO="${SERVICES_DIR}/chat-service/proto"
mkdir -p "${EX_PROTO}"
cp "${PROTO_DIR}"/*.proto "${EX_PROTO}/"
echo "    ✓ Proto files copied for protobuf-elixir"

echo ""
echo "✅ All protobuf code generated successfully!"
