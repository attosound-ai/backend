package handlers

import (
	"errors"
	"log"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
	"github.com/atto-sound/user-service/internal/services"
)

// pendingDeletionBody es lo que la app recibe cuando alguien entra en una
// cuenta en gracia de borrado. 403 y no 401: el cliente no debe intentar
// renovar la sesión, tiene que enseñar la pantalla de recuperar.
type pendingDeletionBody struct {
	UserID              uint64    `json:"userId"`
	Username            string    `json:"username"`
	ScheduledDeletionAt time.Time `json:"scheduledDeletionAt"`
	RecoveryToken       string    `json:"recoveryToken,omitempty"`
	AlsoRecovers        []string  `json:"alsoRecovers,omitempty"`
}

// writePendingDeletion responde 403 account_pending_deletion si err es una
// cuenta en gracia. Devuelve false si no lo era (el llamador sigue).
func writePendingDeletion(c *fiber.Ctx, err error) (bool, error) {
	pending, ok := services.IsAccountPendingDeletion(err)
	if !ok {
		return false, nil
	}
	return true, c.Status(fiber.StatusForbidden).JSON(models.APIResponse{
		Success: false,
		Error:   services.AccountPendingDeletionCode,
		Data: pendingDeletionBody{
			UserID:              pending.UserID,
			Username:            pending.Username,
			ScheduledDeletionAt: pending.ScheduledDeletionAt,
			RecoveryToken:       pending.RecoveryToken,
			AlsoRecovers:        pending.AlsoRecovers,
		},
	})
}

// RecoverAccount handles POST /auth/login/recover {recoveryToken}: el botón
// Recuperar de la pantalla de la cuenta en gracia. Devuelve la sesión igual
// que el login. Va bajo /auth/login para que el cliente la trate como ruta
// pública (no adjunta ni renueva el token de otra cuenta).
func (h *AuthHandler) RecoverAccount(c *fiber.Ctx) error {
	var req struct {
		RecoveryToken string `json:"recoveryToken"`
	}
	if err := c.BodyParser(&req); err != nil || req.RecoveryToken == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "recoveryToken is required",
		})
	}
	started := time.Now()
	res, ids, err := h.authService.RecoverAccount(c.Context(), req.RecoveryToken)
	if err != nil {
		status := fiber.StatusInternalServerError
		switch {
		case err.Error() == "invalid or expired recovery token":
			status = fiber.StatusUnauthorized
		case errors.Is(err, repositories.ErrNoPendingDeletion), err.Error() == "user not found":
			// El barrido ya la borró, o nunca estuvo en gracia.
			status = fiber.StatusGone
		}
		return c.Status(status).JSON(models.APIResponse{Success: false, Error: err.Error()})
	}
	log.Printf("[AUTH] account recovered: users=%v in %s", ids, time.Since(started))
	return c.JSON(models.APIResponse{
		Success: true,
		Data: fiber.Map{
			"user":         res.User,
			"tokens":       res.Tokens,
			"recoveredIds": idList(ids),
		},
	})
}

func idList(ids []uint64) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = strconv.FormatUint(id, 10)
	}
	return out
}
