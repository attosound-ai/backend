//go:build integration

package services

// El flujo completo del borrado con 30 días de gracia contra un Postgres
// desechable (mismo arranque que deletion_integration_test.go):
//   USER_SERVICE_TEST_DSN="host=127.0.0.1 port=55471 user=postgres dbname=atto_users_test sslmode=disable" \
//     go test -tags integration ./internal/services -run IntegrationGrace

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/atto-sound/user-service/internal/config"
	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

// clock es un reloj que la prueba adelanta.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) set(t time.Time) { c.mu.Lock(); c.t = t.UTC(); c.mu.Unlock() }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type graceRig struct {
	db    *gorm.DB
	users *UserService
	auth  *AuthService
	jwt   *middleware.JWTManager
	clock *clock
}

func newGraceRig(t *testing.T) *graceRig {
	db := integrationDB(t)
	db.Exec("TRUNCATE user_credentials, push_tokens")
	repo := repositories.NewUserRepository(db)
	producer := kafka.NewProducer("127.0.0.1:1")
	c := &clock{t: time.Now().UTC()}
	users := NewUserService(repo, producer)
	users.SetDeletionGrace(DeletionGraceConfig{Grace: models.DefaultDeletionGrace, Now: c.now})
	jwtMgr := middleware.NewJWTManager(&config.Config{JWTSecret: "test-secret", JWTAccessExpiry: 15 * time.Minute, JWTRefreshExpiry: 168 * time.Hour})
	auth := NewAuthService(repo, jwtMgr, producer, "http://127.0.0.1:1")
	auth.SetAccounts(users)
	return &graceRig{db: db, users: users, auth: auth, jwt: jwtMgr, clock: c}
}

// seedWithPassword crea arami (representante) y aramis (su creator), con
// contraseña y un push token cada una.
func (g *graceRig) seedWithPassword(t *testing.T) (*models.User, *models.User) {
	r, c := seed(t, g.db)
	hash, _ := bcrypt.GenerateFromPassword([]byte("contrasena-larga"), bcrypt.MinCost)
	for _, u := range []*models.User{r, c} {
		g.db.Create(&models.UserCredentials{UserID: u.ID, PasswordHash: string(hash)})
		g.db.Create(&models.PushToken{UserID: u.ID, Token: "ExponentPushToken[" + u.Username + "]", DeviceID: "d", Platform: "ios", IsActive: true})
	}
	return r, c
}

func selfDelete(u *models.User) DeletionMeta {
	return DeletionMeta{Via: models.DeletionViaSelfService, RequestedBy: u.Username + ", from the app with an OTP",
		PerformedBy: u.Username, Reason: "probando", ActorUserID: &u.ID}
}

func (g *graceRig) reload(t *testing.T, id uint64) *models.User {
	var u models.User
	if err := g.db.First(&u, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		t.Fatal(err)
	}
	return &u
}

func (g *graceRig) login(username string) (interface{}, error) {
	return g.auth.Login(context.Background(), &models.LoginRequest{Identifier: username, Password: "contrasena-larga"})
}

func (g *graceRig) activePushTokens(id uint64) int {
	toks, _ := g.users.GetActivePushTokens(id)
	return len(toks)
}

// Pedir: la cuenta queda oculta, sin sesiones ni pushes, con fecha a 30 días.
// Volver a entrar: el login no da sesión, da la fecha y un token de
// recuperar. Recuperar: todo vuelve, salvo las sesiones viejas.
func TestIntegrationGraceRequestThenRecover(t *testing.T) {
	g := newGraceRig(t)
	r, c := g.seedWithPassword(t)
	ctx := context.Background()

	before, err := g.login("arami")
	if err != nil {
		t.Fatal(err)
	}
	oldRefresh := before.(*models.AuthResponse).Tokens.RefreshToken

	// Los tokens llevan iat en segundos enteros y del reloj de verdad: el
	// pedido cae un segundo después del token viejo, y la sesión nueva un
	// segundo después del pedido, para que la prueba sea honesta.
	time.Sleep(1100 * time.Millisecond)
	g.clock.set(time.Now())
	requestedAt := g.clock.now()
	res, err := g.users.RequestDeletion(ctx, r.ID, false, selfDelete(r), "es")
	if err != nil {
		t.Fatal(err)
	}
	if want := requestedAt.Add(30 * 24 * time.Hour); !res.ScheduledDeletionAt.Equal(want) || res.AlreadyPending {
		t.Fatalf("scheduled %v, want %v (%+v)", res.ScheduledDeletionAt, want, res)
	}

	got := g.reload(t, r.ID)
	if got == nil || !got.IsDeactivated() || got.ScheduledDeletionAt == nil || got.SessionsValidAfter == nil {
		t.Fatalf("account not deactivated: %+v", got)
	}
	if g.reload(t, c.ID).IsDeactivated() {
		t.Fatal("the creator was deactivated although deleteLinked was false")
	}

	// Nadie la ve.
	if _, err := g.users.GetUserByID(ctx, "1"); err == nil || err.Error() != "user not found" {
		t.Fatalf("public profile still served: %v", err)
	}
	if found, _ := g.users.SearchUsers(ctx, "arami", 10); len(found) != 1 || found[0].Username != "aramis" {
		t.Fatalf("search must only find aramis: %+v", found)
	}
	if batch, _ := g.users.GetUsersByIDs(ctx, []string{"1", "2"}); len(batch) != 1 || batch[0].ID != c.ID {
		t.Fatalf("batch lookup must hide the deactivated account: %+v", batch)
	}
	// El operador sí.
	if p, err := g.users.GetUserForOperator(ctx, "1"); err != nil || p.Username != "arami" {
		t.Fatalf("operator lookup: %v", err)
	}
	// Pushes apagados, los de la vinculada no.
	if g.activePushTokens(r.ID) != 0 || g.activePushTokens(c.ID) != 1 {
		t.Fatalf("push tokens: rep %d (want 0), creator %d (want 1)", g.activePushTokens(r.ID), g.activePushTokens(c.ID))
	}
	// Sesiones cerradas en todos los dispositivos.
	if _, err := g.auth.RefreshToken(ctx, oldRefresh); err == nil {
		t.Fatal("old refresh token still works")
	}
	if _, err := g.auth.GetCurrentUser(ctx, "1"); err == nil || err.Error() != AccountPendingDeletionCode {
		t.Fatalf("/auth/me must refuse: %v", err)
	}
	// La creator ya no puede cambiar a la representante, ni la ve en el selector.
	if _, err := g.auth.SwitchAccount(ctx, "2", r.ID); err == nil || err.Error() != AccountPendingDeletionCode {
		t.Fatalf("switch into a pending account: %v", err)
	}
	if linked, _ := g.auth.GetLinkedAccounts(ctx, "2"); len(linked) != 0 {
		t.Fatalf("switcher still offers the pending account: %+v", linked)
	}
	// Telefonía: la creator ya no hace sonar a la representante.
	if ids, _ := g.users.GetLinkedAccountIDsForUser(c.ID); len(ids) != 1 || ids[0] != c.ID {
		t.Fatalf("fan out still rings the pending account: %v", ids)
	}
	if !g.users.IsDeactivated(r.ID) || g.users.IsDeactivated(c.ID) {
		t.Fatal("IsDeactivated wrong")
	}

	// Pedirlo otra vez no mueve la fecha.
	g.clock.add(time.Hour)
	again, err := g.users.RequestDeletion(ctx, r.ID, false, selfDelete(r), "es")
	if err != nil || !again.AlreadyPending || !again.ScheduledDeletionAt.Equal(res.ScheduledDeletionAt) {
		t.Fatalf("second request moved the date or failed: %+v %v", again, err)
	}

	// Vuelve a entrar: pantalla de recuperar.
	_, err = g.login("arami")
	pending, ok := IsAccountPendingDeletion(err)
	if !ok || pending.RecoveryToken == "" || !pending.ScheduledDeletionAt.Equal(res.ScheduledDeletionAt) || pending.Username != "arami" {
		t.Fatalf("login must answer pending deletion with a recovery token: %v %+v", err, pending)
	}
	// El token de recuperar no es una sesión.
	if claims, err := g.jwt.ValidateToken(pending.RecoveryToken); err != nil || claims.EffectiveScope() == middleware.ScopeUser {
		t.Fatalf("recovery token must not carry the user scope: %+v %v", claims, err)
	}
	if _, _, err := g.auth.RecoverAccount(ctx, before.(*models.AuthResponse).Tokens.AccessToken); err == nil {
		t.Fatal("an access token was accepted as a recovery token")
	}

	time.Sleep(1100 * time.Millisecond)
	session, ids, err := g.auth.RecoverAccount(ctx, pending.RecoveryToken)
	if err != nil || session == nil || session.Tokens == nil || len(ids) != 1 || ids[0] != r.ID {
		t.Fatalf("recover: %+v %v %v", session, ids, err)
	}
	got = g.reload(t, r.ID)
	if got.IsDeactivated() || got.ScheduledDeletionAt != nil {
		t.Fatalf("account still deactivated after recovery: %+v", got)
	}
	if _, err := g.users.GetUserByID(ctx, "1"); err != nil {
		t.Fatalf("profile hidden after recovery: %v", err)
	}
	// Los otros dispositivos siguen fuera; la sesión nueva funciona.
	if _, err := g.auth.RefreshToken(ctx, oldRefresh); err == nil {
		t.Fatal("old refresh token came back to life with the recovery")
	}
	if _, err := g.auth.RefreshToken(ctx, session.Tokens.RefreshToken); err != nil {
		t.Fatalf("new session cannot refresh: %v", err)
	}
	var req models.AccountDeletionRequest
	g.db.Where("user_id = ?", r.ID).First(&req)
	if req.Status != models.DeletionRequestRecovered || req.ResolvedAt == nil || req.ResolvedBy == "" {
		t.Fatalf("request not closed as recovered: %+v", req)
	}
	// Un segundo toque en Recuperar no rompe nada.
	if s2, _, err := g.auth.RecoverAccount(ctx, pending.RecoveryToken); err != nil || s2 == nil {
		t.Fatalf("second recover tap: %v", err)
	}
	// Nada se borró.
	var n int64
	g.db.Model(&models.AccountDeletion{}).Count(&n)
	if n != 0 {
		t.Fatalf("recovery wrote %d deletion records", n)
	}
}

// Vencer: el barrido no toca nada antes de la fecha y, después, hace el
// borrado de siempre y deja en account_deletions quién lo pidió y cuándo.
func TestIntegrationGraceExpiresAndSweepDeletes(t *testing.T) {
	g := newGraceRig(t)
	r, c := g.seedWithPassword(t)
	ctx := context.Background()
	requestedAt := g.clock.now()
	if _, err := g.users.RequestDeletion(ctx, r.ID, true, selfDelete(r), "en"); err != nil {
		t.Fatal(err)
	}
	if !g.reload(t, c.ID).IsDeactivated() {
		t.Fatal("deleteLinked did not deactivate the creator")
	}

	g.clock.add(29*24*time.Hour + 23*time.Hour)
	if res := g.users.RunDeletionSweep(ctx, 50); len(res.Executed) != 0 || res.Failed != 0 {
		t.Fatalf("swept before the date: %+v", res)
	}
	if g.reload(t, r.ID) == nil {
		t.Fatal("deleted before the date")
	}

	g.clock.add(2 * time.Hour)
	res := g.users.RunDeletionSweep(ctx, 50)
	if len(res.Executed) != 1 || res.Failed != 0 {
		t.Fatalf("sweep after the date: %+v", res)
	}
	if g.reload(t, r.ID) != nil || g.reload(t, c.ID) != nil {
		t.Fatal("accounts survived the sweep")
	}
	var creds int64
	g.db.Model(&models.UserCredentials{}).Where("user_id IN ?", []uint64{r.ID, c.ID}).Count(&creds)
	if creds != 0 {
		t.Fatal("credentials survived")
	}

	var rows []models.AccountDeletion
	g.db.Order("id").Find(&rows)
	if len(rows) != 2 {
		t.Fatalf("records = %d, want 2", len(rows))
	}
	root := rows[0]
	if root.DeletedUserID != r.ID || root.Via != models.DeletionViaSelfService || root.RequestedBy != "arami, from the app with an OTP" ||
		root.PerformedBy != ScheduledDeletionPerformer || root.Reason != "probando" || root.RequestedAt == nil ||
		!root.RequestedAt.Equal(requestedAt) || root.GraceRequestID == nil || root.Email == nil || root.ActorUserID == nil {
		t.Fatalf("root record wrong: %+v", root)
	}
	if !rows[1].IncludedAsLinked || rows[1].DeletedUserID != c.ID || rows[1].BatchID != root.BatchID {
		t.Fatalf("linked record wrong: %+v", rows[1])
	}
	var reqs []models.AccountDeletionRequest
	g.db.Find(&reqs)
	for _, q := range reqs {
		if q.Status != models.DeletionRequestExecuted || q.ResolvedAt == nil {
			t.Fatalf("request not closed as executed: %+v", q)
		}
	}
	// Una segunda pasada no hace nada.
	if res := g.users.RunDeletionSweep(ctx, 50); len(res.Executed) != 0 || res.Failed != 0 {
		t.Fatalf("second sweep: %+v", res)
	}
}

// Dos réplicas barriendo a la vez borran el lote una sola vez.
func TestIntegrationGraceConcurrentSweepsDeleteOnce(t *testing.T) {
	g := newGraceRig(t)
	r, _ := g.seedWithPassword(t)
	ctx := context.Background()
	if _, err := g.users.RequestDeletion(ctx, r.ID, false, selfDelete(r), "en"); err != nil {
		t.Fatal(err)
	}
	g.clock.add(31 * 24 * time.Hour)
	var wg sync.WaitGroup
	results := make([]SweepResult, 4)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = g.users.RunDeletionSweep(ctx, 50)
		}(i)
	}
	wg.Wait()
	executed := 0
	for _, res := range results {
		executed += len(res.Executed)
		if res.Failed != 0 {
			t.Fatalf("a sweep failed: %+v", results)
		}
	}
	var n int64
	g.db.Model(&models.AccountDeletion{}).Count(&n)
	if executed != 1 || n != 1 {
		t.Fatalf("executed %d times, %d records; want 1 and 1", executed, n)
	}
}

// Recuperar la cuenta que pidió el borrado trae de vuelta su lote; una
// vinculada que entró con ella vuelve sola.
func TestIntegrationGraceRecoveryScope(t *testing.T) {
	g := newGraceRig(t)
	r, c := g.seedWithPassword(t)
	ctx := context.Background()
	if _, err := g.users.RequestDeletion(ctx, r.ID, true, selfDelete(r), "es"); err != nil {
		t.Fatal(err)
	}
	// La creator entra por su cuenta y recupera solo la suya.
	_, err := g.login("aramis")
	pending, ok := IsAccountPendingDeletion(err)
	if !ok || len(pending.AlsoRecovers) != 0 {
		t.Fatalf("creator login: %v %+v", err, pending)
	}
	if _, ids, err := g.auth.RecoverAccount(ctx, pending.RecoveryToken); err != nil || len(ids) != 1 || ids[0] != c.ID {
		t.Fatalf("creator recover: %v %v", ids, err)
	}
	if !g.reload(t, r.ID).IsDeactivated() || g.reload(t, c.ID).IsDeactivated() {
		t.Fatal("recovering the creator must not bring the representative back")
	}
	// Al vencer se borra solo la representante y queda la creator huérfana
	// apuntada en el registro.
	g.clock.add(31 * 24 * time.Hour)
	if res := g.users.RunDeletionSweep(ctx, 50); len(res.Executed) != 1 {
		t.Fatalf("sweep: %+v", res)
	}
	if g.reload(t, r.ID) != nil || g.reload(t, c.ID) == nil {
		t.Fatal("wrong account deleted")
	}
	var rec models.AccountDeletion
	g.db.First(&rec)
	if rec.DeletedUserID != r.ID || rec.OrphanedCreatorIDs == "" {
		t.Fatalf("record must name the orphaned creator: %+v", rec)
	}

	// Otro lote: la representante recupera y vuelven las dos.
	g2 := newGraceRig(t)
	r2, c2 := g2.seedWithPassword(t)
	if _, err := g2.users.RequestDeletion(ctx, r2.ID, true, selfDelete(r2), "es"); err != nil {
		t.Fatal(err)
	}
	_, err = g2.login("arami")
	pending, ok = IsAccountPendingDeletion(err)
	if !ok || len(pending.AlsoRecovers) != 1 || pending.AlsoRecovers[0] != "aramis" {
		t.Fatalf("rep login must say aramis comes back too: %+v", pending)
	}
	if _, ids, err := g2.auth.RecoverAccount(ctx, pending.RecoveryToken); err != nil || len(ids) != 2 {
		t.Fatalf("rep recover: %v %v", ids, err)
	}
	if g2.reload(t, r2.ID).IsDeactivated() || g2.reload(t, c2.ID).IsDeactivated() {
		t.Fatal("rep recovery left an account deactivated")
	}
}

// El borrado inmediato del operador sigue funcionando sobre una cuenta en
// gracia y cierra su petición: el barrido no vuelve a buscarla.
func TestIntegrationGraceOperatorDeleteSupersedes(t *testing.T) {
	g := newGraceRig(t)
	r, _ := g.seedWithPassword(t)
	ctx := context.Background()
	if _, err := g.users.RequestDeletion(ctx, r.ID, false, selfDelete(r), "es"); err != nil {
		t.Fatal(err)
	}
	list, err := g.users.ListPendingDeletions(50, 0)
	if err != nil || list.Total != 1 || list.Accounts[0].UserID != r.ID || list.Accounts[0].Role != "representative" {
		t.Fatalf("panel list: %+v %v", list, err)
	}
	op := DeletionMeta{Via: models.DeletionViaOperator, RequestedBy: "client by WhatsApp", PerformedBy: "David", Reason: "soporte"}
	if err := g.users.DeleteAccount(ctx, r.ID, false, op); err != nil {
		t.Fatal(err)
	}
	var req models.AccountDeletionRequest
	g.db.First(&req)
	if req.Status != models.DeletionRequestSuperseded || req.ResolvedBy != "David" {
		t.Fatalf("request not superseded: %+v", req)
	}
	g.clock.add(31 * 24 * time.Hour)
	if res := g.users.RunDeletionSweep(ctx, 50); len(res.Executed) != 0 || res.Failed != 0 {
		t.Fatalf("sweep touched an operator deleted account: %+v", res)
	}
	var n int64
	g.db.Model(&models.AccountDeletion{}).Count(&n)
	if n != 1 {
		t.Fatalf("records = %d, want only the operator's", n)
	}
	if list, _ := g.users.ListPendingDeletions(50, 0); list.Total != 0 {
		t.Fatalf("panel still lists it: %+v", list)
	}
}

// Recuperar y vencer a la vez: gana uno y el otro no hace nada.
func TestIntegrationGraceRecoverRacesSweep(t *testing.T) {
	g := newGraceRig(t)
	r, _ := g.seedWithPassword(t)
	ctx := context.Background()
	if _, err := g.users.RequestDeletion(ctx, r.ID, false, selfDelete(r), "es"); err != nil {
		t.Fatal(err)
	}
	_, err := g.login("arami")
	pending, _ := IsAccountPendingDeletion(err)
	g.clock.add(31 * 24 * time.Hour)

	var wg sync.WaitGroup
	var recoverErr error
	var sweep SweepResult
	wg.Add(2)
	go func() { defer wg.Done(); _, _, recoverErr = g.auth.RecoverAccount(ctx, pending.RecoveryToken) }()
	go func() { defer wg.Done(); sweep = g.users.RunDeletionSweep(ctx, 50) }()
	wg.Wait()

	alive := g.reload(t, r.ID)
	var n int64
	g.db.Model(&models.AccountDeletion{}).Count(&n)
	switch {
	case recoverErr == nil:
		if alive == nil || alive.IsDeactivated() || n != 0 || len(sweep.Executed) != 0 {
			t.Fatalf("recover won but state is mixed: alive=%v records=%d sweep=%+v", alive, n, sweep)
		}
	default:
		if alive != nil || n != 1 || len(sweep.Executed) != 1 {
			t.Fatalf("sweep won but state is mixed: alive=%v records=%d sweep=%+v err=%v", alive, n, sweep, recoverErr)
		}
	}
}
