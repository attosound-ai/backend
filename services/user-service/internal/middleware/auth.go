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

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Token scopes. Absence of the claim is treated as ScopeUser for backward
// compatibility with tokens issued before the scope field existed.
const (
	ScopeUser          = "user"           // full session for a confirmed user
	ScopeSignupPending = "signup_pending" // limited token for in-progress signup
)

// JWTClaims holds the custom claims stored in JWT tokens.
// Scope gates which endpoints a token can reach: a signup_pending token must
// only access /signup/*, never the rest of the API.
type JWTClaims struct {
	UserID   string `json:"sub"`
	Username string `json:"username"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	Scope    string `json:"scope,omitempty"`
	jwt.RegisteredClaims
}

// EffectiveScope returns the scope to enforce, defaulting to ScopeUser when
// the claim is missing (older tokens issued before scopes existed).
func (c *JWTClaims) EffectiveScope() string {
	if c.Scope == "" {
		return ScopeUser
	}
	return c.Scope
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
		Email:    derefStr(user.Email),
		Role:     string(user.Role),
		Scope:    ScopeUser,
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
		Scope:  ScopeUser,
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

// GenerateSignupToken issues a scope-limited token for an in-progress signup.
// The subject is the signup session UUID, not a user ID — there is no user yet.
// Expiry matches the session TTL (24h by default; cron purges past that).
func (m *JWTManager) GenerateSignupToken(sessionID string, ttl time.Duration) (string, int64, error) {
	now := time.Now()
	exp := now.Add(ttl)
	claims := JWTClaims{
		UserID: "signup:" + sessionID, // namespaced so it can't collide with numeric user IDs
		Scope:  ScopeSignupPending,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "signup:" + sessionID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
			Issuer:    "atto-sound-signup",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(m.secret)
	if err != nil {
		return "", 0, err
	}
	return signed, int64(ttl.Seconds()), nil
}

// SignupSessionID extracts the bare UUID from a signup_pending claim.
// Returns empty string if the claim isn't in the expected "signup:<uuid>" form.
// The "sub" JSON field unmarshals into UserID (not RegisteredClaims.Subject)
// because of the duplicate `json:"sub"` tag — that's why we read UserID here.
func SignupSessionID(claims *JWTClaims) string {
	const prefix = "signup:"
	if claims == nil || !strings.HasPrefix(claims.UserID, prefix) {
		return ""
	}
	return claims.UserID[len(prefix):]
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

// extractClaims validates the bearer token from the request and stores the
// resulting claims under c.Locals. Returns nil + a Fiber error response when
// the header is missing or the token is invalid.
func extractClaims(c *fiber.Ctx, jwtMgr *JWTManager) (*JWTClaims, error) {
	authHeader := c.Get("Authorization")
	if authHeader == "" {
		return nil, c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "missing authorization header",
		})
	}

	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
		return nil, c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid authorization header format",
		})
	}

	claims, err := jwtMgr.ValidateToken(parts[1])
	if err != nil {
		return nil, c.Status(fiber.StatusUnauthorized).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid or expired token",
		})
	}
	c.Locals("claims", claims)
	c.Locals("userID", claims.UserID)
	c.Locals("scope", claims.EffectiveScope())
	return claims, nil
}

// RequireAuth gates routes intended for fully-registered users. A signup_pending
// token reaching one of these routes is rejected with 403, not 401 — the token
// is valid, it just doesn't have the right scope. Returning 401 here would
// trick the client into a refresh loop.
func RequireAuth(jwtMgr *JWTManager) fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims, errResp := extractClaims(c, jwtMgr)
		if errResp != nil {
			return errResp
		}
		if claims.EffectiveScope() != ScopeUser {
			return c.Status(fiber.StatusForbidden).JSON(models.APIResponse{
				Success: false,
				Error:   "insufficient_scope: finish registration first",
			})
		}
		return c.Next()
	}
}

// RequireSignupScope gates the /signup/* endpoints. The token must carry the
// signup_pending scope; full user tokens are rejected so a confirmed user can
// never accidentally drive signup endpoints with their session token.
func RequireSignupScope(jwtMgr *JWTManager) fiber.Handler {
	return func(c *fiber.Ctx) error {
		claims, errResp := extractClaims(c, jwtMgr)
		if errResp != nil {
			return errResp
		}
		if claims.EffectiveScope() != ScopeSignupPending {
			return c.Status(fiber.StatusForbidden).JSON(models.APIResponse{
				Success: false,
				Error:   "insufficient_scope: signup token required",
			})
		}
		return c.Next()
	}
}
