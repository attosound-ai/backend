FROM kong:3.6

# Install envsubst (from gettext package)
USER root
RUN apt-get update && apt-get install -y gettext-base && rm -rf /var/lib/apt/lists/*

COPY kong.yml.template /etc/kong/kong.yml.template
COPY docker-entrypoint.sh /docker-entrypoint-custom.sh
RUN chmod +x /docker-entrypoint-custom.sh

ENV KONG_DATABASE=off
# KONG_DECLARATIVE_CONFIG is set at runtime by docker-entrypoint.sh after envsubst

USER kong
ENTRYPOINT ["/docker-entrypoint-custom.sh"]
