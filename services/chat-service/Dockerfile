# Build stage
FROM elixir:1.16-alpine AS builder

RUN apk add --no-cache build-base git

WORKDIR /app

# Install hex and rebar
RUN mix local.hex --force && \
    mix local.rebar --force

# Set build environment
ENV MIX_ENV=prod

# Install dependencies
COPY mix.exs ./
RUN mix deps.get --only prod && \
    mix deps.compile

# Copy application code
COPY config config
COPY lib lib

# Compile the release
RUN mix compile

# Runtime stage
FROM elixir:1.16-alpine AS runtime

RUN apk add --no-cache \
    libstdc++ \
    openssl \
    ncurses-libs \
    libgcc \
    curl

WORKDIR /app

# Install hex and rebar for runtime
RUN mix local.hex --force && \
    mix local.rebar --force

# Copy compiled artifacts from builder
COPY --from=builder /app/_build/prod /app/_build/prod
COPY --from=builder /app/deps /app/deps
COPY --from=builder /app/mix.exs /app/mix.exs
COPY --from=builder /app/mix.lock /app/mix.lock
COPY --from=builder /app/config /app/config
COPY --from=builder /app/lib /app/lib

ENV MIX_ENV=prod
ENV PORT=4000

EXPOSE 4000 50054

CMD ["mix", "phx.server"]
