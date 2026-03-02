package services

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/atto-sound/user-service/internal/models"
	"golang.org/x/net/html"
)

// stateConfig maps a state code to its DOC lookup URL template.
type stateConfig struct {
	BaseURL    string
	QueryParam string
}

var supportedStates = map[string]stateConfig{
	"CT": {
		BaseURL:    "https://www.ctinmateinfo.state.ct.us/detailsupv.asp",
		QueryParam: "id_inmt_num",
	},
}

// InmateService handles inmate lookup against state DOC websites.
type InmateService struct {
	client *http.Client
}

// NewInmateService creates a new InmateService.
func NewInmateService() *InmateService {
	return &InmateService{
		client: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// LookupInmate fetches and parses inmate data from a state DOC website.
func (s *InmateService) LookupInmate(ctx context.Context, state, number string) (*models.InmateLookupResponse, error) {
	cfg, ok := supportedStates[strings.ToUpper(state)]
	if !ok {
		return nil, fmt.Errorf("state %q is not supported", state)
	}

	url := fmt.Sprintf("%s?%s=%s", cfg.BaseURL, cfg.QueryParam, number)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.5")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch inmate data: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	htmlStr := string(body)

	if strings.Contains(htmlStr, "Request Rejected") {
		return nil, fmt.Errorf("request blocked by DOC website")
	}

	if !strings.Contains(htmlStr, "Inmate Information") {
		return nil, fmt.Errorf("inmate not found")
	}

	return parseCTInmatePage(htmlStr)
}

// parseCTInmatePage extracts inmate data from the CT DOC HTML page.
func parseCTInmatePage(htmlStr string) (*models.InmateLookupResponse, error) {
	doc, err := html.Parse(strings.NewReader(htmlStr))
	if err != nil {
		return nil, fmt.Errorf("failed to parse HTML: %w", err)
	}

	// Extract all table rows as label→value pairs
	pairs := extractTablePairs(doc)
	if len(pairs) == 0 {
		return nil, fmt.Errorf("inmate not found")
	}

	result := &models.InmateLookupResponse{}
	for label, value := range pairs {
		switch label {
		case "Inmate Number:":
			result.InmateNumber = value
		case "Inmate Name:":
			result.InmateName = value
		case "Date of Birth:":
			result.DateOfBirth = value
		case "Latest Admission Date:":
			result.AdmissionDate = value
		case "Current Location:":
			result.CurrentLocation = value
		case "Status:":
			result.Status = value
		case "Controlling Offense*:":
			result.Offense = value
		case "Date of Sentence:":
			result.SentenceDate = value
		case "Maximum Sentence:":
			result.MaxSentence = value
		case "Maximum Release Date:":
			result.MaxReleaseDate = value
		case "Estimated Release Date:":
			result.EstReleaseDate = value
		}
	}

	if result.InmateNumber == "" && result.InmateName == "" {
		return nil, fmt.Errorf("inmate not found")
	}

	return result, nil
}

// extractTablePairs walks the HTML tree and extracts <tr> rows with exactly
// two <td> children, treating the first as a label and the second as a value.
func extractTablePairs(n *html.Node) map[string]string {
	pairs := make(map[string]string)
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Type == html.ElementNode && node.Data == "tr" {
			tds := collectDirectChildren(node, "td")
			if len(tds) == 2 {
				label := strings.TrimSpace(textContent(tds[0]))
				value := strings.TrimSpace(textContent(tds[1]))
				if label != "" {
					pairs[label] = value
				}
			}
		}
		for c := node.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return pairs
}

// collectDirectChildren returns direct child elements with the given tag name.
func collectDirectChildren(n *html.Node, tag string) []*html.Node {
	var children []*html.Node
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.Data == tag {
			children = append(children, c)
		}
	}
	return children
}

// textContent recursively extracts all text from a node.
func textContent(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var sb strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		sb.WriteString(textContent(c))
	}
	return sb.String()
}
