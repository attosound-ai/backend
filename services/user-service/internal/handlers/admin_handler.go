package handlers

import (
	"context"
	"errors"
	"log"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
	"github.com/atto-sound/user-service/internal/services"
)

// accountAdmin is the slice of UserService the operator routes need. An
// interface so the guard rails below can be tested without a database.
type accountAdmin interface {
	GetUserByID(ctx context.Context, id string) (*models.UserProfile, error)
	DeleteAccount(ctx context.Context, userID uint64, deleteLinked bool, meta services.DeletionMeta) error
	ListUsersForAdmin(f repositories.AdminUserFilter) (*services.AdminUserList, error)
	ListDeletions(search string, limit, offset int) (*services.DeletionList, error)
	RelinkOrphanedCreator(ctx context.Context, req services.RelinkRequest) (*services.RelinkResult, error)
}

// AdminHandler serves operator only routes. Every route is mounted behind
// middleware.RequireAdminToken.
type AdminHandler struct {
	accounts accountAdmin
}

// NewAdminHandler creates an AdminHandler.
func NewAdminHandler(accounts accountAdmin) *AdminHandler {
	return &AdminHandler{accounts: accounts}
}

// DeleteUser handles DELETE /users/admin/:id?username=<name>&deleteLinked=<bool>
// &requestedBy=<who asked>&performedBy=<who runs it>&reason=<why>.
//
// The self service deletion needs an OTP sent to the owner, so support had no
// way to honour a removal request. This runs the SAME deletion (user-service
// rows plus the user.deleted event every other service purges on), never a
// hand written subset.
//
// Guard rails: the numeric id must be paired with the account's username, so
// a mistyped id cannot delete a stranger; and linked accounts (a
// representative's managed creators) are only included when asked for.
//
// requestedBy, performedBy and reason are required (Oct 3 2026): arami (266)
// was deleted here on Sep 20 and two weeks later nobody could say who asked.
// They are stored in account_deletions in the same transaction as the delete.
func (h *AdminHandler) DeleteUser(c *fiber.Ctx) error {
	id := c.Params("id")
	uid, err := strconv.ParseUint(id, 10, 64)
	if err != nil || uid == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "invalid user ID",
		})
	}

	expected := strings.TrimSpace(c.Query("username"))
	if expected == "" {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "username is required to confirm the account",
		})
	}

	deleteLinked := false
	if raw := c.Query("deleteLinked"); raw != "" {
		parsed, perr := strconv.ParseBool(raw)
		if perr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
				Success: false,
				Error:   "deleteLinked must be true or false",
			})
		}
		deleteLinked = parsed
	}

	profile, err := h.accounts.GetUserByID(c.Context(), id)
	if err != nil || profile == nil {
		return c.Status(fiber.StatusNotFound).JSON(models.APIResponse{
			Success: false,
			Error:   "user not found",
		})
	}
	if !strings.EqualFold(profile.Username, expected) {
		return c.Status(fiber.StatusConflict).JSON(models.APIResponse{
			Success: false,
			Error:   "username does not match this user ID",
		})
	}

	meta := services.DeletionMeta{
		Via:         models.DeletionViaOperator,
		RequestedBy: strings.TrimSpace(c.Query("requestedBy")),
		PerformedBy: strings.TrimSpace(c.Query("performedBy")),
		Reason:      strings.TrimSpace(c.Query("reason")),
		ClientIP:    clientIP(c),
		UserAgent:   string(c.Request().Header.UserAgent()),
	}
	if err := meta.Validate(); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "requestedBy, performedBy and reason are required: say who asked for this deletion, who is running it and why",
		})
	}

	if err := h.accounts.DeleteAccount(c.Context(), uid, deleteLinked, meta); err != nil {
		log.Printf("[ADMIN] delete user %d (%s) failed: %v", uid, profile.Username, err)
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	log.Printf("[ADMIN] deleted user %d (%s) deleteLinked=%t requestedBy=%q performedBy=%q reason=%q",
		uid, profile.Username, deleteLinked, meta.RequestedBy, meta.PerformedBy, meta.Reason)
	return c.JSON(models.APIResponse{
		Success: true,
		Data: fiber.Map{
			"deletedUserId": uid,
			"username":      profile.Username,
			"deleteLinked":  deleteLinked,
		},
	})
}

// ListUsers handles GET /users/admin.
//
// La lista de quién se ha registrado, que hasta ahora solo se podía mirar
// entrando a la base de datos. Paginada y ordenada por fecha de alta
// descendente, con búsqueda por nombre de usuario, nombre visible, correo,
// teléfono o nombre de creador, y filtro por rol.
//
// Tope duro de 200 por página en el repositorio: esta ruta la sirve el mismo
// proceso que atiende el login de toda la app, y una página sin tope sería una
// forma de tumbarlo desde fuera si el token se filtrara.
func (h *AdminHandler) ListUsers(c *fiber.Ctx) error {
	filtro := repositories.AdminUserFilter{
		Search: strings.TrimSpace(c.Query("search")),
		Role:   strings.ToLower(strings.TrimSpace(c.Query("role"))),
	}

	switch filtro.Role {
	case "", string(models.RoleCreator), string(models.RoleRepresentative), string(models.RoleListener):
		// vale
	default:
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
			Success: false,
			Error:   "role must be creator, representative or listener",
		})
	}

	if raw := strings.TrimSpace(c.Query("managed")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
				Success: false,
				Error:   "managed must be true or false",
			})
		}
		filtro.Managed = &parsed
	}

	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
				Success: false,
				Error:   "limit must be a positive number",
			})
		}
		filtro.Limit = n
	}
	if raw := strings.TrimSpace(c.Query("offset")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{
				Success: false,
				Error:   "offset must be zero or more",
			})
		}
		filtro.Offset = n
	}

	list, err := h.accounts.ListUsersForAdmin(filtro)
	if err != nil {
		log.Printf("[ADMIN] list users failed: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}

	return c.JSON(models.APIResponse{Success: true, Data: list})
}

// ListDeletions handles GET /users/admin/deletions?search=&limit=&offset=.
// Every deleted account with who asked, who ran it, why, and the creators it
// left without a representative.
func (h *AdminHandler) ListDeletions(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit"))
	offset, _ := strconv.Atoi(c.Query("offset"))
	if offset < 0 {
		offset = 0
	}
	list, err := h.accounts.ListDeletions(strings.TrimSpace(c.Query("search")), limit, offset)
	if err != nil {
		log.Printf("[ADMIN] list deletions failed: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(models.APIResponse{
			Success: false,
			Error:   err.Error(),
		})
	}
	return c.JSON(models.APIResponse{Success: true, Data: list})
}

// RelinkCreator handles POST /users/admin/relink: a new representative for a
// managed creator whose representative was deleted.
func (h *AdminHandler) RelinkCreator(c *fiber.Ctx) error {
	var req services.RelinkRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(models.APIResponse{Success: false, Error: "invalid request body"})
	}
	res, err := h.accounts.RelinkOrphanedCreator(c.Context(), req)
	if err != nil {
		status := fiber.StatusInternalServerError
		switch {
		case errors.Is(err, services.ErrRelinkIncomplete):
			status = fiber.StatusBadRequest
		case err.Error() == "user not found":
			status = fiber.StatusNotFound
		case errors.Is(err, services.ErrRelinkNameMismatch), errors.Is(err, services.ErrRelinkNotCreator),
			errors.Is(err, services.ErrRelinkNotOrphan), errors.Is(err, services.ErrRelinkTaken):
			status = fiber.StatusConflict
		}
		return c.Status(status).JSON(models.APIResponse{Success: false, Error: err.Error()})
	}
	return c.JSON(models.APIResponse{Success: true, Data: res})
}
