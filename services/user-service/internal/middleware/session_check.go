package middleware

import "github.com/golang-jwt/jwt/v5"

// ParseIgnoringExpiry checks a token's signature and algorithm but not its
// expiry (Nov 12 2026). Only for POST /auth/session-check: telephony still
// accepts an expired session token for VoIP wake ups (EXPIRED_GRACE_S) and
// asks this service whether that session was closed since.
func (m *JWTManager) ParseIgnoringExpiry(tokenStr string) (*JWTClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &JWTClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return m.secret, nil
	}, jwt.WithoutClaimsValidation())
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*JWTClaims)
	if !ok || !token.Valid {
		return nil, jwt.ErrSignatureInvalid
	}
	return claims, nil
}
