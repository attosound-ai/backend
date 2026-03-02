# ── Stage 1: Builder ──
FROM rust:1.88 AS builder

RUN apt-get update && apt-get install -y \
    libssl-dev \
    pkg-config \
    cmake \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests and build script first for layer caching
COPY Cargo.toml Cargo.lock* build.rs ./
COPY proto/ proto/

# Create a dummy main.rs to pre-build dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release 2>/dev/null || true
RUN rm -rf src

# Copy full source and build
COPY src/ src/
RUN touch src/main.rs && cargo build --release

# ── Stage 2: Runtime ──
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary and create upload directory
COPY --from=builder /app/target/release/content-service /app/content-service
RUN mkdir -p /app/uploads

ENV UPLOAD_DIR=/app/uploads
ENV RUST_LOG=info

EXPOSE 8081 50052

CMD ["/app/content-service"]
