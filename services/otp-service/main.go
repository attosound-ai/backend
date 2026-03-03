package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/atto-sound/otp-service/config"
	"github.com/atto-sound/otp-service/handlers"
	"github.com/atto-sound/otp-service/middleware"
	"github.com/atto-sound/otp-service/providers"
	"github.com/atto-sound/otp-service/repository"
	"github.com/atto-sound/otp-service/services"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	fiberlogger "github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/redis/go-redis/v9"
)

func main() {
	// ── Load configuration ──
	cfg := config.Load()

	log.Println("[STARTUP] Atto Sound - OTP Service")
	log.Printf("[STARTUP] HTTP port: %s | delivery: %s", cfg.HTTPPort, cfg.DeliveryProvider)

	// ── Connect to Redis ──
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("[STARTUP] Failed to parse Redis URL: %v", err)
	}

	redisClient := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := redisClient.Ping(ctx).Err(); err != nil {
		log.Fatalf("[STARTUP] Failed to connect to Redis: %v", err)
	}
	log.Println("[STARTUP] Connected to Redis")

	// ── Initialise dependencies ──
	repo := repository.NewRedisRepository(redisClient)
	delivery := providers.NewDeliveryProvider(cfg)
	otpService := services.NewOTPService(cfg, repo, delivery)
	otpHandler := handlers.NewOTPHandler(otpService)
	healthHandler := handlers.NewHealthHandler()

	// ── Fiber HTTP server ──
	app := fiber.New(fiber.Config{
		AppName:      "atto-otp-service",
		ErrorHandler: globalErrorHandler,
		Network:      "tcp",
	})

	app.Use(recover.New())
	app.Use(fiberlogger.New(fiberlogger.Config{
		Format: "[${time}] ${status} - ${method} ${path} (${latency})\n",
	}))
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowMethods: "GET,POST,OPTIONS",
		AllowHeaders: "Origin,Content-Type,Accept,Authorization",
	}))

	// Global rate limiter (IP-based)
	app.Use(middleware.NewRateLimiter(middleware.RateLimiterConfig{
		Max:    60,
		Window: 1 * time.Minute,
	}))

	// ── Routes ──

	// Health
	app.Get("/health", healthHandler.Health)

	// OTP routes
	otp := app.Group("/otp")
	otp.Post("/send", otpHandler.Send)
	otp.Post("/verify", otpHandler.Verify)

	// ── Graceful shutdown ──
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("[SHUTDOWN] Received signal %s, shutting down...", sig)

		if err := app.Shutdown(); err != nil {
			log.Printf("[SHUTDOWN] HTTP server shutdown error: %v", err)
		}

		if err := redisClient.Close(); err != nil {
			log.Printf("[SHUTDOWN] Redis close error: %v", err)
		}

		log.Println("[SHUTDOWN] OTP service stopped")
		os.Exit(0)
	}()

	// ── Start HTTP server ──
	log.Printf("[STARTUP] HTTP server listening on [::]:%s", cfg.HTTPPort)
	if err := app.Listen("[::]:"+cfg.HTTPPort); err != nil {
		log.Fatalf("[STARTUP] HTTP server failed: %v", err)
	}
}

// globalErrorHandler provides a consistent JSON error response for unhandled Fiber errors.
func globalErrorHandler(c *fiber.Ctx, err error) error {
	code := fiber.StatusInternalServerError
	if e, ok := err.(*fiber.Error); ok {
		code = e.Code
	}
	return c.Status(code).JSON(handlers.APIResponse{
		Success: false,
		Error:   err.Error(),
	})
}
