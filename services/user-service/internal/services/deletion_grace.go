package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

// Borrado con 30 días de gracia (pedido del cliente el 28 oct 2026, "como en
// Snapchat"). Pedir el borrado desde la app ya no borra: desactiva la cuenta
// y programa el borrado definitivo, que hace el barrido de este mismo
// servicio (RunDeletionSweep) con el mismo borrado y el mismo registro en
// account_deletions de siempre. El borrado inmediato del operador no cambia.

// ScheduledDeletionPerformer es quien firma el borrado definitivo en
// account_deletions.performed_by.
const ScheduledDeletionPerformer = "user-service: borrado programado al vencer la gracia"

// ErrAccountPendingDeletion lo devuelven el login, el refresh, /auth/me y el
// cambio de cuenta cuando la cuenta está en gracia. El handler lo traduce a
// 403 con la fecha y un token de recuperación.
type ErrAccountPendingDeletion struct {
	UserID              uint64
	Username            string
	ScheduledDeletionAt time.Time
	// RecoveryToken solo lo lleva el error del login: es la prueba de que
	// la persona acaba de identificarse.
	RecoveryToken string
	// AlsoRecovers son las cuentas vinculadas que vuelven con esta (solo
	// si esta pidió el borrado de las vinculadas).
	AlsoRecovers []string
}

// AccountPendingDeletionCode es el texto de error estable que lee la app.
const AccountPendingDeletionCode = "account_pending_deletion"

func (e *ErrAccountPendingDeletion) Error() string { return AccountPendingDeletionCode }

// IsAccountPendingDeletion dice si err es la cuenta en gracia.
func IsAccountPendingDeletion(err error) (*ErrAccountPendingDeletion, bool) {
	var e *ErrAccountPendingDeletion
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// DeletionGraceConfig son los tiempos del borrado con gracia.
type DeletionGraceConfig struct {
	Grace time.Duration
	// Now es el reloj; las pruebas lo fijan.
	Now func() time.Time
}

func (c DeletionGraceConfig) grace() time.Duration {
	if c.Grace <= 0 {
		return models.DefaultDeletionGrace
	}
	return c.Grace
}

func (c DeletionGraceConfig) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

// SetDeletionGrace cambia la gracia o el reloj (main la lee del entorno, las
// pruebas fijan el reloj).
func (s *UserService) SetDeletionGrace(cfg DeletionGraceConfig) { s.grace = cfg }

// BuildGraceRequests convierte una petición de borrado en una fila por
// cuenta, todas con la misma fecha. Pura, para probar las reglas sin base.
func BuildGraceRequests(
	batchID string,
	target *models.User,
	extra []*models.User,
	meta DeletionMeta,
	deleteLinked bool,
	locale string,
	now time.Time,
	grace time.Duration,
) []models.AccountDeletionRequest {
	if target == nil {
		return nil
	}
	scheduled := now.Add(grace)
	row := func(u *models.User, asLinked bool) models.AccountDeletionRequest {
		return models.AccountDeletionRequest{
			BatchID:          batchID,
			UserID:           u.ID,
			Username:         u.Username,
			IncludedAsLinked: asLinked,
			DeleteLinked:     !asLinked && deleteLinked,
			Via:              meta.Via,
			RequestedBy:      clip(meta.RequestedBy, 200),
			PerformedBy:      clip(meta.PerformedBy, 200),
			Reason:           clip(meta.Reason, 1000),
			ActorUserID:      meta.ActorUserID,
			ClientIP:         clip(meta.ClientIP, 64),
			UserAgent:        clip(meta.UserAgent, 300),
			Locale:           clip(locale, 10),
			Status:           models.DeletionRequestPending,
			RequestedAt:      now,
			ScheduledFor:     scheduled,
		}
	}
	out := []models.AccountDeletionRequest{row(target, false)}
	for _, u := range extra {
		// Una vinculada que ya está en gracia conserva su propia fecha.
		if u == nil || u.ID == target.ID || u.IsDeactivated() {
			continue
		}
		out = append(out, row(u, true))
	}
	return out
}

// ScheduledDeletionMeta es el DeletionMeta del borrado definitivo: quién lo
// pidió sale de la petición, y lo firma el barrido.
func ScheduledDeletionMeta(root models.AccountDeletionRequest) DeletionMeta {
	return DeletionMeta{
		Via:         root.Via,
		RequestedBy: root.RequestedBy,
		PerformedBy: ScheduledDeletionPerformer,
		Reason:      root.Reason,
		ActorUserID: root.ActorUserID,
		ClientIP:    root.ClientIP,
		UserAgent:   root.UserAgent,
	}
}

// RecoveryScope decide qué cuentas vuelven al recuperar userID: la que pidió
// el borrado trae de vuelta todo su lote; una vinculada que entró con la
// petición de otra vuelve sola (la otra quiso borrarse a sí misma).
func RecoveryScope(userID uint64, batch []models.AccountDeletionRequest) []uint64 {
	var mine *models.AccountDeletionRequest
	for i := range batch {
		if batch[i].UserID == userID {
			mine = &batch[i]
			break
		}
	}
	if mine == nil {
		return nil
	}
	if mine.IncludedAsLinked {
		return []uint64{userID}
	}
	out := make([]uint64, 0, len(batch))
	for _, r := range batch {
		out = append(out, r.UserID)
	}
	return out
}

// GraceDeletionResult es lo que la app enseña al pedir el borrado.
type GraceDeletionResult struct {
	BatchID             string    `json:"batchId"`
	ScheduledDeletionAt time.Time `json:"scheduledDeletionAt"`
	UserIDs             []uint64  `json:"userIds"`
	// AlreadyPending: la cuenta ya estaba en gracia; se devuelve su fecha.
	AlreadyPending bool `json:"alreadyPending"`
}

// RequestDeletion desactiva la cuenta (y sus vinculadas si deleteLinked) y
// programa el borrado definitivo para dentro de la gracia.
func (s *UserService) RequestDeletion(ctx context.Context, userID uint64, deleteLinked bool, meta DeletionMeta, locale string) (*GraceDeletionResult, error) {
	if err := meta.Validate(); err != nil {
		return nil, err
	}
	user, err := s.repo.FindByID(userID)
	if err != nil || user == nil {
		return nil, errors.New("user not found")
	}
	if user.IsDeactivated() {
		res := &GraceDeletionResult{AlreadyPending: true, UserIDs: []uint64{userID}}
		if user.ScheduledDeletionAt != nil {
			res.ScheduledDeletionAt = user.ScheduledDeletionAt.UTC()
		}
		if req, _ := s.repo.FindPendingRequest(userID); req != nil {
			res.BatchID = req.BatchID
		}
		return res, nil
	}

	var extra []*models.User
	if deleteLinked {
		linked, lerr := s.repo.GetLinkedAccounts(userID, user.IsManagedAccount, user.RepresentativeID)
		if lerr != nil {
			return nil, fmt.Errorf("could not read linked accounts: %w", lerr)
		}
		extra = linked
	}

	now := s.grace.now()
	batchID := uuid.NewString()
	reqs := BuildGraceRequests(batchID, user, extra, meta, deleteLinked, locale, now, s.grace.grace())
	if err := s.repo.DeactivateForDeletion(reqs); err != nil {
		log.Printf("[USER] deactivate for deletion failed for %d: %v", userID, err)
		return nil, fmt.Errorf("delete account failed: %w", err)
	}

	ids := make([]uint64, 0, len(reqs))
	usernames := make([]string, 0, len(reqs))
	for _, r := range reqs {
		ids = append(ids, r.UserID)
		usernames = append(usernames, r.Username)
	}
	scheduled := reqs[0].ScheduledFor
	log.Printf("[USER] Deactivated %v for deletion on %s via=%s requestedBy=%q batch=%s",
		ids, scheduled.Format(time.RFC3339), meta.Via, meta.RequestedBy, batchID)

	go captureGraceEvent("account_deletion_scheduled", reqs, nil)
	s.publish("user.deactivated", strconv.FormatUint(userID, 10), map[string]interface{}{
		"userIds":             idStrings(ids),
		"usernames":           usernames,
		"batchId":             batchID,
		"via":                 meta.Via,
		"requestedAt":         now.Format(time.RFC3339),
		"scheduledDeletionAt": scheduled.Format(time.RFC3339),
		// Para el correo de confirmación (email-service). Solo la cuenta que
		// lo pidió, y nunca las direcciones internas de los creators.
		"email":    notifiableEmail(user),
		"username": user.Username,
		"locale":   locale,
	})

	return &GraceDeletionResult{BatchID: batchID, ScheduledDeletionAt: scheduled, UserIDs: ids}, nil
}

// PendingDeletionFor devuelve el error de cuenta en gracia para un usuario
// desactivado (con las vinculadas que volverían), o nil si está activo.
func (s *UserService) PendingDeletionFor(user *models.User) *ErrAccountPendingDeletion {
	if !user.IsDeactivated() {
		return nil
	}
	e := &ErrAccountPendingDeletion{UserID: user.ID, Username: user.Username}
	if user.ScheduledDeletionAt != nil {
		e.ScheduledDeletionAt = user.ScheduledDeletionAt.UTC()
	}
	if req, err := s.repo.FindPendingRequest(user.ID); err == nil && req != nil {
		if batch, berr := s.repo.PendingRequestsInBatch(req.BatchID); berr == nil {
			for _, id := range RecoveryScope(user.ID, batch) {
				if id == user.ID {
					continue
				}
				for _, r := range batch {
					if r.UserID == id {
						e.AlsoRecovers = append(e.AlsoRecovers, r.Username)
					}
				}
			}
		}
	}
	return e
}

// RecoverAccount reactiva la cuenta (y su lote si fue ella quien lo pidió).
func (s *UserService) RecoverAccount(ctx context.Context, userID uint64, by string) (*models.User, []uint64, error) {
	req, err := s.repo.FindPendingRequest(userID)
	if err != nil {
		return nil, nil, fmt.Errorf("could not read deletion request: %w", err)
	}
	if req == nil {
		return nil, nil, repositories.ErrNoPendingDeletion
	}
	batch, err := s.repo.PendingRequestsInBatch(req.BatchID)
	if err != nil {
		return nil, nil, err
	}
	scope := RecoveryScope(userID, batch)
	now := s.grace.now()
	recovered, err := s.repo.RecoverAccounts(req.BatchID, scope, by, now)
	if err != nil {
		return nil, nil, err
	}
	user, err := s.repo.FindByID(userID)
	if err != nil || user == nil {
		return nil, nil, errors.New("user not found")
	}
	log.Printf("[USER] Recovered %v from deletion batch %s by %q", recovered, req.BatchID, by)

	var closed []models.AccountDeletionRequest
	for _, r := range batch {
		for _, id := range recovered {
			if r.UserID == id {
				closed = append(closed, r)
			}
		}
	}
	go captureGraceEvent("account_deletion_recovered", closed, map[string]interface{}{
		"days_before_deletion": int(req.ScheduledFor.Sub(now).Hours() / 24),
		"hours_in_grace":       int(now.Sub(req.RequestedAt).Hours()),
	})
	s.publish("user.reactivated", strconv.FormatUint(userID, 10), map[string]interface{}{
		"userIds":  idStrings(recovered),
		"batchId":  req.BatchID,
		"email":    notifiableEmail(user),
		"username": user.Username,
		"locale":   req.Locale,
	})
	return user, recovered, nil
}

// SweepResult cuenta lo que hizo una pasada del barrido.
type SweepResult struct {
	Executed []string
	Skipped  int
	Failed   int
}

// RunDeletionSweep borra de verdad los lotes vencidos. Lo llama main cada
// hora; es seguro con varias réplicas (cada lote se borra en una transacción
// con sus peticiones bloqueadas) y si un lote falla se reintenta en la
// siguiente pasada.
func (s *UserService) RunDeletionSweep(ctx context.Context, limit int) SweepResult {
	var res SweepResult
	now := s.grace.now()
	batches, err := s.repo.DueDeletionBatches(now, limit)
	if err != nil {
		log.Printf("[DELETION-SWEEP] could not list due batches: %v", err)
		res.Failed++
		return res
	}
	for _, batchID := range batches {
		if ctx.Err() != nil {
			return res
		}
		switch err := s.executeBatch(batchID, now); {
		case err == nil:
			res.Executed = append(res.Executed, batchID)
		case errors.Is(err, repositories.ErrDeletionNotDue):
			res.Skipped++
		default:
			res.Failed++
			log.Printf("[DELETION-SWEEP] batch %s failed: %v", batchID, err)
		}
	}
	return res
}

func (s *UserService) executeBatch(batchID string, now time.Time) error {
	reqs, err := s.repo.PendingRequestsInBatch(batchID)
	if err != nil {
		return err
	}
	if len(reqs) == 0 {
		return repositories.ErrDeletionNotDue
	}
	byUser := make(map[uint64]models.AccountDeletionRequest, len(reqs))
	ids := make([]uint64, 0, len(reqs))
	for _, r := range reqs {
		byUser[r.UserID] = r
		ids = append(ids, r.UserID)
	}
	users, err := s.repo.FindByIDsIncludingDeactivated(ids)
	if err != nil {
		return err
	}
	if len(users) != len(ids) {
		// Alguna cuenta ya no existe: se cierra su petición y el resto se
		// intenta en la siguiente pasada.
		n, cerr := s.repo.CloseOrphanRequests(batchID, now)
		if cerr != nil {
			return cerr
		}
		log.Printf("[DELETION-SWEEP] batch %s: closed %d requests of accounts that no longer exist", batchID, n)
		return repositories.ErrDeletionNotDue
	}

	// La cuenta raíz es la que pidió el borrado; si ya no está en el lote
	// (se recuperó sola una vinculada, o al revés), la primera que quede.
	var root *models.User
	rootReq := reqs[0]
	for i := range users {
		if r := byUser[users[i].ID]; !r.IncludedAsLinked {
			root = &users[i]
			rootReq = r
		}
	}
	if root == nil {
		root = &users[0]
		rootReq = byUser[root.ID]
	}
	var extra []*models.User
	for i := range users {
		if users[i].ID != root.ID {
			extra = append(extra, &users[i])
		}
	}
	linked, _ := s.repo.GetLinkedAccounts(root.ID, root.IsManagedAccount, root.RepresentativeID)

	records := BuildDeletionRecords(batchID, root, extra, linked, ScheduledDeletionMeta(rootReq), now)
	for i := range records {
		r := byUser[records[i].DeletedUserID]
		requestedAt := r.RequestedAt
		reqID := r.ID
		records[i].RequestedAt = &requestedAt
		records[i].GraceRequestID = &reqID
	}
	deleteIDs := make([]uint64, 0, len(records))
	for _, r := range records {
		deleteIDs = append(deleteIDs, r.DeletedUserID)
	}
	if err := s.repo.ExecuteScheduledDeletion(batchID, deleteIDs, records, now); err != nil {
		return err
	}
	log.Printf("[DELETION-SWEEP] Deleted %v (batch %s, requested %s by %q)",
		deleteIDs, batchID, rootReq.RequestedAt.Format(time.RFC3339), rootReq.RequestedBy)
	go captureDeletions(records)
	s.publish("user.deleted", strconv.FormatUint(deleteIDs[0], 10), map[string]interface{}{
		"userIds": idStrings(deleteIDs),
		"batchId": batchID,
		"via":     rootReq.Via,
	})
	return nil
}

// ListPendingDeletions sirve la lista del panel.
func (s *UserService) ListPendingDeletions(limit, offset int) (*PendingDeletionList, error) {
	rows, total, err := s.repo.ListPendingDeletions(limit, offset)
	if err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []repositories.PendingDeletionRow{}
	}
	return &PendingDeletionList{Accounts: rows, Total: total}, nil
}

// PendingDeletionList es una página de cuentas en gracia.
type PendingDeletionList struct {
	Accounts []repositories.PendingDeletionRow `json:"accounts"`
	Total    int64                             `json:"total"`
}

// notifiableEmail devuelve el correo al que se puede escribir, o "" para las
// direcciones internas de los creators gestionados.
func notifiableEmail(u *models.User) string {
	if u == nil || u.Email == nil {
		return ""
	}
	e := strings.TrimSpace(*u.Email)
	if e == "" || strings.HasSuffix(strings.ToLower(e), "@managed.atto") || !strings.Contains(e, "@") {
		return ""
	}
	return e
}

func idStrings(ids []uint64) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = strconv.FormatUint(id, 10)
	}
	return out
}

// publish manda un evento a Kafka sin bloquear la respuesta.
func (s *UserService) publish(topic, key string, data map[string]interface{}) {
	if s.producer == nil {
		return
	}
	go func() {
		if err := s.producer.Publish(context.Background(), topic, key, data); err != nil {
			log.Printf("[USER] Failed to publish %s: %v", topic, err)
		}
	}()
}
