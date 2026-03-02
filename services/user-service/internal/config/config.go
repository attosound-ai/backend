package config

import (
	"os"
	"time"
)

// Config holds all configuration for the user service.
type Config struct {
	HTTPPort         string
	GRPCPort         string
	DBHost           string
	DBPort           string
	DBName           string
	DBUser           string
	DBPassword       string
	DBSSLMode        string
	KafkaBrokers     string
	ConsulAddr       string
	JaegerEndpoint   string
	JWTSecret        string
	JWTAccessExpiry  time.Duration
	JWTRefreshExpiry time.Duration
	OTPServiceURL    string
}

// Load reads configuration from environment variables with sensible defaults.
func Load() *Config {
	cfg := &Config{
		HTTPPort:         getEnv("HTTP_PORT", "8080"),
		GRPCPort:         getEnv("GRPC_PORT", "50051"),
		DBHost:           getEnv("DB_HOST", "localhost"),
		DBPort:           getEnv("DB_PORT", "5432"),
		DBName:           getEnv("DB_NAME", "atto_users"),
		DBUser:           getEnv("DB_USER", "postgres"),
		DBPassword:       getEnv("DB_PASSWORD", "postgres"),
		DBSSLMode:        getEnv("DB_SSLMODE", "disable"),
		KafkaBrokers:     getEnv("KAFKA_BROKERS", "localhost:9092"),
		ConsulAddr:       getEnv("CONSUL_ADDR", "localhost:8500"),
		JaegerEndpoint:   getEnv("JAEGER_ENDPOINT", "http://localhost:14268/api/traces"),
		JWTSecret:        getEnv("JWT_SECRET", "change-me-in-production"),
		JWTAccessExpiry:  parseDuration(getEnv("JWT_ACCESS_EXPIRY", "15m"), 15*time.Minute),
		JWTRefreshExpiry: parseDuration(getEnv("JWT_REFRESH_EXPIRY", "168h"), 168*time.Hour),
		OTPServiceURL:    getEnv("OTP_SERVICE_URL", "http://otp-service:8000"),
	}
	return cfg
}

// DSN returns the PostgreSQL connection string.
func (c *Config) DSN() string {
	return "host=" + c.DBHost +
		" port=" + c.DBPort +
		" dbname=" + c.DBName +
		" user=" + c.DBUser +
		" password=" + c.DBPassword +
		" sslmode=" + c.DBSSLMode
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseDuration(s string, fallback time.Duration) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		return fallback
	}
	return d
}
