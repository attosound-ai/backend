package middleware

import (
	"strconv"
	"strings"
	"time"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

// JWTClaims holds the custom claims stored in JWT tokens.
type JWTClaims struct {
	UserID   string `json:"sub"`
	Username string `json:"username"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

// JWTManager handles token generation and validation.
type JWTManager struct {
	secret       []byte
	accessExpiry time.Duration
	refreshExpiry time.Duration
}

// NewJWTManager creates a new JWTManager from the application config.
func NewJWTManager(cfg *config.Config) *JWTManager {
	return &JWTManager{
		secret:        []byte(cfg.JWTSecret),
		accessExpiry:  cfg.JWTAccessExpiry,
		refreshExpiry: cfg.JWTRefreshExpiry,
	}
}

// GenerateTokenPair creates both an access token and a refresh token for a user.
func (m *JWTManager) GenerateTokenPair(user *models.User) (*models.TokenPair, error) {
	now := time.Now()

	userIDStr := strconv.FormatUint(user.ID, 10)

	// Access token
	accessClaims := JWTClaims{
		UserID:   userIDStr,
		Username: user.Username,
		Email:    user.Email,
		Role:     string(user.Role),
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userIDStr,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(m.accessExpiry)),
			Issuer:    "atto-sound-user-service",
		},
	}
	accessToken := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims)
	accessStr, err := accessToken.SignedString(m.secret)
	if err != nil {
		return nil, err
	}

	// Refresh token
	refreshClaims := JWTClaims{
		UserID: userIDStr,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userIDStr,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(m.refreshExpiry)),
			Issuer:    "atto-sound-user-service",
		},
	}
	refreshToken := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims)
	refreshStr, err := refreshToken.SignedString(m.secret)
	if err != nil {
		return nil, err
	}

	return &models.TokenPair{
		AccessToken:  accessStr,
		RefreshToken: refreshStr,
		ExpiresIn:    int64(m.accessExpiry.Seconds()),
	}, nil
}

// ValidateToken parses and validates a JWT token string. Returns the claims if valid.
func (m *JWTManager) ValidateToken(tokenStr string) (*JWTClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &JWTClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return m.secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*JWTClaims)
	if !ok || !token.Valid {
		return nil, jwt.ErrSignatureInvalid
	}
	return claims, nil
}

// Generate2FAToken creates a short-lived JWT (5 min) for the 2FA verification step.
func (m *JWTManager) Generate2FAToken(userID uint64) (string, error) {
	now := time.Now()
	idStr := strconv.FormatUint(userID, 10)
	claims := JWTClaims{
		UserID: idStr,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   idStr,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
			Issuer:    "atto-sound-2fa",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(m.secret)
}

// Validate2FAToken validates a 2FA temporary token and checks the issuer.
func (m *JWTManager) Validate2FAToken(tokenStr string) (*JWTClaims, error) {
	claims, err := m.ValidateToken(tokenStr)
	if err != nil {
		return nil, err
	}
	if claims.Issuer != "atto-sound-2fa" {
		return nil, jwt.ErrSignatureInvalid
	}
	return claims, nil
}

// RequireAuth is a Fiber middleware that validates the JWT from the Authorization header.
// On success it stores the claims in c.Locals("claims") and the user ID in c.Locals("userID").
func RequireAuth(jwtMgr *JWTManager) fiber.Handler {
	return func(c *fiber.Ctx) error {
		authHeader := c.Get("Authorization")
		if authHeader == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
				Success: false,
				Error:   "missing authorization header",
			})
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
				Success: false,
				Error:   "invalid authorization header format",
			})
		}

		claims, err := jwtMgr.ValidateToken(parts[1])
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
				Success: false,
				Error:   "invalid or expired token",
			})
		}

		c.Locals("claims", claims)
		c.Locals("userID", claims.UserID)

		return c.Next()
	}
}
