from pydantic import model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    app_env: str = "development"
    http_port: int = 8000
    grpc_port: int = 50055
    database_url: str = "postgresql+asyncpg://atto:atto_dev@localhost:5434/atto_payments"
    kafka_brokers: str = "localhost:9092"
    kafka_use_tls: bool = False
    kafka_sasl_username: str = ""
    kafka_sasl_password: str = ""
    user_service_grpc: str = "localhost:50051"
    consul_addr: str = "localhost:8500"
    jaeger_endpoint: str = "http://localhost:4318/v1/traces"

    # JWT (shared with user-service for token validation)
    jwt_secret: str = "change-me-in-production"

    # Twilio (bridge numbers)
    twilio_bridge_number: str = ""

    # Stripe
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_publishable_key: str = ""
    stripe_annual_price_id: str = ""
    stripe_monthly_price_id: str = ""

    model_config = {"env_prefix": "", "case_sensitive": False}

    @model_validator(mode="after")
    def fix_database_url_and_validate(self) -> "Settings":
        # Railway provides postgresql:// but asyncpg requires postgresql+asyncpg://
        if self.database_url.startswith("postgresql://"):
            self.database_url = self.database_url.replace(
                "postgresql://", "postgresql+asyncpg://", 1
            )
        if not self.stripe_secret_key:
            raise ValueError(
                "STRIPE_SECRET_KEY is empty or not set. "
                "Ensure the .env file is in the docker-compose working directory."
            )
        return self


settings = Settings()
