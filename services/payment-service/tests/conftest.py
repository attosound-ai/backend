"""Test environment bootstrap.

Sets the minimum env vars required for `app.config.Settings()` to load
without errors. The calculator tests don't actually use Stripe, but the
package's __init__ eagerly imports PaymentService which imports config,
which validates STRIPE_SECRET_KEY at module-load time.
"""

import os

os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_placeholder_for_tests")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_placeholder")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
os.environ.setdefault("KAFKA_BROKERS", "localhost:9092")
