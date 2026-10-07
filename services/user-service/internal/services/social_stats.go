package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Límites de una consulta de números al servicio social. La lista de operador
// la sirve el mismo proceso que atiende el login de toda la app: una fila
// lenta no puede frenar la página y la página no puede colgar al proceso.
const (
	// Cuántas cuentas se preguntan a la vez.
	socialStatsConcurrency = 8
	// Lo que se espera a una sola cuenta.
	socialStatsPerRequest = 2 * time.Second
	// Lo que se espera a la página entera, por muchas filas que tenga.
	socialStatsDeadline = 4 * time.Second
	// Una respuesta de números cabe de sobra; lo demás no se lee.
	socialStatsMaxBody = 64 << 10
)

// SocialStats son los números de una cuenta tal como los calcula el servicio
// social, que es de donde los toma el perfil de la app.
type SocialStats struct {
	Followers int64
	Following int64
	Posts     int64
}

// SocialStatsClient pregunta al servicio social, de servicio a servicio por la
// red privada, los números reales de un grupo de cuentas.
//
// Las columnas users.followers_count y users.posts_count no las actualiza
// nadie, así que quien necesite la cifra de verdad tiene que pedirla aquí.
type SocialStatsClient struct {
	baseURL    string
	httpClient *http.Client
	// bearer devuelve el token con el que se presenta la llamada. La ruta de
	// números está detrás del guard del servicio social, que solo acepta un
	// JWT firmado con el secreto compartido. Nil manda la petición sin
	// credencial.
	bearer      func() (string, error)
	concurrency int
	perRequest  time.Duration
	deadline    time.Duration
}

// NewSocialStatsClient crea el cliente. Con baseURL vacío queda apagado: no
// hace ninguna petición y devuelve siempre un mapa vacío, de modo que el
// servicio arranca igual donde la variable no existe.
func NewSocialStatsClient(baseURL string, bearer func() (string, error)) *SocialStatsClient {
	var transport http.RoundTripper = http.DefaultTransport
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		propio := base.Clone()
		// El valor por defecto guarda dos conexiones por destino; con ocho
		// peticiones a la vez se abriría una nueva en casi todas.
		propio.MaxIdleConnsPerHost = socialStatsConcurrency
		transport = propio
	}

	return &SocialStatsClient{
		baseURL:     strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		httpClient:  &http.Client{Transport: transport},
		bearer:      bearer,
		concurrency: socialStatsConcurrency,
		perRequest:  socialStatsPerRequest,
		deadline:    socialStatsDeadline,
	}
}

// Enabled dice si hay un servicio social al que preguntar.
func (c *SocialStatsClient) Enabled() bool {
	return c != nil && c.baseURL != ""
}

// statsURL es la ruta que sirve el servicio social: su controlador declara
// api/v1/users y la app no añade prefijo global.
func (c *SocialStatsClient) statsURL(id uint64) string {
	return fmt.Sprintf("%s/api/v1/users/%d/stats", c.baseURL, id)
}

// FetchStats devuelve los números de las cuentas pedidas. Una cuenta que
// falla, tarda de más o responde algo ilegible simplemente no está en el
// mapa: nunca devuelve error y nunca tarda más que el plazo de la página.
func (c *SocialStatsClient) FetchStats(ctx context.Context, ids []uint64) map[uint64]SocialStats {
	out := make(map[uint64]SocialStats, len(ids))
	if !c.Enabled() || len(ids) == 0 {
		return out
	}
	if ctx == nil {
		ctx = context.Background()
	}

	// Un solo token para toda la página.
	token := ""
	if c.bearer != nil {
		t, err := c.bearer()
		if err != nil {
			log.Printf("[SOCIAL-STATS] no se pudo firmar el token de servicio: %v", err)
			return out
		}
		token = t
	}

	// El plazo cuelga de un contexto limpio y no del que llega. net/http
	// conserva los valores del contexto de la petición para una conexión que
	// se quedó a medio abrir y puede consultarlos cuando esta función ya
	// volvió, y el contexto de fasthttp se recicla en cuanto el handler
	// termina. La cancelación del que llega sí se respeta.
	padre := ctx
	ctx, cancel := context.WithTimeout(context.Background(), c.deadline)
	defer cancel()
	soltar := context.AfterFunc(padre, cancel)
	defer soltar()

	// Cada cuenta se pregunta una sola vez aunque venga repetida.
	cuentas := make([]uint64, 0, len(ids))
	vistas := make(map[uint64]struct{}, len(ids))
	for _, id := range ids {
		if _, repetida := vistas[id]; repetida {
			continue
		}
		vistas[id] = struct{}{}
		cuentas = append(cuentas, id)
	}

	var (
		mu     sync.Mutex
		wg     sync.WaitGroup
		sem    = make(chan struct{}, c.concurrency)
		fallos = make(map[string]int)
	)

reparto:
	for _, id := range cuentas {
		// Se espera turno o se acaba el plazo, lo que llegue antes: las
		// cuentas que no alcanzaron a salir se quedan sin número.
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			break reparto
		}

		wg.Add(1)
		go func(id uint64) {
			defer wg.Done()
			defer func() { <-sem }()

			stats, motivo := c.fetchOne(ctx, id, token)
			mu.Lock()
			defer mu.Unlock()
			if motivo != "" {
				fallos[motivo]++
				return
			}
			out[id] = stats
		}(id)
	}

	// Cada petición lleva el contexto con plazo, así que esta espera termina
	// como muy tarde cuando vence el plazo de la página.
	wg.Wait()

	// Una sola línea por página y no una por fila: con la variable mal puesta
	// o el secreto distinto fallan todas, y tiene que poder verse por qué.
	if sinNumero := len(cuentas) - len(out); sinNumero > 0 {
		log.Printf("[SOCIAL-STATS] %d de %d cuentas sin número real: %s",
			sinNumero, len(cuentas), resumenDeFallos(fallos, sinNumero))
	}
	return out
}

// resumenDeFallos cuenta los fallos por motivo. Las cuentas que no llegaron a
// salir porque venció el plazo de la página no tienen motivo propio.
func resumenDeFallos(fallos map[string]int, sinNumero int) string {
	motivos := make([]string, 0, len(fallos)+1)
	contados := 0
	for motivo, n := range fallos {
		motivos = append(motivos, fmt.Sprintf("%s x%d", motivo, n))
		contados += n
	}
	sort.Strings(motivos)
	if resto := sinNumero - contados; resto > 0 {
		motivos = append(motivos, fmt.Sprintf("sin turno antes del plazo x%d", resto))
	}
	return strings.Join(motivos, ", ")
}

// socialStatsBody es la respuesta de GET /api/v1/users/:id/stats. Los campos
// son punteros para distinguir un cero de verdad de un campo que no vino.
type socialStatsBody struct {
	Success bool `json:"success"`
	Data    *struct {
		FollowersCount *int64 `json:"followersCount"`
		FollowingCount *int64 `json:"followingCount"`
		PostsCount     *int64 `json:"postsCount"`
	} `json:"data"`
}

// fetchOne pide los números de una cuenta. Devuelve un motivo no vacío ante
// cualquier cosa que no sea una respuesta completa y correcta.
func (c *SocialStatsClient) fetchOne(ctx context.Context, id uint64, token string) (SocialStats, string) {
	ctx, cancel := context.WithTimeout(ctx, c.perRequest)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.statsURL(id), nil)
	if err != nil {
		return SocialStats{}, "dirección inválida"
	}
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return SocialStats{}, "plazo vencido"
		}
		return SocialStats{}, "sin conexión"
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Se vacía un poco del cuerpo para que la conexión se pueda reusar.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return SocialStats{}, fmt.Sprintf("estado %d", resp.StatusCode)
	}

	var body socialStatsBody
	if err := json.NewDecoder(io.LimitReader(resp.Body, socialStatsMaxBody)).Decode(&body); err != nil {
		if ctx.Err() != nil {
			return SocialStats{}, "plazo vencido"
		}
		return SocialStats{}, "respuesta ilegible"
	}
	// Un 200 sin los dos números que usa la lista no se da por bueno: leerlo
	// como cero sería volver a mostrar el cero falso, y además como real.
	if !body.Success || body.Data == nil ||
		body.Data.FollowersCount == nil || body.Data.PostsCount == nil {
		return SocialStats{}, "respuesta incompleta"
	}

	stats := SocialStats{
		Followers: noNegativo(*body.Data.FollowersCount),
		Posts:     noNegativo(*body.Data.PostsCount),
	}
	if body.Data.FollowingCount != nil {
		stats.Following = noNegativo(*body.Data.FollowingCount)
	}
	return stats, ""
}

// noNegativo mantiene el contrato del servicio social: un recuento nunca baja
// de cero.
func noNegativo(n int64) int64 {
	if n < 0 {
		return 0
	}
	return n
}
