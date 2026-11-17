package middleware

import (
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/models"
)

// TelephonyServiceTokenIssuer is the issuer of the token telephony-service
// signs (with the shared JWT secret) when it reads a user's push tokens or
// linked account ids. Keep in sync with
// services/telephony-service/src/users-client/internal-service-token.ts.
const TelephonyServiceTokenIssuer = "atto-sound-telephony-service-internal"

// userSessionIssuer is the issuer of a real session (GenerateTokenPair). The
// 2FA temp token and the signup token carry other issuers and must never pass
// as the owner here.
const userSessionIssuer = "atto-sound-user-service"

// MaxServiceTokenLifetime caps how long a service token may live (exp minus
// iat). Callers sign one per request with a one minute life; a token minted
// for hours is not a service call and is refused.
const MaxServiceTokenLifetime = 5 * time.Minute

// internalServiceIssuers are the sibling services allowed to read the
// internal user routes.
var internalServiceIssuers = map[string]bool{
	TelephonyServiceTokenIssuer: true,
	ServiceTokenIssuer:          true,
}

// RequireInternalCallerOrOwner gates routes that exist for server to server
// calls (push tokens, linked account ids). Nov 12 2026: they answered anyone,
// through Kong and through the service's own public domain, and ids are
// sequential, so every user's push tokens and every representative to inmate
// link could be listed.
//
// It lets through only:
//   - a service token (scope "service") signed with the shared secret by an
//     allowed sibling, short lived; or
//   - the owner's own session (scope "user", real session issuer) whose
//     subject is the id in the path.
//
// Everything else is 401 (no or bad token) or 403 (valid token, not allowed).
// It does not trust the network: the gateway also blocks these paths, but the
// service is reachable on its own domain too.
func RequireInternalCallerOrOwner(jwtMgr *JWTManager, idParam string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		parts := strings.SplitN(c.Get("Authorization"), " ", 2)
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" || parts[1] == "" {
			return deny(c, fiber.StatusUnauthorized)
		}
		claims, err := jwtMgr.ValidateToken(parts[1])
		if err != nil {
			return deny(c, fiber.StatusUnauthorized)
		}

		switch claims.EffectiveScope() {
		case ScopeService:
			if !internalServiceIssuers[claims.Issuer] || !strings.HasPrefix(claims.UserID, "service:") {
				return deny(c, fiber.StatusForbidden)
			}
			if claims.ExpiresAt == nil || claims.IssuedAt == nil ||
				claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time) > MaxServiceTokenLifetime {
				return deny(c, fiber.StatusForbidden)
			}
			c.Locals("internalCaller", claims.Issuer)
			return c.Next()

		case ScopeUser:
			if claims.Issuer != userSessionIssuer {
				return deny(c, fiber.StatusForbidden)
			}
			pathID, err1 := strconv.ParseUint(c.Params(idParam), 10, 64)
			subID, err2 := strconv.ParseUint(claims.UserID, 10, 64)
			if err1 != nil || err2 != nil || pathID == 0 || pathID != subID {
				return deny(c, fiber.StatusForbidden)
			}
			c.Locals("claims", claims)
			c.Locals("userID", claims.UserID)
			c.Locals("scope", ScopeUser)
			return c.Next()
		}
		return deny(c, fiber.StatusForbidden)
	}
}

func deny(c *fiber.Ctx, status int) error {
	msg := "unauthorized"
	if status == fiber.StatusForbidden {
		msg = "forbidden"
	}
	return c.Status(status).JSON(models.APIResponse{Success: false, Error: msg})
}
