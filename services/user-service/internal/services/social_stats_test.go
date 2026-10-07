package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeSocial imita la ruta de números del servicio social. Cada cuenta
// responde bien salvo que la prueba le asigne otro comportamiento.
type fakeSocial struct {
	t      *testing.T
	server *httptest.Server

	mu       sync.Mutex
	hits     map[uint64]int
	paths    []string
	auth     []string
	inFlight int
	maxSeen  int

	// behave decide la respuesta de una cuenta; nil o false deja la normal.
	behave func(id uint64, w http.ResponseWriter, r *http.Request) bool
	// delay retiene cada respuesta normal, para medir cuántas van a la vez.
	delay time.Duration
	// release suelta a los handlers colgados cuando la prueba termina.
	release chan struct{}
}

func newFakeSocial(t *testing.T) *fakeSocial {
	t.Helper()
	f := &fakeSocial{t: t, hits: map[uint64]int{}, release: make(chan struct{})}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(func() {
		close(f.release)
		f.server.Close()
	})
	return f
}

func (f *fakeSocial) handle(w http.ResponseWriter, r *http.Request) {
	// La ruta real: /api/v1/users/:id/stats, sin prefijo global.
	rest, ok := strings.CutPrefix(r.URL.Path, "/api/v1/users/")
	idText, isStats := strings.CutSuffix(rest, "/stats")
	id, err := strconv.ParseUint(idText, 10, 64)
	if !ok || !isStats || err != nil || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}

	f.mu.Lock()
	f.hits[id]++
	f.paths = append(f.paths, r.URL.Path)
	f.auth = append(f.auth, r.Header.Get("Authorization"))
	f.inFlight++
	if f.inFlight > f.maxSeen {
		f.maxSeen = f.inFlight
	}
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.inFlight--
		f.mu.Unlock()
	}()

	if f.behave != nil && f.behave(id, w, r) {
		return
	}
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	writeStats(w, int64(id)*2, int64(id), int64(id)*3)
}

// hang deja la petición sin respuesta hasta que la prueba acaba o el cliente
// se va.
func (f *fakeSocial) hang(r *http.Request) {
	select {
	case <-f.release:
	case <-r.Context().Done():
	}
}

func (f *fakeSocial) totalHits() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, h := range f.hits {
		n += h
	}
	return n
}

func writeStats(w http.ResponseWriter, followers, following, posts int64) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"data": map[string]int64{
			"followersCount": followers,
			"followingCount": following,
			"postsCount":     posts,
		},
		"error": nil,
	})
}

func idsUpTo(n int) []uint64 {
	ids := make([]uint64, n)
	for i := range ids {
		ids[i] = uint64(i + 1)
	}
	return ids
}

// countingTransport hace fallar la prueba si el cliente intenta salir a la red.
type countingTransport struct{ calls atomic.Int64 }

func (c *countingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	c.calls.Add(1)
	return nil, errors.New("no debía hacerse ninguna petición")
}

func TestSocialStatsLimitesPorDefecto(t *testing.T) {
	c := NewSocialStatsClient("http://social.example", nil)
	if c.concurrency != 8 {
		t.Fatalf("esperaba 8 a la vez, hay %d", c.concurrency)
	}
	if c.perRequest != 2*time.Second {
		t.Fatalf("esperaba 2 s por cuenta, hay %s", c.perRequest)
	}
	if c.deadline != 4*time.Second {
		t.Fatalf("esperaba 4 s por página, hay %s", c.deadline)
	}
}

func TestFetchStatsTodasResponden(t *testing.T) {
	f := newFakeSocial(t)
	c := NewSocialStatsClient(f.server.URL, nil)

	ids := idsUpTo(20)
	got := c.FetchStats(context.Background(), ids)

	if len(got) != len(ids) {
		t.Fatalf("esperaba %d cuentas, llegaron %d", len(ids), len(got))
	}
	for _, id := range ids {
		want := SocialStats{Followers: int64(id) * 2, Following: int64(id), Posts: int64(id) * 3}
		if got[id] != want {
			t.Fatalf("cuenta %d: esperaba %+v, llegó %+v", id, want, got[id])
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.paths) != len(ids) {
		t.Fatalf("esperaba %d peticiones, hubo %d", len(ids), len(f.paths))
	}
	for _, id := range ids {
		if f.hits[id] != 1 {
			t.Fatalf("la cuenta %d se pidió %d veces", id, f.hits[id])
		}
	}
	for _, a := range f.auth {
		if a != "" {
			t.Fatalf("sin token configurado no debe ir Authorization, fue %q", a)
		}
	}
}

func TestFetchStatsLlamaALaRutaExacta(t *testing.T) {
	f := newFakeSocial(t)
	// Una barra de más al final de la variable no puede romper la ruta.
	c := NewSocialStatsClient("  "+f.server.URL+"/  ", nil)

	got := c.FetchStats(context.Background(), []uint64{153})
	if got[153].Followers != 306 || got[153].Posts != 459 {
		t.Fatalf("cuenta 153 mal leída: %+v", got[153])
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.paths) != 1 || f.paths[0] != "/api/v1/users/153/stats" {
		t.Fatalf("ruta inesperada: %v", f.paths)
	}
}

func TestFetchStatsUnaDevuelve500(t *testing.T) {
	f := newFakeSocial(t)
	f.behave = func(id uint64, w http.ResponseWriter, _ *http.Request) bool {
		if id != 3 {
			return false
		}
		http.Error(w, `{"success":false,"error":"boom"}`, http.StatusInternalServerError)
		return true
	}
	c := NewSocialStatsClient(f.server.URL, nil)

	got := c.FetchStats(context.Background(), idsUpTo(6))

	if _, ok := got[3]; ok {
		t.Fatalf("la cuenta que dio 500 no debía estar: %+v", got[3])
	}
	if len(got) != 5 {
		t.Fatalf("las otras cinco debían llegar, llegaron %d", len(got))
	}
}

func TestFetchStatsUnaSeCuelgaYLasDemasLlegan(t *testing.T) {
	f := newFakeSocial(t)
	f.behave = func(id uint64, _ http.ResponseWriter, r *http.Request) bool {
		if id != 2 {
			return false
		}
		f.hang(r)
		return true
	}
	c := NewSocialStatsClient(f.server.URL, nil)
	c.perRequest = 150 * time.Millisecond
	c.deadline = 2 * time.Second

	start := time.Now()
	got := c.FetchStats(context.Background(), idsUpTo(10))
	took := time.Since(start)

	if _, ok := got[2]; ok {
		t.Fatal("la cuenta colgada no debía estar")
	}
	if len(got) != 9 {
		t.Fatalf("las otras nueve debían llegar, llegaron %d", len(got))
	}
	if took < c.perRequest {
		t.Fatalf("volvió en %s, antes de agotar la espera de la colgada", took)
	}
	if took >= c.deadline {
		t.Fatalf("tardó %s: una cuenta colgada no puede gastar el plazo de la página (%s)", took, c.deadline)
	}
}

func TestFetchStatsElPlazoDeLaPaginaManda(t *testing.T) {
	f := newFakeSocial(t)
	f.behave = func(_ uint64, _ http.ResponseWriter, r *http.Request) bool {
		f.hang(r)
		return true
	}
	c := NewSocialStatsClient(f.server.URL, nil)
	// 40 cuentas colgadas de 8 en 8 serían cinco tandas de 200 ms: un segundo.
	c.perRequest = 200 * time.Millisecond
	c.deadline = 300 * time.Millisecond

	start := time.Now()
	got := c.FetchStats(context.Background(), idsUpTo(40))
	took := time.Since(start)

	if len(got) != 0 {
		t.Fatalf("ninguna respondió, pero llegaron %d", len(got))
	}
	if took > 700*time.Millisecond {
		t.Fatalf("tardó %s con un plazo de página de %s", took, c.deadline)
	}
	if hits := f.totalHits(); hits >= 40 {
		t.Fatalf("vencido el plazo no se siguen pidiendo cuentas, se pidieron %d", hits)
	}
}

func TestFetchStatsListaVaciaNoPideNada(t *testing.T) {
	f := newFakeSocial(t)
	c := NewSocialStatsClient(f.server.URL, nil)
	signed := 0
	c.bearer = func() (string, error) { signed++; return "tok", nil }

	for _, ids := range [][]uint64{nil, {}} {
		if got := c.FetchStats(context.Background(), ids); got == nil || len(got) != 0 {
			t.Fatalf("esperaba un mapa vacío, llegó %v", got)
		}
	}
	if hits := f.totalHits(); hits != 0 {
		t.Fatalf("no debía haber peticiones, hubo %d", hits)
	}
	if signed != 0 {
		t.Fatalf("sin cuentas tampoco se firma un token, se firmaron %d", signed)
	}
}

func TestFetchStatsSinDireccionNoPideNada(t *testing.T) {
	for _, base := range []string{"", "   ", "/"} {
		c := NewSocialStatsClient(base, func() (string, error) {
			t.Fatal("sin dirección no se firma ningún token")
			return "", nil
		})
		tr := &countingTransport{}
		c.httpClient.Transport = tr

		if c.Enabled() {
			t.Fatalf("con la dirección %q el cliente debía quedar apagado", base)
		}
		got := c.FetchStats(context.Background(), idsUpTo(5))
		if got == nil || len(got) != 0 {
			t.Fatalf("esperaba un mapa vacío, llegó %v", got)
		}
		if n := tr.calls.Load(); n != 0 {
			t.Fatalf("no debía haber peticiones, hubo %d", n)
		}
	}

	// Un servicio sin cliente tampoco puede romperse.
	var none *SocialStatsClient
	if none.Enabled() {
		t.Fatal("un cliente nil está apagado")
	}
	if got := none.FetchStats(context.Background(), idsUpTo(3)); got == nil || len(got) != 0 {
		t.Fatalf("esperaba un mapa vacío, llegó %v", got)
	}
}

func TestFetchStatsSeSaltaLoIlegible(t *testing.T) {
	f := newFakeSocial(t)
	bodies := map[uint64]string{
		2: `{"success":true,"data":{"followersCount":`,                             // JSON cortado
		3: `<html>bad gateway</html>`,                                              // ni siquiera JSON
		4: `{"success":true,"data":{}}`,                                            // faltan los números
		5: `{"success":false,"data":null,"error":"nope"}`,                          // el servicio dice que no
		6: `{"success":true,"data":{"followersCount":"muchos","postsCount":1}}`,    // tipo equivocado
		7: `{"success":true,"data":{"followersCount":4}}`,                          // falta uno de los dos
		8: `{"success":true,"data":{"followersCount":-3,"postsCount":-1}}`,         // negativos: se dejan en cero
		9: `{"success":true,"data":{"followersCount":0,"postsCount":0},"error":0}`, // un cero de verdad sí vale
	}
	f.behave = func(id uint64, w http.ResponseWriter, _ *http.Request) bool {
		body, ok := bodies[id]
		if !ok {
			return false
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
		return true
	}
	c := NewSocialStatsClient(f.server.URL, nil)

	got := c.FetchStats(context.Background(), idsUpTo(10))

	for _, id := range []uint64{2, 3, 4, 5, 6, 7} {
		if st, ok := got[id]; ok {
			t.Fatalf("la cuenta %d respondió algo ilegible y no debía estar: %+v", id, st)
		}
	}
	for _, id := range []uint64{1, 10} {
		if _, ok := got[id]; !ok {
			t.Fatalf("la cuenta %d respondió bien y falta", id)
		}
	}
	if st, ok := got[8]; !ok || st != (SocialStats{}) {
		t.Fatalf("los negativos se dejan en cero: %+v (está: %t)", st, ok)
	}
	if st, ok := got[9]; !ok || st != (SocialStats{}) {
		t.Fatalf("un cero real es una respuesta válida: %+v (está: %t)", st, ok)
	}
}

func TestFetchStatsNuncaMasDeOchoALaVez(t *testing.T) {
	f := newFakeSocial(t)
	f.delay = 30 * time.Millisecond
	c := NewSocialStatsClient(f.server.URL, nil)

	got := c.FetchStats(context.Background(), idsUpTo(40))
	if len(got) != 40 {
		t.Fatalf("esperaba 40 cuentas, llegaron %d", len(got))
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.maxSeen > 8 {
		t.Fatalf("hubo %d peticiones a la vez, el tope es 8", f.maxSeen)
	}
	if f.maxSeen < 2 {
		t.Fatalf("las peticiones tenían que ir en paralelo, el máximo visto fue %d", f.maxSeen)
	}
}

func TestFetchStatsNoRepiteCuentas(t *testing.T) {
	f := newFakeSocial(t)
	c := NewSocialStatsClient(f.server.URL, nil)

	got := c.FetchStats(context.Background(), []uint64{7, 7, 9, 7, 9})
	if len(got) != 2 {
		t.Fatalf("esperaba 2 cuentas, llegaron %d", len(got))
	}
	if hits := f.totalHits(); hits != 2 {
		t.Fatalf("cada cuenta se pide una vez, hubo %d peticiones", hits)
	}
}

func TestFetchStatsRespetaLaCancelacionDeQuienLlama(t *testing.T) {
	f := newFakeSocial(t)
	f.behave = func(_ uint64, _ http.ResponseWriter, r *http.Request) bool {
		f.hang(r)
		return true
	}
	c := NewSocialStatsClient(f.server.URL, nil)

	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(80*time.Millisecond, cancel)

	start := time.Now()
	got := c.FetchStats(ctx, idsUpTo(20))
	took := time.Since(start)

	if len(got) != 0 {
		t.Fatalf("nadie respondió, pero llegaron %d", len(got))
	}
	if took > time.Second {
		t.Fatalf("tardó %s: la cancelación de quien llama no se respetó", took)
	}
}

// La ruta de números está detrás del guard del servicio social: sin un JWT
// válido contesta 401. El cliente manda el token y lo firma una vez por página.
func TestFetchStatsPresentaElTokenDeServicio(t *testing.T) {
	f := newFakeSocial(t)
	f.behave = func(_ uint64, w http.ResponseWriter, r *http.Request) bool {
		if r.Header.Get("Authorization") == "Bearer tok-de-servicio" {
			return false
		}
		http.Error(w, `{"success":false,"error":"Missing authentication"}`, http.StatusUnauthorized)
		return true
	}

	signed := 0
	conToken := NewSocialStatsClient(f.server.URL, func() (string, error) {
		signed++
		return "tok-de-servicio", nil
	})
	if got := conToken.FetchStats(context.Background(), idsUpTo(12)); len(got) != 12 {
		t.Fatalf("con token debían llegar las 12, llegaron %d", len(got))
	}
	if signed != 1 {
		t.Fatalf("un token por página, se firmaron %d", signed)
	}

	sinToken := NewSocialStatsClient(f.server.URL, nil)
	if got := sinToken.FetchStats(context.Background(), idsUpTo(12)); len(got) != 0 {
		t.Fatalf("sin token el guard rechaza todo, llegaron %d", len(got))
	}
}

func TestFetchStatsSiNoSePuedeFirmarNoPideNada(t *testing.T) {
	f := newFakeSocial(t)
	c := NewSocialStatsClient(f.server.URL, func() (string, error) {
		return "", errors.New("sin secreto")
	})

	if got := c.FetchStats(context.Background(), idsUpTo(4)); got == nil || len(got) != 0 {
		t.Fatalf("esperaba un mapa vacío, llegó %v", got)
	}
	if hits := f.totalHits(); hits != 0 {
		t.Fatalf("sin token no se pide nada, hubo %d peticiones", hits)
	}
}

func TestFetchStatsServicioCaidoNoRompe(t *testing.T) {
	// Un puerto donde no escucha nadie.
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()

	c := NewSocialStatsClient(url, nil)
	start := time.Now()
	got := c.FetchStats(context.Background(), idsUpTo(30))
	if len(got) != 0 {
		t.Fatalf("no hay servicio, pero llegaron %d", len(got))
	}
	if took := time.Since(start); took > c.deadline {
		t.Fatalf("tardó %s con el servicio caído", took)
	}
}

func TestResumenDeFallos(t *testing.T) {
	got := resumenDeFallos(map[string]int{"estado 401": 3, "plazo vencido": 1}, 6)
	want := "estado 401 x3, plazo vencido x1, sin turno antes del plazo x2"
	if got != want {
		t.Fatalf("resumen inesperado:\n got: %s\nwant: %s", got, want)
	}
}

// La mezcla con las filas de la lista.

func storedRows() []AdminUserRow {
	return []AdminUserRow{
		{ID: 153, Username: "con_posts", FollowersCount: 0, PostsCount: 0},
		{ID: 266, Username: "sin_respuesta", FollowersCount: 5, PostsCount: 7},
		{ID: 277, Username: "ceros_reales", FollowersCount: 9, PostsCount: 4},
	}
}

func TestApplyLiveStatsPisaSoloLasQueLlegaron(t *testing.T) {
	rows := storedRows()
	applyLiveStats(rows, map[uint64]SocialStats{
		153: {Followers: 17, Following: 3, Posts: 48},
		// Un cero real también pisa lo guardado: es el número de verdad.
		277: {Followers: 0, Following: 0, Posts: 0},
	})

	if r := rows[0]; r.FollowersCount != 17 || r.PostsCount != 48 || !r.StatsLive {
		t.Fatalf("153 debía quedar con los números reales: %+v", r)
	}
	if r := rows[1]; r.FollowersCount != 5 || r.PostsCount != 7 || r.StatsLive {
		t.Fatalf("266 no llegó: conserva lo guardado y statsLive false: %+v", r)
	}
	if r := rows[2]; r.FollowersCount != 0 || r.PostsCount != 0 || !r.StatsLive {
		t.Fatalf("277 llegó con ceros reales: %+v", r)
	}
	// Lo demás de la fila no se toca.
	if rows[0].Username != "con_posts" || rows[1].Username != "sin_respuesta" || rows[2].Username != "ceros_reales" {
		t.Fatalf("la mezcla cambió algo más que los números: %+v", rows)
	}
}

func TestApplyLiveStatsSinNumerosDejaTodoComoEstaba(t *testing.T) {
	for name, stats := range map[string]map[uint64]SocialStats{
		"nil":   nil,
		"vacío": {},
		"otras": {999: {Followers: 1, Posts: 1}},
	} {
		rows := storedRows()
		applyLiveStats(rows, stats)
		for i, want := range storedRows() {
			if rows[i] != want {
				t.Fatalf("%s: la fila %d cambió: %+v", name, rows[i].ID, rows[i])
			}
			if rows[i].StatsLive {
				t.Fatalf("%s: la fila %d no puede decir que es real", name, rows[i].ID)
			}
		}
	}
	applyLiveStats(nil, map[uint64]SocialStats{1: {}}) // sin filas tampoco rompe
}

// El panel lee followersCount y postsCount; statsLive es un campo de más.
func TestAdminUserRowLlevaStatsLiveEnElJSON(t *testing.T) {
	rows := storedRows()
	applyLiveStats(rows, map[uint64]SocialStats{153: {Followers: 17, Posts: 48}})

	raw, err := json.Marshal(rows[:2])
	if err != nil {
		t.Fatal(err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	want := []map[string]any{
		{"followersCount": float64(17), "postsCount": float64(48), "statsLive": true},
		{"followersCount": float64(5), "postsCount": float64(7), "statsLive": false},
	}
	for i, fields := range want {
		for key, value := range fields {
			got, ok := decoded[i][key]
			if !ok {
				t.Fatalf("fila %d: falta %s en %s", i, key, raw)
			}
			if got != value {
				t.Fatalf("fila %d: %s = %v, esperaba %v", i, key, got, value)
			}
		}
	}
	if fmt.Sprint(decoded[0]["id"]) != "153" || decoded[0]["username"] != "con_posts" {
		t.Fatalf("el resto de la fila tiene que seguir igual: %s", raw)
	}
}
