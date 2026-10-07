//go:build integration

package services

// La lista de operador contra un Postgres de usar y tirar y un servicio social
// de mentira. Mismo arranque que deletion_integration_test.go:
//   USER_SERVICE_TEST_DSN="host=127.0.0.1 port=55433 user=postgres dbname=atto_users_test sslmode=disable" \
//     go test -tags integration ./internal/services -run Integration

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/atto-sound/user-service/internal/kafka"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/repositories"
)

func TestIntegrationAdminListShowsLiveStats(t *testing.T) {
	db := integrationDB(t)
	r, c := seed(t, db)
	// Lo guardado en users: ceros para una, números viejos para la otra.
	if err := db.Model(&models.User{}).Where("id = ?", c.ID).
		Updates(map[string]any{"followers_count": 5, "posts_count": 7}).Error; err != nil {
		t.Fatal(err)
	}

	var hits atomic.Int64
	social := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hits.Add(1)
		if req.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "Missing authentication", http.StatusUnauthorized)
			return
		}
		switch req.URL.Path {
		case fmt.Sprintf("/api/v1/users/%d/stats", r.ID):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{"followersCount":17,"followingCount":3,"postsCount":48},"error":null}`))
		default:
			// La otra cuenta falla: tiene que quedarse con lo guardado.
			http.Error(w, "boom", http.StatusInternalServerError)
		}
	}))
	defer social.Close()

	svc := NewUserService(repositories.NewUserRepository(db), kafka.NewProducer("127.0.0.1:1"))
	byID := func(list *AdminUserList) map[uint64]AdminUserRow {
		t.Helper()
		if list.Total != 2 || len(list.Users) != 2 {
			t.Fatalf("esperaba las dos cuentas, total %d y %d filas", list.Total, len(list.Users))
		}
		out := map[uint64]AdminUserRow{}
		for _, row := range list.Users {
			out[row.ID] = row
		}
		return out
	}

	// Sin servicio social: lo de siempre, y no sale ninguna petición.
	list, err := svc.ListUsersForAdmin(context.Background(), repositories.AdminUserFilter{})
	if err != nil {
		t.Fatal(err)
	}
	rows := byID(list)
	if got := rows[r.ID]; got.FollowersCount != 0 || got.PostsCount != 0 || got.StatsLive {
		t.Fatalf("sin servicio social esperaba lo guardado: %+v", got)
	}
	if got := rows[c.ID]; got.FollowersCount != 5 || got.PostsCount != 7 || got.StatsLive {
		t.Fatalf("sin servicio social esperaba lo guardado: %+v", got)
	}
	if hits.Load() != 0 {
		t.Fatalf("sin servicio social no debía salir ninguna petición, salieron %d", hits.Load())
	}

	// Con servicio social: la que responde trae los reales, la que falla no.
	svc.SetSocialStats(NewSocialStatsClient(social.URL, func() (string, error) { return "tok", nil }))
	list, err = svc.ListUsersForAdmin(context.Background(), repositories.AdminUserFilter{})
	if err != nil {
		t.Fatal(err)
	}
	rows = byID(list)
	if got := rows[r.ID]; got.FollowersCount != 17 || got.PostsCount != 48 || !got.StatsLive {
		t.Fatalf("esperaba 17 seguidores y 48 publicaciones reales: %+v", got)
	}
	if got := rows[c.ID]; got.FollowersCount != 5 || got.PostsCount != 7 || got.StatsLive {
		t.Fatalf("la cuenta que falló conserva lo guardado: %+v", got)
	}
	if got := rows[r.ID]; got.Username != "arami" || got.Role != string(models.RoleRepresentative) {
		t.Fatalf("el resto de la fila no cambia: %+v", got)
	}
	if hits.Load() != 2 {
		t.Fatalf("una petición por fila de la página, salieron %d", hits.Load())
	}

	// La columna guardada no se toca: la lista solo pisa la respuesta.
	var stored models.User
	if err := db.First(&stored, r.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.FollowersCount != 0 || stored.PostsCount != 0 {
		t.Fatalf("la lista no escribe en users: %+v", stored)
	}
}
