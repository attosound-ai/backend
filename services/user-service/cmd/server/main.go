package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

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
	if err := db.AutoMigrate(
		&models.User{},
		&models.UserCredentials{},
		&models.PushToken{},
		&models.SignupSession{},
		&models.UserAppIconPreference{},
	); err != nil {
		log.Fatalf("[STARTUP] Failed to auto-migrate models: %v", err)
	}
	log.Println("[STARTUP] Database migration completed")

	// Post-migration housekeeping for the signup_sessions refactor.
	// 1. Drop the legacy users.registration_status column. Pending users are
	//    deleted in the cutover migration script; completed users implicitly
	//    have status 'completed' by virtue of being in the users table at all.
	// 2. Create the unique partial index on signup_sessions(identifier) for
	//    active sessions only. AutoMigrate cannot express partial indexes,
	//    so we do it by hand. Idempotent — CREATE INDEX IF NOT EXISTS.
	if db.Migrator().HasColumn(&models.User{}, "registration_status") {
		if err := db.Migrator().DropColumn(&models.User{}, "registration_status"); err != nil {
			log.Printf("[STARTUP] WARN: could not drop users.registration_status: %v", err)
		} else {
			log.Println("[STARTUP] Dropped legacy users.registration_status column")
		}
	}
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS signup_sessions_active_identifier
		ON signup_sessions (identifier)
		WHERE status IN ('started','verified')`).Error; err != nil {
		log.Fatalf("[STARTUP] Failed to create signup_sessions partial index: %v", err)
	}

	// ── Initialise dependencies ──
	repo := repositories.NewUserRepository(db)
	signupRepo := repositories.NewSignupRepository(db)
	jwtMgr := middleware.NewJWTManager(cfg)
	producer := kafka.NewProducer(cfg.KafkaBrokers)
	defer producer.Close()

	authService := services.NewAuthService(repo, jwtMgr, producer, cfg.OTPServiceURL)
	userService := services.NewUserService(repo, producer)
	signupService := services.NewSignupService(signupRepo, repo, jwtMgr, producer, cfg.OTPServiceURL)

	inmateService := services.NewInmateService()

	authHandler := handlers.NewAuthHandler(authService)
	userHandler := handlers.NewUserHandler(userService, cfg.OTPServiceURL)
	verificationHandler := handlers.NewVerificationHandler(userService, cfg.OTPServiceURL)
	inmateHandler := handlers.NewInmateHandler(inmateService)
	pushTokenHandler := handlers.NewPushTokenHandler(repo)
	appIconHandler := handlers.NewAppIconHandler(repo)
	healthHandler := handlers.NewHealthHandler()
	signupHandler := handlers.NewSignupHandler(signupService)

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
	auth.Get("/check-username", authHandler.CheckUsername)
	auth.Get("/check-email", authHandler.CheckEmail)
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
	auth.Post("/complete-registration", authHandler.CompleteRegistration) // 426 — kept for old clients
	auth.Post("/switch-account", middleware.RequireAuth(jwtMgr), authHandler.SwitchAccount)

	// Signup routes — new draft-session flow.
	// Start + verifyOTP are public (session ID + OTP code are the credentials).
	// The remainder requires a signup_pending scoped JWT.
	signup := app.Group("/signup")
	signup.Post("/sessions", signupHandler.Start)
	signup.Post("/sessions/:id/verify-otp", signupHandler.VerifyOTP)
	signup.Get("/sessions/me", middleware.RequireSignupScope(jwtMgr), signupHandler.Me)
	signup.Patch("/sessions/me", middleware.RequireSignupScope(jwtMgr), signupHandler.Patch)
	signup.Post("/sessions/me/complete", middleware.RequireSignupScope(jwtMgr), signupHandler.Complete)
	signup.Delete("/sessions/me", middleware.RequireSignupScope(jwtMgr), signupHandler.Abandon)

	// 2FA management (protected)
	auth.Post("/2fa/enable", middleware.RequireAuth(jwtMgr), authHandler.Enable2FAInit)
	auth.Post("/2fa/confirm", middleware.RequireAuth(jwtMgr), authHandler.Enable2FAConfirm)
	auth.Post("/2fa/disable", middleware.RequireAuth(jwtMgr), authHandler.Disable2FA)

	// User routes (protected — must be registered before parameterized routes)
	users := app.Group("/users")
	users.Patch("/me/profile", middleware.RequireAuth(jwtMgr), userHandler.UpdateProfile)
	users.Get("/me/linked-accounts", middleware.RequireAuth(jwtMgr), authHandler.GetLinkedAccounts)
	users.Post("/me/verification/send-otp", middleware.RequireAuth(jwtMgr), verificationHandler.SendVerificationOTP)
	users.Post("/me/verification/verify", middleware.RequireAuth(jwtMgr), verificationHandler.VerifyOTP)
	users.Post("/me/push-token", middleware.RequireAuth(jwtMgr), pushTokenHandler.RegisterToken)
	users.Delete("/me/push-token", middleware.RequireAuth(jwtMgr), pushTokenHandler.UnregisterToken)
	users.Get("/me/app-icon", middleware.RequireAuth(jwtMgr), appIconHandler.GetAppIcon)
	users.Put("/me/app-icon", middleware.RequireAuth(jwtMgr), appIconHandler.UpdateAppIcon)
	users.Delete("/me/account", middleware.RequireAuth(jwtMgr), userHandler.DeleteAccount)

	// Inmate lookup (public)
	users.Get("/inmates/lookup", inmateHandler.LookupInmate)

	// User routes (public)
	users.Get("/search", userHandler.SearchUsers)
	users.Get("/discover", middleware.RequireAuth(jwtMgr), userHandler.DiscoverUsers)
	users.Get("/:id", userHandler.GetUser)
	users.Get("/:id/followers", userHandler.GetFollowers)
	users.Get("/:id/following", userHandler.GetFollowing)

	// ── Signup session cleanup worker ──
	// Hourly: mark expired sessions abandoned. Grace period 24h before purge so
	// we keep a paper trail for analytics/support. With ~50 signups/day this is
	// negligible storage; revisit if it ever becomes meaningful.
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for {
			marked, purged, err := signupService.CleanupExpired(context.Background(), 24*time.Hour)
			if err != nil {
				log.Printf("[SIGNUP-CLEAN] failed: %v", err)
			} else if marked > 0 || purged > 0 {
				log.Printf("[SIGNUP-CLEAN] marked=%d purged=%d", marked, purged)
			}
			<-ticker.C
		}
	}()

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
