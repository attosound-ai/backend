package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/atto-sound/user-service/internal/config"
	usergrpc "github.com/atto-sound/user-service/internal/grpc"
	"github.com/atto-sound/user-service/internal/handlers"
	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/repositories"
	"github.com/atto-sound/user-service/internal/services"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	// ── Load configuration ──
	cfg := config.Load()

	log.Println("[STARTUP] Atto Sound - User Service")
	log.Printf("[STARTUP] HTTP port: %s | gRPC port: %s", cfg.HTTPPort, cfg.GRPCPort)

	// ── Connect to PostgreSQL ──
	db, err := gorm.Open(postgres.Open(cfg.DSN()), &gorm.Config{})
	if err != nil {
		log.Fatalf("[STARTUP] Failed to connect to PostgreSQL: %v", err)
	}
	log.Println("[STARTUP] Connected to PostgreSQL")

	// ── Auto-migrate GORM models ──
	if err := db.AutoMigrate(&models.User{}, &models.UserCredentials{}); err != nil {
		log.Fatalf("[STARTUP] Failed to auto-migrate models: %v", err)
	}
	log.Println("[STARTUP] Database migration completed")

	// ── Initialise dependencies ──
	repo := repositories.NewUserRepository(db)
	jwtMgr := middleware.NewJWTManager(cfg)
	producer := kafka.NewProducer(cfg.KafkaBrokers)
	defer producer.Close()

	authService := services.NewAuthService(repo, jwtMgr, producer, cfg.OTPServiceURL)
	userService := services.NewUserService(repo, producer)

	inmateService := services.NewInmateService()

	authHandler := handlers.NewAuthHandler(authService)
	userHandler := handlers.NewUserHandler(userService)
	verificationHandler := handlers.NewVerificationHandler(userService, cfg.OTPServiceURL)
	inmateHandler := handlers.NewInmateHandler(inmateService)
	healthHandler := handlers.NewHealthHandler()

	// ── Fiber HTTP server ──
	app := fiber.New(fiber.Config{
		AppName:      "atto-user-service",
		ErrorHandler: globalErrorHandler,
		Network:      "tcp",
	})

	app.Use(recover.New())
	app.Use(logger.New(logger.Config{
		Format: "[${time}] ${status} - ${method} ${path} (${latency})\n",
	}))
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowMethods: "GET,POST,PUT,PATCH,DELETE,OPTIONS",
		AllowHeaders: "Origin,Content-Type,Accept,Authorization",
	}))

	// ── Routes ──

	// Health
	app.Get("/health", healthHandler.Health)

	// Auth routes (public)
	auth := app.Group("/auth")
	auth.Post("/register", authHandler.Register)
	auth.Get("/check-phone", authHandler.CheckPhone)
	auth.Post("/pre-register", authHandler.PreRegister)
	auth.Post("/login", authHandler.Login)
	auth.Post("/login/otp", authHandler.LoginOTP)
	auth.Post("/logout", authHandler.Logout)
	auth.Post("/refresh", authHandler.Refresh)
	auth.Post("/forgot-password", authHandler.ForgotPassword)
	auth.Post("/reset-password", authHandler.ResetPassword)

	// 2FA login (public — uses temp token, not JWT)
	auth.Post("/login/2fa", authHandler.Login2FA)

	// Auth routes (protected)
	auth.Get("/me", middleware.RequireAuth(jwtMgr), authHandler.Me)
	auth.Post("/complete-registration", middleware.RequireAuth(jwtMgr), authHandler.CompleteRegistration)

	// 2FA management (protected)
	auth.Post("/2fa/enable", middleware.RequireAuth(jwtMgr), authHandler.Enable2FAInit)
	auth.Post("/2fa/confirm", middleware.RequireAuth(jwtMgr), authHandler.Enable2FAConfirm)
	auth.Post("/2fa/disable", middleware.RequireAuth(jwtMgr), authHandler.Disable2FA)

	// User routes (protected — must be registered before parameterized routes)
	users := app.Group("/users")
	users.Patch("/me/profile", middleware.RequireAuth(jwtMgr), userHandler.UpdateProfile)
	users.Post("/me/verification/send-otp", middleware.RequireAuth(jwtMgr), verificationHandler.SendVerificationOTP)
	users.Post("/me/verification/verify", middleware.RequireAuth(jwtMgr), verificationHandler.VerifyOTP)

	// Inmate lookup (public)
	users.Get("/inmates/lookup", inmateHandler.LookupInmate)

	// User routes (public)
	users.Get("/search", userHandler.SearchUsers)
	users.Get("/:id", userHandler.GetUser)
	users.Get("/:id/followers", userHandler.GetFollowers)
	users.Get("/:id/following", userHandler.GetFollowing)

	// ── Start gRPC server in a goroutine ──
	grpcServer := usergrpc.NewUserGRPCServer(userService, jwtMgr)
	go func() {
		if err := grpcServer.Start(cfg.GRPCPort); err != nil {
			log.Fatalf("[gRPC] Server failed: %v", err)
		}
	}()

	// ── Graceful shutdown ──
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("[SHUTDOWN] Received signal %s, shutting down...", sig)

		if err := app.Shutdown(); err != nil {
			log.Printf("[SHUTDOWN] HTTP server shutdown error: %v", err)
		}

		producer.Close()
		log.Println("[SHUTDOWN] User service stopped")
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
	return c.Status(code).JSON(models.APIResponse{
		Success: false,
		Error:   err.Error(),
	})
}
