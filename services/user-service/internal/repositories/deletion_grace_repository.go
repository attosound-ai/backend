package repositories

import (
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/atto-sound/user-service/internal/models"
)

// Borrado con 30 días de gracia (12 nov 2026). Todo lo que cambia el estado
// de una petición va en una transacción con las filas de la petición
// bloqueadas (FOR UPDATE): recuperar y vencer pueden cruzarse, y el barrido
// puede correr en dos réplicas a la vez; quien llega segundo ve que la
// petición ya no está pendiente y no hace nada.

// ErrNoPendingDeletion: no hay petición pendiente (ya se recuperó, ya se
// borró, o nunca se pidió).
var ErrNoPendingDeletion = errors.New("no pending deletion for this account")

// ErrDeletionNotDue: la petición ya no está pendiente o todavía no vence.
var ErrDeletionNotDue = errors.New("deletion batch is not due or no longer pending")

// supersedePendingRequests cierra las peticiones pendientes de estas cuentas
// cuando se borran por otro camino (borrado inmediato del operador).
func supersedePendingRequests(tx *gorm.DB, userIDs []uint64, by string, at time.Time) error {
	if len(userIDs) == 0 {
		return nil
	}
	if err := tx.Model(&models.AccountDeletionRequest{}).
		Where("user_id IN ? AND status = ?", userIDs, models.DeletionRequestPending).
		Updates(map[string]interface{}{
			"status":      models.DeletionRequestSuperseded,
			"resolved_at": at,
			"resolved_by": by,
		}).Error; err != nil {
		return fmt.Errorf("supersede account_deletion_requests: %w", err)
	}
	return nil
}

// DeactivateForDeletion desactiva las cuentas de requests y deja escritas
// sus peticiones, todo o nada: ocultas para los demás, sesiones cerradas
// (SessionsValidAfter) y pushes apagados.
func (r *UserRepository) DeactivateForDeletion(requests []models.AccountDeletionRequest) error {
	if len(requests) == 0 {
		return errors.New("refusing to deactivate without a deletion request")
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		ids := make([]uint64, 0, len(requests))
		for _, req := range requests {
			ids = append(ids, req.UserID)
		}
		// Las que ya están en gracia conservan su fecha: no se pisa.
		var already int64
		if err := tx.Model(&models.User{}).Where("id IN ? AND deactivated_at IS NOT NULL", ids).
			Count(&already).Error; err != nil {
			return err
		}
		if already > 0 {
			return fmt.Errorf("%d of these accounts are already pending deletion", already)
		}
		if err := tx.Create(&requests).Error; err != nil {
			return fmt.Errorf("write account_deletion_requests: %w", err)
		}
		for _, req := range requests {
			res := tx.Model(&models.User{}).Where("id = ? AND deactivated_at IS NULL", req.UserID).
				Updates(map[string]interface{}{
					"deactivated_at":        req.RequestedAt,
					"scheduled_deletion_at": req.ScheduledFor,
					"sessions_valid_after":  req.RequestedAt,
				})
			if res.Error != nil {
				return fmt.Errorf("deactivate user %d: %w", req.UserID, res.Error)
			}
			if res.RowsAffected != 1 {
				return fmt.Errorf("deactivate user %d: not found or already pending", req.UserID)
			}
		}
		if err := tx.Model(&models.PushToken{}).Where("user_id IN ?", ids).
			Update("is_active", false).Error; err != nil {
			return fmt.Errorf("silence push_tokens: %w", err)
		}
		// Remembered devices (Nov 12 2026) end with the sessions: "Continue"
		// on any phone asks the password, and the password login shows the
		// recover screen. Recovering does not bring them back.
		if err := tx.Model(&models.DeviceKey{}).Where("user_id IN ? AND revoked_at IS NULL", ids).
			Updates(map[string]interface{}{
				"revoked_at":           requests[0].RequestedAt,
				"revoked_reason":       models.DeviceKeyRevokedDeactivated,
				"challenge_hash":       "",
				"challenge_expires_at": nil,
			}).Error; err != nil {
			return fmt.Errorf("revoke device_keys: %w", err)
		}
		return nil
	})
}

// FindPendingRequest devuelve la petición pendiente de una cuenta, o nil.
func (r *UserRepository) FindPendingRequest(userID uint64) (*models.AccountDeletionRequest, error) {
	var req models.AccountDeletionRequest
	err := r.db.Where("user_id = ? AND status = ?", userID, models.DeletionRequestPending).
		Order("id DESC").First(&req).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &req, nil
}

// PendingRequestsInBatch devuelve las peticiones pendientes de un lote.
func (r *UserRepository) PendingRequestsInBatch(batchID string) ([]models.AccountDeletionRequest, error) {
	var rows []models.AccountDeletionRequest
	err := r.db.Where("batch_id = ? AND status = ?", batchID, models.DeletionRequestPending).
		Order("id ASC").Find(&rows).Error
	return rows, err
}

// RecoverAccounts reactiva las cuentas userIDs que siguen pendientes en
// batchID. Devuelve las que de verdad se reactivaron. Ninguna: el barrido
// ganó la carrera o ya se habían recuperado (ErrNoPendingDeletion).
func (r *UserRepository) RecoverAccounts(batchID string, userIDs []uint64, by string, at time.Time) ([]uint64, error) {
	var recovered []uint64
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var rows []models.AccountDeletionRequest
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("batch_id = ? AND user_id IN ? AND status = ?", batchID, userIDs, models.DeletionRequestPending).
			Find(&rows).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return ErrNoPendingDeletion
		}
		ids := make([]uint64, 0, len(rows))
		reqIDs := make([]uint64, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.UserID)
			reqIDs = append(reqIDs, row.ID)
		}
		// sessions_valid_after se queda como está: los otros dispositivos
		// siguen fuera aunque la cuenta vuelva.
		if err := tx.Model(&models.User{}).Where("id IN ?", ids).
			Updates(map[string]interface{}{
				"deactivated_at":        nil,
				"scheduled_deletion_at": nil,
			}).Error; err != nil {
			return fmt.Errorf("reactivate users: %w", err)
		}
		if err := tx.Model(&models.AccountDeletionRequest{}).Where("id IN ?", reqIDs).
			Updates(map[string]interface{}{
				"status":      models.DeletionRequestRecovered,
				"resolved_at": at,
				"resolved_by": by,
			}).Error; err != nil {
			return fmt.Errorf("close requests: %w", err)
		}
		recovered = ids
		return nil
	})
	return recovered, err
}

// DueDeletionBatches devuelve hasta limit lotes pendientes cuya fecha ya
// pasó, los más viejos primero.
func (r *UserRepository) DueDeletionBatches(now time.Time, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	var batches []string
	err := r.db.Model(&models.AccountDeletionRequest{}).
		Select("batch_id").
		Where("status = ? AND scheduled_for <= ?", models.DeletionRequestPending, now).
		Group("batch_id").
		Order("MIN(scheduled_for) ASC").
		Limit(limit).
		Pluck("batch_id", &batches).Error
	return batches, err
}

// ExecuteScheduledDeletion hace el borrado definitivo de un lote vencido en
// una sola transacción: bloquea las peticiones, comprueba que siguen
// pendientes y vencidas, escribe account_deletions, borra las filas del
// usuario (lo mismo que el borrado de siempre) y cierra las peticiones.
// records tiene que traer una fila por cada cuenta de userIDs.
func (r *UserRepository) ExecuteScheduledDeletion(batchID string, userIDs []uint64, records []models.AccountDeletion, now time.Time) error {
	if len(records) == 0 || len(records) != len(userIDs) {
		return errors.New("refusing to delete without one deletion record per account")
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		var rows []models.AccountDeletionRequest
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("batch_id = ? AND user_id IN ? AND status = ? AND scheduled_for <= ?",
				batchID, userIDs, models.DeletionRequestPending, now).
			Find(&rows).Error; err != nil {
			return err
		}
		if len(rows) != len(userIDs) {
			return ErrDeletionNotDue
		}
		// La cuenta tiene que seguir desactivada: si alguien la recuperó por
		// otro camino, no se borra.
		var stillDeactivated int64
		if err := tx.Model(&models.User{}).Where("id IN ? AND deactivated_at IS NOT NULL", userIDs).
			Count(&stillDeactivated).Error; err != nil {
			return err
		}
		if int(stillDeactivated) != len(userIDs) {
			return ErrDeletionNotDue
		}
		if err := tx.Create(&records).Error; err != nil {
			return fmt.Errorf("write account_deletions: %w", err)
		}
		for _, uid := range userIDs {
			if err := r.DeleteUserRecord(tx, uid); err != nil {
				return fmt.Errorf("user record (user %d): %w", uid, err)
			}
		}
		ids := make([]uint64, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.ID)
		}
		return tx.Model(&models.AccountDeletionRequest{}).Where("id IN ?", ids).
			Updates(map[string]interface{}{
				"status":      models.DeletionRequestExecuted,
				"resolved_at": now,
				"resolved_by": records[0].PerformedBy,
			}).Error
	})
}

// CloseOrphanRequests cierra las peticiones pendientes de un lote cuyas
// cuentas ya no existen (borradas por otro camino sin pasar por
// PurgeAllUserData). Evita que el barrido las intente cada hora.
func (r *UserRepository) CloseOrphanRequests(batchID string, at time.Time) (int64, error) {
	res := r.db.Model(&models.AccountDeletionRequest{}).
		Where("batch_id = ? AND status = ? AND user_id NOT IN (?)", batchID, models.DeletionRequestPending,
			r.db.Model(&models.User{}).Select("id")).
		Updates(map[string]interface{}{
			"status":      models.DeletionRequestSuperseded,
			"resolved_at": at,
			"resolved_by": "user-service: la cuenta ya no existía al vencer",
		})
	return res.RowsAffected, res.Error
}

// PendingDeletionRow es una cuenta en gracia para el panel.
type PendingDeletionRow struct {
	models.AccountDeletionRequest
	DisplayName      string  `json:"displayName"`
	Email            *string `json:"email,omitempty"`
	Role             string  `json:"role"`
	IsManagedAccount bool    `json:"isManagedAccount"`
	RepresentativeID *uint64 `json:"representativeId,omitempty"`
}

// ListPendingDeletions devuelve las cuentas en gracia, la que se borra antes
// primero.
func (r *UserRepository) ListPendingDeletions(limit, offset int) ([]PendingDeletionRow, int64, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	q := r.db.Model(&models.AccountDeletionRequest{}).
		Where("account_deletion_requests.status = ?", models.DeletionRequestPending)
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []PendingDeletionRow
	err := q.Select("account_deletion_requests.*, users.display_name, users.email, users.role, users.is_managed_account, users.representative_id").
		Joins("LEFT JOIN users ON users.id = account_deletion_requests.user_id").
		Order("account_deletion_requests.scheduled_for ASC, account_deletion_requests.id ASC").
		Limit(limit).Offset(offset).
		Scan(&rows).Error
	return rows, total, err
}
